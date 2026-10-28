#!/usr/bin/env bun
/**
 * Verifies automatic updates against real fixture installs: the immediate
 * startup check, the stale version state, the journal, checksum and npm
 * failures that leave the previous package running, and the reload restart.
 *
 * Fixture hosts and releases live under `.devboard/.tmp`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseDirectory } from "./harness-package";
import {
  assertEquals,
  assertTrue,
  copyRelease,
  dashboardsFor,
  installState,
  installedPackage,
  installedVersion,
  launcher,
  makeHost,
  makeRoot,
  processRunning,
  readJournal,
  readVersion,
  releaseDirectory,
  startInstalledDashboard,
  stopDashboard,
  toolPath,
  waitFor,
  waitForInstalledVersion,
  websocketCommand,
  type DashboardProcess,
} from "./verification";

const OLD = "0.1.910";
const NEW = "0.1.911";
const root = await makeRoot("verify-update");
const startedHosts: string[] = [];
const servers: DashboardProcess[] = [];

function step(message: string): void {
  console.log(`verify:update: ${message}`);
}

async function installFixture(name: string, releaseDir: string): Promise<string> {
  const host = await makeHost(root, name);
  const installed = launcher(["install", "--host", host.directory], {
    DEVBOARD_RELEASE_DIR: releaseDir,
  });
  assertTrue(installed.code === 0, `fixture install failed: ${installed.stderr}`);
  startedHosts.push(host.directory);
  return host.directory;
}

try {
  const oldRelease = releaseDirectory(root, OLD);
  const newRelease = releaseDirectory(root, NEW);
  await createReleaseDirectory(OLD, oldRelease);
  await createReleaseDirectory(NEW, newRelease);

  step("auto-installing a newer release on startup");
  const host = await installFixture("auto", oldRelease);
  const prefix = join(host, ".devboard");
  const previousPort = Number(installState(prefix).port);
  await stopDashboard(host);
  const server = await startInstalledDashboard(host, {
    DEVBOARD_RELEASE_DIR: newRelease,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  }, previousPort);
  servers.push(server);
  await waitForInstalledVersion(prefix, NEW);
  assertTrue(processRunning(server.pid), "the server survives its own install");
  // The install lands before the journal line, so wait for the record rather
  // than sampling once and racing the write.
  await waitFor(
    () =>
      readJournal(prefix, host).some((record) => record.kind === "update") ? true : undefined,
    "the update record in the host journal",
    15_000,
  );
  const auto = await readVersion(server.port);
  assertEquals(
    [auto.running, auto.installed, auto.latest, auto.stale],
    [OLD, NEW, NEW, true],
    "the stale version state after an automatic install",
  );
  assertTrue(
    readFileSync(`/proc/${server.pid}/cmdline`, "utf8").includes(installedPackage(prefix)),
    "the original process still serves the dashboard",
  );

  step("restarting from the installed package");
  const restarting = websocketCommand(server.port, { type: "restartServer" }, "serverRestarting");
  await restarting;
  await waitFor(
    () => {
      const current = dashboardsFor(host).find((entry) => entry.port === server.port);
      return current !== undefined && current.pid !== server.pid ? current : undefined;
    },
    "the replacement dashboard process",
  );
  const restarted = await waitFor(
    async () => {
      try {
        const state = await readVersion(server.port);
        return state.running === NEW ? state : undefined;
      } catch {
        return undefined;
      }
    },
    "the restarted server version state",
    30_000,
  );
  assertEquals(
    [restarted.running, restarted.installed, restarted.latest, restarted.stale],
    [NEW, NEW, NEW, false],
    "the replacement reports the installed release",
  );
  const replacement = dashboardsFor(host)[0];
  assertTrue(replacement !== undefined && replacement.pid !== server.pid, "the pid changed");

  step("checksum failures leave the previous package running");
  const corruptChecksum = join(root, "release-corrupt-checksum");
  await copyRelease(newRelease, corruptChecksum, "0.1.912", {
    checksum: `${"0".repeat(64)}  devboard-harness-0.1.912.tgz\n`,
  });
  const checksumHost = await installFixture("checksum", oldRelease);
  const checksumPrefix = join(checksumHost, ".devboard");
  await stopDashboard(checksumHost);
  const checksumServer = await startInstalledDashboard(checksumHost, {
    DEVBOARD_RELEASE_DIR: corruptChecksum,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  });
  servers.push(checksumServer);
  await waitFor(
    () => readJournal(checksumPrefix, checksumHost).find((record) => record.kind === "update-error"),
    "the checksum failure to be journaled",
  );
  assertEquals(installedVersion(checksumPrefix), OLD, "the checksum failure keeps the old package");
  assertTrue(processRunning(checksumServer.pid), "the checksum failure keeps the server running");
  const checksumState = await readVersion(checksumServer.port);
  assertEquals(
    [checksumState.running, checksumState.installed, checksumState.stale],
    [OLD, OLD, false],
    "the version state still names the intact install",
  );
  const checksumDoctor = launcher(["doctor", "--host", checksumHost], {
    DEVBOARD_RELEASE_DIR: corruptChecksum,
  });
  assertTrue(checksumDoctor.code !== 0, "doctor fails after a recorded update failure");
  assertTrue(
    checksumDoctor.stdout.split("\n").some((line) => line.startsWith("FAIL updates")),
    `doctor should report the update failure:\n${checksumDoctor.stdout}`,
  );

  step("a missing asset leaves the previous package running");
  const missingAsset = join(root, "release-missing-asset");
  await copyRelease(newRelease, missingAsset, "0.1.913", { omitChecksum: true });
  const assetHost = await installFixture("asset", oldRelease);
  const assetPrefix = join(assetHost, ".devboard");
  await stopDashboard(assetHost);
  const assetServer = await startInstalledDashboard(assetHost, {
    DEVBOARD_RELEASE_DIR: missingAsset,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  });
  servers.push(assetServer);
  await waitFor(
    () => readJournal(assetPrefix, assetHost).find((record) => record.kind === "update-error"),
    "the missing-asset failure to be journaled",
  );
  assertEquals(installedVersion(assetPrefix), OLD, "the missing asset keeps the old package");
  assertTrue(processRunning(assetServer.pid), "the missing asset keeps the server running");

  step("a failed npm install leaves the previous package running");
  const broken = join(root, "release-broken-tarball");
  await mkdir(broken, { recursive: true });
  const brokenBytes = Buffer.from("this is not a package tarball\n");
  const brokenTarball = join(broken, "devboard-harness-0.1.914.tgz");
  await writeFile(brokenTarball, brokenBytes);
  await writeFile(
    `${brokenTarball}.sha256`,
    `${createHash("sha256").update(brokenBytes).digest("hex")}  devboard-harness-0.1.914.tgz\n`,
  );
  const brokenHost = await installFixture("broken", oldRelease);
  const brokenPrefix = join(brokenHost, ".devboard");
  await stopDashboard(brokenHost);
  const brokenServer = await startInstalledDashboard(brokenHost, {
    DEVBOARD_RELEASE_DIR: broken,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  });
  servers.push(brokenServer);
  await waitFor(
    () => readJournal(brokenPrefix, brokenHost).find((record) => record.kind === "update-error"),
    "the failed npm install to be journaled",
  );
  assertEquals(installedVersion(brokenPrefix), OLD, "the failed install keeps the old package");
  assertTrue(processRunning(brokenServer.pid), "the failed install keeps the server running");

  step("authenticated release access is required");
  const unauthenticated = await toolPath(root, { gh: "echo 'not logged in' >&2; exit 1" });
  const ghHost = await installFixture("gh", oldRelease);
  const ghPrefix = join(ghHost, ".devboard");
  await stopDashboard(ghHost);
  const ghServer = await startInstalledDashboard(ghHost, {
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
    PATH: unauthenticated,
  });
  servers.push(ghServer);
  await waitFor(
    () => readJournal(ghPrefix, ghHost).find((record) => record.kind === "update-error"),
    "the unauthenticated release check to be journaled",
  );
  assertEquals(installedVersion(ghPrefix), OLD, "the failed release check keeps the old package");
  assertTrue(processRunning(ghServer.pid), "the failed release check keeps the server running");

  step("an unreadable release description is context, never an update-error");
  // Two JSON objects instead of one release: the shape a newest-first listing
  // or a stray tool wrapper prints. The check skips it and backs off.
  const unreadable = await toolPath(root, {
    gh: `printf '%s\\n' '{"tag":"v1.0.0"}' '{"tag":"v1.1.0"}'`,
  });
  const unreadableHost = await installFixture("unreadable", oldRelease);
  const unreadablePrefix = join(unreadableHost, ".devboard");
  await stopDashboard(unreadableHost);
  const unreadableServer = await startInstalledDashboard(unreadableHost, {
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
    PATH: unreadable,
  });
  servers.push(unreadableServer);
  await waitFor(
    () =>
      readJournal(unreadablePrefix, unreadableHost).some(
        (record) =>
          record.kind === "activity" &&
          record.text.startsWith(
            "release check skipped: gh returned an unreadable release description",
          ),
      )
        ? true
        : undefined,
    "the unreadable release description to be journaled as context",
  );
  assertTrue(
    readJournal(unreadablePrefix, unreadableHost).every((record) => record.kind !== "update-error"),
    "an unreadable release description is never an update-error",
  );
  assertEquals(
    installedVersion(unreadablePrefix),
    OLD,
    "the skipped check keeps the old package",
  );
  assertTrue(processRunning(unreadableServer.pid), "the skipped check keeps the server running");

  console.log("verify:update: all checks passed");
} finally {
  for (const server of servers) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (const host of startedHosts) await stopDashboard(host).catch(() => undefined);
}

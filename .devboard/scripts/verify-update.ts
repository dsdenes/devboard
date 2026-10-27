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
  // The package version changes inside the install; the journal record lands
  // right after it, so wait for both instead of racing the write.
  const updateRecords = await waitFor(
    () => {
      const records = readJournal(prefix, host).filter((record) => record.kind === "update");
      return records.length > 0 ? records : undefined;
    },
    "the update journal record",
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

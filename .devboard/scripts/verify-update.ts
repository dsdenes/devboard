#!/usr/bin/env bun
/**
 * Verifies automatic updates against real fixture installs: the immediate
 * startup check, the stale version state, the journal, checksum and npm
 * failures that leave the previous package running, and the reload restart.
 *
 * Fixture hosts and releases live under `.devboard/.tmp`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseDirectory } from "./harness-package";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import { saveSubscriptions } from "../server/providers";
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
  treesMatch,
  waitFor,
  waitForInstalledVersion,
  websocketCommand,
  declaredMcpTools,
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

/** One `issues-draft-state` payload, narrowed at the websocket boundary. */
function draftRun(reply: Record<string, unknown>): Record<string, unknown> | undefined {
  const draft = reply.draft;
  return typeof draft === "object" && draft !== null ? (draft as Record<string, unknown>) : undefined;
}

async function readDraftRun(port: number, path: string): Promise<Record<string, unknown>> {
  const reply = await websocketCommand(port, { type: "getGoalDrafts" }, "issuesDrafts");
  const runs = Array.isArray(reply.runs) ? reply.runs : [];
  const run = runs.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).path === path,
  );
  assertTrue(run !== undefined, "the dashboard returned no draft run");
  return run;
}

/** Sends one command without waiting for its state broadcast. */
async function sendDraftCommand(port: number, command: unknown): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const timer = setTimeout(resolve, 5_000);
  socket.onopen = () => {
    clearTimeout(timer);
    socket.send(JSON.stringify(command));
    socket.close();
    resolve();
  };
  socket.onerror = () => {
    clearTimeout(timer);
    resolve();
  };
  return promise;
}

function agentLines(log: string): string[] {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The detached elaboration owners this checkout currently runs, by their argv. */
function ownerPids(host: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.some((argument) => argument.endsWith("goal-draft-owner.ts"))) continue;
    if (!argv.includes(host)) continue;
    found.push(pid);
  }
  return found;
}

/** The skill directories every install and update writes into the host. */
const MANAGED_SKILLS = [
  "devboard-ui-ux",
  "devboard-restful-api-implementation",
  "devboard-single-responsibility-principle",
] as const;

let failingNpm = "";

async function installFixture(name: string, releaseDir: string): Promise<string> {
  const host = await makeHost(root, name);
  const installed = launcher(["install", "--host", host.directory], {
    DEVBOARD_RELEASE_DIR: releaseDir,
    DEVBOARD_NPM: failingNpm,
  });
  assertTrue(installed.code === 0, `fixture install failed: ${installed.stderr}`);
  const fallbackLine = installed.stdout
    .split("\n")
    .find((line) => line.includes("used release tarball"));
  assertTrue(
    fallbackLine !== undefined,
    `fixture install did not report the tarball fallback after npm failed:\n${installed.stdout}`,
  );
  step(fallbackLine ?? "tarball fallback used");
  await assertInstalledMcp(host.directory);
  await assertInstalledSkills(host.directory);
  startedHosts.push(host.directory);
  return host.directory;
}

async function assertInstalledSkills(host: string): Promise<void> {
  const harness = installedPackage(join(host, ".devboard"));
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(join(harness, "omp", "skills", name), join(host, ".omp", "skills", name)),
      `the installed .omp/skills/${name} differs from the package`,
    );
  }
}

async function assertInstalledMcp(host: string): Promise<void> {
  const prefix = join(host, ".devboard");
  const harness = installedPackage(prefix);
  const installedMcp = join(host, ".omp", "mcp.json");
  assertTrue(readFileSync(installedMcp).equals(readFileSync(join(harness, "omp", "mcp.json"))), "the installed .omp/mcp.json differs from the package");
  assertEquals(
    await declaredMcpTools(host, prefix),
    [...MCP_TOOL_NAMES],
    "the installed MCP server answers tools/list",
  );
}

try {
  const oldRelease = releaseDirectory(root, OLD);
  const newRelease = releaseDirectory(root, NEW);
  await createReleaseDirectory(OLD, oldRelease);
  await createReleaseDirectory(NEW, newRelease);
  failingNpm = join(root, "failing-npm");
  await writeFile(failingNpm, "#!/bin/sh\ncase \"$1\" in view) echo 'simulated npm outage' >&2; exit 1;; esac\nexec npm \"$@\"\n");
  await chmod(failingNpm, 0o755);

  step("auto-installing a newer release on startup");
  const host = await installFixture("auto", oldRelease);
  const prefix = join(host, ".devboard");
  const previousPort = Number(installState(prefix).port);
  // The automatic path is package-owned too: it restores a tampered managed
  // skill and leaves an unmarked host skill byte-identical.
  const skills = join(host, ".omp", "skills");
  await writeFile(join(skills, "devboard-ui-ux", "SKILL.md"), "tampered\n");
  const hostSkill = join(skills, "house-style");
  await mkdir(hostSkill, { recursive: true });
  await writeFile(
    join(hostSkill, "SKILL.md"),
    "---\nname: house-style\ndescription: host owned\n---\n",
  );
  await stopDashboard(host);
  const server = await startInstalledDashboard(host, {
    DEVBOARD_RELEASE_DIR: newRelease,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  }, previousPort);
  servers.push(server);
  // A connected page learns that the replacement is coming before the socket
  // closes; the same event makes every browser reload once.
  const restarting = websocketCommand(server.port, { type: "getVersion" }, "serverRestarting", 30_000);
  await waitForInstalledVersion(prefix, NEW);
  await assertInstalledMcp(host);
  // The package lands before the host copies are synced; wait for the skill
  // tree instead of reading the window between the two writes.
  await waitFor(
    () => {
      try {
        const harness = installedPackage(join(host, ".devboard"));
        return MANAGED_SKILLS.every((name) =>
          treesMatch(join(harness, "omp", "skills", name), join(host, ".omp", "skills", name)),
        )
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    },
    "the automatic update to sync the package skills",
    30_000,
  );
  await assertInstalledSkills(host);
  assertTrue(
    readFileSync(join(hostSkill, "SKILL.md"), "utf8").includes("name: house-style"),
    "the automatic path leaves an unmarked host skill untouched",
  );
  await restarting;
  step(`automatic install wrote and restored ${MANAGED_SKILLS.join(", ")}`);
  step("the connected page received serverRestarting and reloads once");
  const replaced = await waitFor(
    () => {
      const current = dashboardsFor(host).find((entry) => entry.port === server.port);
      return current !== undefined && current.pid !== server.pid ? current : undefined;
    },
    "the automatic replacement dashboard process",
    30_000,
  );
  assertTrue(replaced.pid !== server.pid, "the automatic replacement changed the pid");
  await waitFor(
    () => (!processRunning(server.pid) ? true : undefined),
    "the previous server process to exit",
    15_000,
  );
  const auto = await waitFor(
    async () => {
      try {
        const state = await readVersion(server.port);
        return state.running === NEW && state.stale === false ? state : undefined;
      } catch {
        return undefined;
      }
    },
    "the automatic replacement version state",
    30_000,
  );
  assertEquals(
    [auto.running, auto.installed, auto.stale],
    [NEW, NEW, false],
    "the replacement runs and reports the installed release",
  );
  assertTrue(auto.replacement === undefined, "the normal path carries no replacement failure");
  await waitFor(
    () =>
      readJournal(prefix, host).some(
        (record) => record.kind === "update" && record.text.includes("replacing"),
      )
        ? true
        : undefined,
    "the replacement record in the host journal",
    15_000,
  );
  step(`automatic replacement ${OLD} -> ${NEW}: running and installed both ${NEW}, stale false`);
  const replacement = dashboardsFor(host)[0];
  assertTrue(replacement !== undefined, "the replacement dashboard is discoverable");

  step("a stubbed replacement failure keeps the old server serving");
  const fallbackHost = await installFixture("fallback", oldRelease);
  const fallbackPrefix = join(fallbackHost, ".devboard");
  const fallbackPort = Number(installState(fallbackPrefix).port);
  await stopDashboard(fallbackHost);
  const stub = join(root, "replacement-stub");
  await writeFile(stub, "fail\n");
  const fallback = await startInstalledDashboard(fallbackHost, {
    DEVBOARD_RELEASE_DIR: newRelease,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
    DEVBOARD_REPLACEMENT_STUB: stub,
  }, fallbackPort);
  servers.push(fallback);
  await waitForInstalledVersion(fallbackPrefix, NEW);
  const failed = await waitFor(
    async () => {
      try {
        const state = await readVersion(fallback.port);
        return state.replacement !== undefined ? state : undefined;
      } catch {
        return undefined;
      }
    },
    "the replacement failure in versionState",
    30_000,
  );
  assertEquals(
    [failed.running, failed.installed, failed.stale],
    [OLD, NEW, true],
    "the failed replacement keeps the old version running",
  );
  assertEquals(
    [failed.replacement?.running, failed.replacement?.installed],
    [OLD, NEW],
    "the fallback control names both versions",
  );
  assertTrue(processRunning(fallback.pid), "the old server keeps serving after a failed replacement");
  await waitFor(
    () =>
      readJournal(fallbackPrefix, fallbackHost).some(
        (record) => record.kind === "update-error" && record.text.includes("stubbed"),
      )
        ? true
        : undefined,
    "the replacement failure in the host journal",
    15_000,
  );
  step("the fallback control retries and reaches the installed release");
  await writeFile(stub, "ok\n");
  const retry = websocketCommand(fallback.port, { type: "restartServer" }, "serverRestarting", 30_000);
  await retry;
  await waitFor(
    () => {
      const current = dashboardsFor(fallbackHost).find((entry) => entry.port === fallback.port);
      return current !== undefined && current.pid !== fallback.pid ? current : undefined;
    },
    "the retried replacement dashboard process",
    30_000,
  );
  const retried = await waitFor(
    async () => {
      try {
        const state = await readVersion(fallback.port);
        return state.running === NEW && state.stale === false ? state : undefined;
      } catch {
        return undefined;
      }
    },
    "the retried replacement version state",
    30_000,
  );
  assertEquals(
    [retried.running, retried.installed, retried.stale],
    [NEW, NEW, false],
    "the retried replacement runs the installed release",
  );

  step("a running draft elaboration survives the reload");
  const draftPath = ".devboard/goal-proposals/reload-draft.md";
  await mkdir(join(prefix, "goal-proposals"), { recursive: true });
  await writeFile(
    join(prefix, "goal-proposals", "reload-draft.md"),
    "# Reload draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep the elaboration running.\n",
  );
  // Every peer resolves a provider first. The seeded key's usage endpoints
  // are closed ports, so it stays eligible with unknown headroom offline.
  const draftStamp = new Date().toISOString();
  saveSubscriptions(join(prefix, ".tmp"), [
    {
      id: "verify-draft-go",
      provider: "opencode-go",
      label: "Draft fixture",
      key: "fixture-key",
      enabled: true,
      createdAt: draftStamp,
      updatedAt: draftStamp,
    },
  ]);
  const draftLog = join(root, "draft-agent.log");
  await stopDashboard(host);
  const draftServer = await startInstalledDashboard(
    host,
    {
      DEVBOARD_RELEASE_DIR: newRelease,
      DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
      DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: "http://127.0.0.1:1/zen/go",
      DEVBOARD_OPENROUTER_USAGE_BASE_URL: "http://127.0.0.1:1/api",
      AGENT_COMMAND:
        `bun ${join(installedPackage(prefix), "server", "fixtures", "stub-agent.ts")} ` +
        `--log=${draftLog} --goal-draft`,
    },
    server.port,
  );
  servers.push(draftServer);
  await waitFor(
    async () => ((await readVersion(draftServer.port)).running === NEW ? true : undefined),
    "the drafting dashboard version",
  );
  const started = await websocketCommand(
    draftServer.port,
    { type: "startGoalDraft", path: draftPath },
    "issuesDraftState",
  );
  assertEquals(draftRun(started)?.status, "running", "the draft elaboration did not start");
  const peerLine = await waitFor(
    () => agentLines(draftLog).find((line) => line.startsWith("goal-draft-start ")),
    "the stub peer's start line",
  );
  const peerPid = Number(peerLine.slice("goal-draft-start ".length));
  assertTrue(peerPid > 0 && processRunning(peerPid), "the stub peer is not running");
  await waitFor(
    async () => {
      const run = await readDraftRun(draftServer.port, draftPath);
      return run.status === "running" && Array.isArray(run.activity) && run.activity.length > 0
        ? true
        : undefined;
    },
    "the streamed draft activity",
  );

  const beforeReload = dashboardsFor(host).find((entry) => entry.port === draftServer.port);
  const previousPid = beforeReload?.pid;
  assertTrue(previousPid !== undefined, "the drafting dashboard process");
  await websocketCommand(draftServer.port, { type: "restartServer" }, "serverRestarting");
  await waitFor(
    () => {
      const current = dashboardsFor(host).find((entry) => entry.port === draftServer.port);
      return current !== undefined && current.pid !== previousPid ? current : undefined;
    },
    "the draft reload replacement",
    30_000,
  );
  await waitFor(
    async () => {
      try {
        const state = await readVersion(draftServer.port);
        return state.running === NEW ? state : undefined;
      } catch {
        return undefined;
      }
    },
    "the replacement version after the draft reload",
    30_000,
  );
  const adopted = await readDraftRun(draftServer.port, draftPath);
  assertEquals(
    [adopted.status, adopted.path],
    ["running", draftPath],
    "the replacement did not adopt the running draft",
  );
  assertTrue(processRunning(peerPid), "the original elaboration peer did not survive the reload");
  assertEquals(
    agentLines(draftLog).filter((line) => line.startsWith("goal-draft-start ")).length,
    1,
    "the reload started a second elaboration peer",
  );
  assertEquals(
    agentLines(draftLog).filter((line) => line === `goal-draft ${draftPath}`),
    [`goal-draft ${draftPath}`],
    "the reload sent the prompt again",
  );
  assertTrue(ownerPids(host).length === 1, "the elaboration has no owner process");

  await sendDraftCommand(draftServer.port, { type: "stopGoalDraft", path: draftPath });
  const stopped = await waitFor(
    async () => {
      const run = await readDraftRun(draftServer.port, draftPath);
      return run.status === "stopped" ? run : undefined;
    },
    "the stopped draft elaboration",
  );
  assertEquals(stopped.path, draftPath, "Stop lost the draft's path");
  await waitFor(
    () => (processRunning(peerPid) ? undefined : true),
    "the stopped elaboration peer to exit",
    10_000,
  );
  await waitFor(
    () => (ownerPids(host).length === 0 ? true : undefined),
    "the stopped elaboration owner to exit",
    10_000,
  );

  step("checksum failures leave the previous package running");
  const corruptChecksum = join(root, "release-corrupt-checksum");
  await copyRelease(newRelease, corruptChecksum, "0.1.912", {
    checksum: `${"0".repeat(64)}  devboard-0.1.912.tgz\n`,
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
  const brokenTarball = join(broken, "devboard-0.1.914.tgz");
  await writeFile(brokenTarball, brokenBytes);
  await writeFile(
    `${brokenTarball}.sha256`,
    `${createHash("sha256").update(brokenBytes).digest("hex")}  devboard-0.1.914.tgz\n`,
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

  step("an HTTP error from the release feed is an update-error");
  const unauthorized = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ message: "token required" }), { status: 401 });
    },
  });
  const unauthorizedHost = await installFixture("feed-error", oldRelease);
  const unauthorizedPrefix = join(unauthorizedHost, ".devboard");
  await stopDashboard(unauthorizedHost);
  const unauthorizedServer = await startInstalledDashboard(unauthorizedHost, {
    DEVBOARD_RELEASE_URL: `http://127.0.0.1:${unauthorized.port}`,
    // An ambient harness origin must not outrank the fixture's feed.
    DEVBOARD_GITEA_URL: "",
    GITEA_TOKEN: "",
    DEVBOARD_GITEA_TOKEN: "",
    DEVBOARD_NPM: failingNpm,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  });
  servers.push(unauthorizedServer);
  await waitFor(
    () =>
      readJournal(unauthorizedPrefix, unauthorizedHost).find(
        (record) => record.kind === "update-error",
      ),
    "the refused feed to be journaled",
  );
  assertEquals(installedVersion(unauthorizedPrefix), OLD, "the refused feed keeps the old package");
  assertTrue(processRunning(unauthorizedServer.pid), "the refused feed keeps the server running");
  unauthorized.stop(true);

  step("an unreadable release description is journaled with its reason");
  const unreadableFeed = Bun.serve({
    port: 0,
    fetch() {
      return new Response('{"tag":"v1.0.0"}\n{"tag":"v1.1.0"}\n');
    },
  });
  const unreadableHost = await installFixture("unreadable", oldRelease);
  const unreadablePrefix = join(unreadableHost, ".devboard");
  await stopDashboard(unreadableHost);
  const unreadableServer = await startInstalledDashboard(unreadableHost, {
    DEVBOARD_RELEASE_URL: `http://127.0.0.1:${unreadableFeed.port}`,
    DEVBOARD_GITEA_URL: "",
    GITEA_TOKEN: "",
    DEVBOARD_GITEA_TOKEN: "",
    DEVBOARD_NPM: failingNpm,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  });
  servers.push(unreadableServer);
  const unreadableRecord = await waitFor(
    () =>
      readJournal(unreadablePrefix, unreadableHost).find(
        (record) =>
          (record.kind === "update-error" || record.kind === "activity") &&
          String(record.text).includes("invalid JSON"),
      ),
    "the unreadable release description to be journaled with its reason",
  );
  assertTrue(
    String(unreadableRecord?.text).includes("invalid JSON"),
    "the unreadable release description does not name its reason",
  );
  assertEquals(
    installedVersion(unreadablePrefix),
    OLD,
    "the skipped check keeps the old package",
  );
  assertTrue(processRunning(unreadableServer.pid), "the skipped check keeps the server running");
  unreadableFeed.stop(true);

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

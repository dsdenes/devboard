#!/usr/bin/env bun
/**
 * Verifies the publish-only source refresh against real source dashboards.
 *
 * A throwaway source checkout runs twice, on two ports, from a copied harness
 * tree. The script delivers a request through the same writer `publish.ts`
 * uses, and proves the replacement, the built-bundle digest check, the
 * applied-request dedupe, the two-dashboard delivery, the survival of a live
 * detached goal draft, the invalid, missing, failed-spawn, and never-ready
 * paths, and the fixed retry interval. It never runs a release and never runs
 * `bun run publish`.
 *
 * Every fixture lives under `.devboard/.tmp`.
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Instance } from "../watchdog/discovery";
import { saveSubscriptions } from "../server/providers";
import {
  deliverSourceRefresh,
  distDigest,
  sourceRefreshIntervalMs,
  writeSourceRefreshRequest,
} from "../lib/source-refresh";
import { devboardStatus } from "../mcp/status";
import {
  assertEquals,
  assertTrue,
  dashboardsFor,
  freePort,
  harnessRoot,
  httpStatus,
  journalKey,
  makeRoot,
  processRunning,
  readEnviron,
  readVersion,
  run,
  stopPid,
  waitFor,
  websocketCommand,
  type DashboardProcess,
  type VersionState,
} from "./verification";

const VERSION_ONE = "0.9.0";
const VERSION_TWO = "0.9.1";
const VERSION_THREE = "0.9.2";
const VERSION_FOUR = "0.9.3";
const INTERVAL_MS = 1_000;
const root = await makeRoot("verify-source-refresh");
let checkout = "";
let scratchHarness = "";

function step(message: string): void {
  console.log(`verify:source-refresh: ${message}`);
}

function git(args: string[]): string {
  const result = run("git", ["-C", checkout, ...args]);
  assertTrue(result.code === 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function writeAt(directory: string, relative: string, text: string): Promise<void> {
  const path = join(directory, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** The source dashboard's own environment, shared by both fixture ports. */
function dashboardEnv(log: string, finishFile: string, stub: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    REPO_DIR: checkout,
    ADRS_DIR: join(checkout, "adrs"),
    GOAL_FILE: join(checkout, "GOAL.md"),
    STATIC_DIR: join(scratchHarness, "dist"),
    AGENT_COMMAND:
      `bun ${join(harnessRoot, "server", "fixtures", "stub-agent.ts")} ` +
      `--log=${log} --goal-draft --goal-draft-finish=${finishFile}`,
    DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: String(INTERVAL_MS),
    DEVBOARD_REPLACEMENT_STUB: stub,
    // A fixture outside a host's `.devboard/.tmp` is still a dashboard this
    // check must see; discovery otherwise hides verification scratch.
    DEVBOARD_WATCHDOG_FIXTURE: "1",
    DEVBOARD_RELEASE_DIR: join(root, "empty-release"),
    DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: "http://127.0.0.1:1/zen/go",
    DEVBOARD_OPENROUTER_USAGE_BASE_URL: "http://127.0.0.1:1/api",
    DEVBOARD_GITEA_URL: "",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

async function startSourceDashboard(
  stateDir: string,
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<DashboardProcess> {
  await mkdir(stateDir, { recursive: true });
  const log = join(root, `dashboard-${port}.log`);
  const out = openSync(log, "a");
  const child = spawn("bun", [join(scratchHarness, "server", "index.ts")], {
    cwd: scratchHarness,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...env, PORT: String(port), STATE_DIR: stateDir },
  });
  closeSync(out);
  child.unref();
  const process: DashboardProcess = { pid: child.pid ?? 0, port, log };
  await waitFor(
    () => (httpStatus(port) === 200 ? true : undefined),
    `the source dashboard on port ${port}`,
    30_000,
  );
  return process;
}

/** The live instances the publish writer would see for this checkout. */
function liveInstances(): Instance[] {
  return dashboardsFor(checkout).map((entry) => {
    const env = readEnviron(entry.pid);
    const stateDir = env.STATE_DIR ?? join(scratchHarness, ".tmp");
    return {
      pid: entry.pid,
      port: entry.port,
      repoDir: checkout,
      host: "127.0.0.1",
      harness: scratchHarness,
      stateDir,
      journal: join(stateDir, "journal", `${journalKey(checkout)}.jsonl`),
      instrumented: true,
    };
  });
}

function journalRecords(stateDir: string): Array<{ kind: string; text: string }> {
  const path = join(stateDir, "journal", `${journalKey(checkout)}.jsonl`);
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as { kind?: unknown; text?: unknown };
          return typeof record.kind === "string" && typeof record.text === "string"
            ? [{ kind: record.kind, text: record.text }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function ownerPids(): number[] {
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
    if (!argv.includes(checkout)) continue;
    found.push(pid);
  }
  return found;
}

function agentLines(log: string): string[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Resolves on the first `serverRestarting` frame the page would receive. */
function watchRestart(port: number, timeoutMs = 30_000): Promise<void> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<void>();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error("the connected page never received serverRestarting"));
  }, timeoutMs);
  socket.onerror = () => {
    clearTimeout(timer);
    reject(new Error("the connected page could not reach the dashboard"));
  };
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type !== "serverRestarting") return;
    clearTimeout(timer);
    socket.close();
    settle();
  };
  return promise;
}

async function waitServing(port: number, pid: number, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () =>
      processRunning(pid) && httpStatus(port) === 200
        ? liveInstances().find((entry) => entry.port === port && entry.pid === pid)
        : undefined,
    `the replacement dashboard on port ${port}`,
    timeoutMs,
  );
}

function currentPid(port: number): number | undefined {
  const entries = liveInstances().filter((entry) => entry.port === port);
  return entries.length === 1 ? entries[0]?.pid : undefined;
}

/**
 * The one replacement process that took the port after `previous` exited.
 * A spawned child is discoverable before it binds, so both processes exist
 * for a moment; only the settled single listener is a replacement.
 */
async function waitReplacement(port: number, previous: number): Promise<number> {
  return await waitFor(
    () => {
      const entries = liveInstances().filter((entry) => entry.port === port);
      const replacement = entries.find((entry) => entry.pid !== previous);
      if (entries.length !== 1 || replacement === undefined) return undefined;
      return httpStatus(port) === 200 ? replacement.pid : undefined;
    },
    `the replacement dashboard on port ${port}`,
    30_000,
  );
}

async function versionOf(port: number): Promise<VersionState> {
  return await readVersion(port);
}

/** One scratch source checkout whose `.devboard` is a source harness copy. */
async function prepareCheckout(): Promise<void> {
  checkout = join(root, "checkout");
  scratchHarness = join(checkout, ".devboard");
  await mkdir(join(checkout, "adrs"), { recursive: true });
  await writeAt(checkout, "GOAL.md", "# Fixture goal\n");
  await writeAt(checkout, "adrs/0001-fixture.md", "---\nid: \"1\"\ntitle: Fixture\nstatus: accepted\n---\n\n# Fixture\n");
  await writeAt(checkout, ".gitignore", "node_modules/\n");
  // The dashboard needs the server and every module its startup imports; the
  // client sources are not run by a server, and the bundle comes from dist.
  for (const entry of ["server", "lib", "issues", "coach", "watchdog", "mcp", "release-train", "prompts", "templates", "omp", "extensions"]) {
    await cp(join(harnessRoot, entry), join(scratchHarness, entry), {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
  }
  await writeFile(
    join(scratchHarness, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0", type: "module" }, null, 2)}\n`,
  );
  // Runtime dependencies resolve through the checkout's installed packages;
  // the npm package itself is absent, which is what makes this a source tree.
  await symlink(join(harnessRoot, "node_modules"), join(scratchHarness, "node_modules"));
  const built = run("bun", ["run", "build"], { cwd: harnessRoot });
  assertTrue(built.code === 0, `the client build failed: ${built.stderr}`);
  await cp(join(harnessRoot, "dist"), join(scratchHarness, "dist"), { recursive: true });

  run("git", ["init", "-q", checkout]);
  run("git", ["-C", checkout, "config", "user.email", "devboard@example.test"]);
  run("git", ["-C", checkout, "config", "user.name", "Devboard Verify"]);
  run("git", ["-C", checkout, "add", "-A"]);
  run("git", ["-C", checkout, "commit", "-q", "-m", "feat: fixture source checkout"]);
  git(["tag", `v${VERSION_ONE}`]);
}

/** A next bundle whose main asset name differs from the one served now. */
async function nextBundle(): Promise<{ directory: string; asset: string; oldAsset: string }> {
  const directory = join(root, "next-dist");
  await cp(join(harnessRoot, "dist"), directory, { recursive: true });
  const html = readFileSync(join(directory, "index.html"), "utf8");
  const match = /\/assets\/([^"]+\.js)/.exec(html);
  assertTrue(match !== null, "the built index.html references no JavaScript asset");
  const oldAsset = match[1] ?? "";
  const asset = `index-published-${VERSION_TWO}.js`;
  await rename(join(directory, "assets", oldAsset), join(directory, "assets", asset));
  await writeFile(
    join(directory, "index.html"),
    html.split(`/assets/${oldAsset}`).join(`/assets/${asset}`),
  );
  return { directory, asset, oldAsset };
}

async function replaceScratchBundle(directory: string): Promise<void> {
  await rm(join(scratchHarness, "dist"), { recursive: true, force: true });
  await cp(directory, join(scratchHarness, "dist"), { recursive: true });
}

/** The digest the running dashboard must verify before any restart. */
function scratchDigest(): string {
  return distDigest(join(scratchHarness, "dist"));
}

async function deliver(commit: string, version: string): Promise<void> {
  const delivery = deliverSourceRefresh({
    repoRoot: checkout,
    harnessRoot: scratchHarness,
    commit,
    version,
    distDir: join(scratchHarness, "dist"),
    instances: liveInstances(),
  });
  assertTrue(delivery.written.length > 0, "the publish writer wrote no request");
}

async function main(): Promise<void> {
  step("the default retry interval is 60,000 ms");
  assertEquals(sourceRefreshIntervalMs({}), 60_000, "the default source refresh interval");

  await prepareCheckout();
  const emptyRelease = join(root, "empty-release");
  await mkdir(emptyRelease, { recursive: true });
  const log = join(root, "agent.log");
  const finishFile = join(root, "finish-draft");
  const stub = join(root, "replacement-stub");
  await writeFile(stub, "ok\n");
  const env = dashboardEnv(log, finishFile, stub);

  const stateA = join(root, "state-a");
  const stateB = join(root, "state-b");
  // The provider service reads its credentials at construction, so the
  // fixture seeds them before either dashboard process starts.
  const stamp = new Date().toISOString();
  for (const stateDir of [stateA, stateB]) {
    await mkdir(stateDir, { recursive: true });
    saveSubscriptions(stateDir, [
      {
        id: "verify-source-refresh-go",
        provider: "opencode-go",
        label: "Source refresh fixture",
        key: "fixture-key",
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
  }
  const portA = await freePort();
  const portB = await freePort();
  const dashboardA = await startSourceDashboard(stateA, portA, env);
  const dashboardB = await startSourceDashboard(stateB, portB, env);

  const initialA = await versionOf(portA);
  assertEquals(
    [initialA.running, initialA.installed, initialA.stale, initialA.source],
    [VERSION_ONE, VERSION_ONE, false, true],
    "the source dashboard starts on the source version",
  );
  step(`both dashboards serve the source checkout as ${VERSION_ONE}`);

  // A live detached goal draft that must survive the refresh with its owner,
  // activity, and answer path intact.
  await writeAt(
    checkout,
    ".devboard/goal-proposals/refresh-draft.md",
    "# Refresh draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep the elaboration running.\n",
  );
  const draftPath = ".devboard/goal-proposals/refresh-draft.md";
  await websocketCommand(portA, { type: "startGoalDraft", path: draftPath }, "issuesDraftState");
  await waitFor(
    () => agentLines(log).find((line) => line.startsWith("goal-draft-start ")),
    "the goal draft peer",
  );
  const ownerBefore = await waitFor(
    () => (ownerPids().length === 1 ? ownerPids()[0] : undefined),
    "the goal draft owner",
  );
  const peerBefore = Number(
    agentLines(log)
      .find((line) => line.startsWith("goal-draft-start "))
      ?.slice("goal-draft-start ".length),
  );
  assertTrue(peerBefore > 0 && processRunning(peerBefore), "the goal draft peer is not running");
  const activityBefore = await waitFor(
    async () => {
      const activity = (await communityActivity(portA, draftPath)).activity;
      return activity.length > 0 ? activity : undefined;
    },
    "the streamed draft activity",
  );

  const next = await nextBundle();
  await replaceScratchBundle(next.directory);
  await writeAt(checkout, "src-refresh.txt", "published change\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: published change"]);
  git(["tag", `v${VERSION_TWO}`]);
  const commitTwo = git(["rev-parse", "HEAD"]);
  const oldHtml = await (await fetch(`http://127.0.0.1:${portA}/`)).text();
  assertTrue(oldHtml.includes(next.oldAsset), "the old dashboard does not serve the old asset");
  // A new commit, a new release tag, and a rebuilt dist are not a trigger.
  await Bun.sleep(INTERVAL_MS * 2 + 300);
  assertEquals(
    currentPid(portA),
    dashboardA.pid,
    "a commit or a rebuilt dist restarted the source dashboard",
  );
  const betweenPublishAndRestart = await versionOf(portA);
  assertEquals(
    [
      betweenPublishAndRestart.running,
      betweenPublishAndRestart.installed,
      betweenPublishAndRestart.stale,
    ],
    [VERSION_ONE, VERSION_TWO, true],
    "the dashboard does not report the source version a restart would load as stale",
  );

  step("one publish request replaces both source dashboards");
  const restartingA = watchRestart(portA);
  const restartingB = watchRestart(portB);
  await deliver(commitTwo, VERSION_TWO);
  await restartingA;
  await restartingB;
  const newA = await waitReplacement(portA, dashboardA.pid);
  const newB = await waitReplacement(portB, dashboardB.pid);
  assertTrue(!processRunning(dashboardA.pid), "the replaced source process did not exit");
  assertEquals(
    liveInstances().filter((entry) => entry.port === portA).length,
    1,
    "exactly one dashboard listens on the original port",
  );
  await waitServing(portA, newA);
  await waitServing(portB, newB);
  const afterA = await versionOf(portA);
  const afterB = await versionOf(portB);
  assertEquals(
    [afterA.running, afterA.installed, afterA.stale, afterA.source],
    [VERSION_TWO, VERSION_TWO, false, true],
    "the replaced source dashboard runs and reports the published version",
  );
  assertEquals(
    [afterB.running, afterB.installed, afterB.stale],
    [VERSION_TWO, VERSION_TWO, false],
    "the second source dashboard runs the published version",
  );
  const finalHtml = await (await fetch(`http://127.0.0.1:${portA}/`)).text();
  assertTrue(finalHtml.includes(next.asset), "the final document is not from the published bundle");
  assertTrue(!finalHtml.includes(next.oldAsset), "the final document still names the old asset");
  const servedDigest = scratchDigest();
  assertEquals(
    servedDigest,
    JSON.parse(readFileSync(join(stateA, "source-refresh", "request.json"), "utf8")).distDigest,
    "the served bundle digest equals the requested digest",
  );
  step("the old pid exited, one process listens, and the new bundle is served");

  const activityAfter = await communityActivity(portA, draftPath);
  assertEquals(activityAfter.status, "running", "the replacement did not adopt the running draft");
  assertTrue(
    activityBefore.every((line) => activityAfter.activity.includes(line)),
    "the replacement dropped the draft's activity",
  );
  assertEquals(await ownerPids(), [ownerBefore], "the goal draft owner changed across the refresh");
  assertTrue(processRunning(peerBefore), "the goal draft peer did not survive the refresh");
  await writeFile(finishFile, "finish\n");
  await waitFor(
    () => (existsSync(join(checkout, ".devboard", "goals", "refresh-draft.md")) ? true : undefined),
    "the draft to finish after the refresh",
    30_000,
  );
  await waitFor(
    () => (ownerPids().length === 0 ? true : undefined),
    "the finished draft to release its owner",
    15_000,
  );
  step("the live detached run and its owner survived and finished");

  // The MCP status agrees with the live WebSocket frame.
  const status = await devboardStatus({
    repoDir: checkout,
    harnessDir: scratchHarness,
    stateDir: stateA,
    environment: {},
    dashboards: [
      {
        pid: newA,
        port: portA,
        repoDir: checkout,
        harness: scratchHarness,
        stateDir: stateA,
      },
    ],
  });
  const live = await versionOf(portA);
  assertEquals(
    [status.version.running, status.version.installed, status.version.source],
    [live.running, live.installed, live.source],
    "devboard_status disagrees with the live versionState",
  );

  step("re-delivering the same publish never restarts again");
  const settled = currentPid(portA);
  await deliver(commitTwo, VERSION_TWO);
  await Bun.sleep(INTERVAL_MS * 2 + 500);
  assertEquals(currentPid(portA), settled, "a re-delivered request restarted the dashboard");
  assertEquals(
    journalRecords(stateA).filter((record) => record.text.includes("source refresh requested")).length,
    1,
    "a re-delivered request was handled twice",
  );

  step("a digest mismatch, a missing request, and a failed replacement leave the old process serving");
  await writeAt(checkout, "next-change.txt", "second change\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: second change"]);
  git(["tag", `v${VERSION_THREE}`]);
  const commitThree = git(["rev-parse", "HEAD"]);
  const servingPid = currentPid(portA) ?? 0;
  writeSourceRefreshRequest(stateA, {
    schema: 1,
    commit: commitThree,
    version: VERSION_THREE,
    distDigest: "0".repeat(64),
    requestedAt: new Date().toISOString(),
  });
  await waitFor(
    () =>
      journalRecords(stateA).some((record) => record.text.includes("not the requested"))
        ? true
        : undefined,
    "the digest mismatch journal record",
    15_000,
  );
  await Bun.sleep(INTERVAL_MS * 2);
  assertEquals(currentPid(portA), servingPid, "a digest mismatch restarted the dashboard");
  assertEquals(httpStatus(portA), 200, "the page stopped answering after a digest mismatch");

  await rm(join(stateA, "source-refresh", "request.json"), { force: true });
  await Bun.sleep(INTERVAL_MS * 2);
  assertEquals(currentPid(portA), servingPid, "a missing request restarted the dashboard");
  assertEquals(httpStatus(portA), 200, "the page stopped answering after a missing request");

  await writeFile(stub, "fail\n");
  await deliver(commitThree, VERSION_THREE);
  await waitFor(
    () =>
      journalRecords(stateA).some((record) => record.text.includes("stubbed replacement failure"))
        ? true
        : undefined,
    "the failed spawn journal record",
    15_000,
  );
  const failedSpawns = journalRecords(stateA).filter((record) =>
    record.text.includes("stubbed replacement failure"),
  ).length;
  await Bun.sleep(INTERVAL_MS);
  assertTrue(
    journalRecords(stateA).filter((record) =>
      record.text.includes("stubbed replacement failure"),
    ).length > failedSpawns,
    "a pending failed request was not retried on the interval",
  );
  assertEquals(currentPid(portA), servingPid, "a failed spawn restarted the dashboard");
  assertEquals(httpStatus(portA), 200, "the page stopped answering after a failed spawn");

  step("a replacement that never becomes ready leaves the old process serving");
  await writeFile(stub, "never-ready\n");
  await writeAt(checkout, "third-change.txt", "third change\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: third change"]);
  git(["tag", `v${VERSION_FOUR}`]);
  const commitFour = git(["rev-parse", "HEAD"]);
  await deliver(commitFour, VERSION_FOUR);
  await waitFor(
    () =>
      journalRecords(stateA).some((record) => record.text.includes("did not become ready"))
        ? true
        : undefined,
    "the never-ready journal record",
    30_000,
  );
  assertEquals(currentPid(portA), servingPid, "a never-ready replacement restarted the dashboard");
  assertEquals(httpStatus(portA), 200, "the page stopped answering after a never-ready replacement");
  assertEquals(
    liveInstances().filter((entry) => entry.port === portA).length,
    1,
    "a never-ready attempt left a second process",
  );

  step("the pending request succeeds on the configured retry interval");
  const retryRestarting = watchRestart(portA);
  await writeFile(stub, "ok\n");
  const retriedPid = await waitReplacement(portA, servingPid);
  await retryRestarting;
  await waitServing(portA, retriedPid);
  const retried = await versionOf(portA);
  assertEquals(
    [retried.running, retried.installed, retried.stale],
    [VERSION_FOUR, VERSION_FOUR, false],
    "the retried replacement runs the pending published version",
  );
  assertEquals(
    journalRecords(stateA).filter((record) => record.text.includes("did not become ready")).length,
    1,
    "the never-ready failure was journaled more than once per attempt",
  );
  step("the never-ready failure was journaled once and the retry replaced the process");
}

/** The draft run's status and activity, read over the dashboard websocket. */
async function communityActivity(
  port: number,
  path: string,
): Promise<{ status: string; activity: string[] }> {
  const reply = await websocketCommand(port, { type: "getGoalDrafts" }, "issuesDrafts");
  const runs = Array.isArray(reply.runs) ? reply.runs : [];
  const run = runs.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).path === path,
  );
  assertTrue(run !== undefined, "the dashboard returned no draft run");
  const activity = Array.isArray(run.activity)
    ? run.activity.filter((line): line is string => typeof line === "string")
    : [];
  return { status: typeof run.status === "string" ? run.status : "", activity };
}

try {
  await main();
  console.log("verify:source-refresh: all checks passed");
} finally {
  for (const dashboard of dashboardsFor(checkout)) stopPid(dashboard.pid);
  await waitFor(
    () => (dashboardsFor(checkout).length === 0 ? true : undefined),
    "the source dashboards to stop",
    15_000,
  ).catch(() => undefined);
}

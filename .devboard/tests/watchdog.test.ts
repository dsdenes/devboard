import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  instancesFromProcesses,
  legacyLogPath,
  posixCksum,
  type Instance,
  type ProcessSnapshot,
} from "../watchdog/discovery";
import { journalFile, journalFiles, openJournal } from "../server/journal";
import {
  collectEvidence,
  normalizeEvidenceLine,
  readJournalEvidence,
  readOmpEvidence,
  WINDOW_MS,
  type EvidenceEvent,
  type Window,
} from "../watchdog/collect";
import { analyzeEvidence, STALL_MS } from "../watchdog/findings";
import { claimCycle, liveCycleClaim, readCycleClaim } from "../watchdog/lock";
import { runWorker } from "../watchdog/worker";
import { writeWatchdogCommand } from "../watchdog/control";
import {
  cycleClaimPath,
  versionedControlDirectory,
  versionedLockPath,
  versionedWorkerDirectory,
} from "../watchdog/paths";
import { readWorkerState } from "../watchdog/worker-state";
import { emptyLedger, loadLedger } from "../watchdog/ledger";
import { writeProjection } from "../watchdog/projection";
import { DEFAULT_WATCHDOG_SETTINGS, type WatchdogSettings } from "../watchdog/settings";
import {
  commentIssue,
  createIssue,
  type GhOutcome,
  type GhRun,
} from "../watchdog/github";
import {
  runCycle,
  type CycleOptions,
  type Report,
} from "../watchdog/coordinator";
import {
  DEDUP_TOOLS,
  startDedupStdio,
} from "../watchdog/dedup-mcp";
import {
  dedupPrompt,
  type Dedup,
  type DedupRequest,
} from "../watchdog/dedup";
import type { WatchdogDelivery } from "../watchdog/delivery";
import type { ForgeIssues } from "../lib/forge-issues";
import { GITEA_ISSUE_READ_MAX } from "../lib/gitea";

/**
 * Every fixture lives under the repository's `.devboard/.tmp`. Filing is
 * proven against a stub `gh`; no test uses the network, a model, or a remote.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const v1StateFixture = join(harnessRoot, "tests", "fixtures", "watchdog-state-v1.json");
const testRoot = join(harnessRoot, ".tmp");
const fixedNow = new Date("2026-10-24T12:00:00.000Z");
const window: Window = {
  start: new Date(fixedNow.getTime() - 10 * 60 * 1000),
  end: fixedNow,
};
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "test-watchdog"): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixtureRepository(): Promise<{ root: string; harness: string; origin: string }> {
  const base = await temporaryDirectory("test-watchdog-repo");
  const root = join(base, "repo");
  const origin = join(base, "origin.git");
  const harness = join(root, ".devboard");
  await mkdir(harness, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Harness instructions\n");
  await writeFile(join(root, ".gitignore"), ".devboard/.tmp/\n.worktree/\n");
  await writeFile(join(harness, "README.md"), "# Harness\n");
  git(base, "init", "--quiet", "--bare", origin);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "devboard@example.test");
  git(root, "config", "user.name", "Devboard Test");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "--quiet", "--set-upstream", "origin", "main");
  return { root, harness, origin };
}

function instanceFor(root: string, port: number, harness = join(root, ".devboard")): Instance {
  return {
    pid: 4000 + port,
    port,
    repoDir: root,
    host: "127.0.0.1",
    harness,
    stateDir: join(harness, ".tmp"),
    journal: journalFile(join(harness, ".tmp"), root),
    instrumented: true,
  };
}

function event(
  root: string,
  minutesAgo: number,
  text: string,
  kind: EvidenceEvent["kind"] = "activity",
  owner?: Instance,
  level?: EvidenceEvent["level"],
): EvidenceEvent {
  return {
    source: join(root, ".devboard", ".tmp", "journal", "fixture.jsonl"),
    kind,
    ts: new Date(fixedNow.getTime() - minutesAgo * 60 * 1000).toISOString(),
    text,
    ...(level === undefined ? {} : { level }),
    ...(owner === undefined ? {} : { instance: owner }),
  };
}

interface GhReply {
  code?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface GhCall {
  argv: string[];
  stdin: string;
}

function ghStub(reply: (call: GhCall, index: number) => GhReply = () => ({})): {
  gh: GhRun;
  calls: GhCall[];
} {
  const calls: GhCall[] = [];
  const gh: GhRun = (argv, stdin) => {
    const call = { argv, stdin };
    const result = reply(call, calls.length);
    calls.push(call);
    const code = result.code ?? 0;
    const outcome: GhOutcome = {
      code,
      stdout: result.stdout ?? (code === 0 ? "https://github.com/dsdenes/devboard/issues/7" : ""),
      stderr: result.stderr ?? "",
      ...(result.timedOut === true ? { timedOut: true } : {}),
    };
    return outcome;
  };
  return { gh, calls };
}

interface DedupCall {
  request: DedupRequest;
  /** The per-cycle directory the turn was told to record into. */
  runDir: string;
  /** Forge calls the cycle had made when the agent was asked. */
  createsBefore: number;
}

interface DedupTurn {
  /** Records the peer's MCP write tools would append. */
  records?: unknown[];
  /** Counts of open issues the peer read, one line each. */
  reads?: number[];
  /** Thrown after the records are written, as a failed tool call would be. */
  error?: string;
}

/** The dedup peer's deterministic filing record for one candidate. */
function filedRecord(
  candidate: DedupRequest["candidates"][number],
  number: number,
): Record<string, unknown> {
  return {
    fingerprint: candidate.fingerprint,
    action: "filed",
    number,
    url: `https://github.com/acme/fixture/issues/${number}`,
    title: `[watchdog] ${candidate.category}: ${candidate.line}`,
  };
}

/** A duplicate record naming an open issue or another candidate. */
function duplicateRecord(
  candidate: DedupRequest["candidates"][number],
  match: { issue?: string; representative?: string },
): Record<string, unknown> {
  return { fingerprint: candidate.fingerprint, action: "duplicate", ...match };
}

/**
 * A deterministic deduplication peer. The turn writes the records its MCP
 * tools would append to `runDir/dedup-records.jsonl`; an Error is thrown as
 * the agent failure it stands for, and nothing is read from an answer object.
 * Every call is recorded so a test can prove one request over the whole set.
 */
function dedupStub(
  turn: (request: DedupRequest, call: number) => DedupTurn | Error | string,
  forge?: { calls: unknown[] },
): { dedup: Dedup; calls: DedupCall[] } {
  const calls: DedupCall[] = [];
  const dedup: Dedup = async (request, runDir) => {
    calls.push({ request, runDir, createsBefore: forge?.calls.length ?? 0 });
    const value = turn(request, calls.length - 1);
    if (value instanceof Error) throw value;
    if (typeof value === "string") return value;
    writeFileSync(
      join(runDir, "dedup-records.jsonl"),
      (value.records ?? []).map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    if (value.reads !== undefined) {
      writeFileSync(
        join(runDir, "dedup-reads.jsonl"),
        value.reads.map((count) => `${JSON.stringify({ count })}\n`).join(""),
      );
    }
    if (value.error !== undefined) throw new Error(value.error);
    return "";
  };
  return { dedup, calls };
}

/** Files every candidate the turn was given room for; it read the open issues. */
function filedWithinRoom(request: DedupRequest): DedupTurn {
  const room = Math.min(request.filingRoom, request.candidates.length);
  return {
    records: request.candidates
      .slice(0, room)
      .map((candidate, index) => filedRecord(candidate, 100 + index)),
    reads: [1],
  };
}

/** Files every candidate; used where caps and duplicates are irrelevant. */
function uniqueDedup(): Dedup {
  return async (request, runDir) => {
    writeFileSync(
      join(runDir, "dedup-records.jsonl"),
      request.candidates
        .map((candidate, index) => `${JSON.stringify(filedRecord(candidate, 100 + index))}\n`)
        .join(""),
    );
    writeFileSync(join(runDir, "dedup-reads.jsonl"), `${JSON.stringify({ count: 1 })}\n`);
    return "";
  };
}

function deliveryStub(
  gh: GhRun,
  states: Record<string, "open" | "closed"> = {},
): WatchdogDelivery {
  return {
    repository: "acme/fixture",
    owns: () => true,
    create: async (input) => createIssue(gh, "acme/fixture", input),
    comment: async (url, input) => commentIssue(gh, url, input),
    state: async (url) => states[url],
  };
}

function cycleFor(
  root: string,
  options: {
    events: EvidenceEvent[];
    gh: GhRun;
    now?: Date;
    dryRun?: boolean;
    settings?: WatchdogSettings;
    dedup?: Dedup;
    delivery?: WatchdogDelivery;
  },
): CycleOptions {
  const instance = instanceFor(root, 8080);
  const now = options.now ?? fixedNow;
  // Injected evidence belongs to the cycle that collects it, so a delayed
  // cycle gets the same records shifted into its window.
  const drift = now.getTime() - fixedNow.getTime();
  const events =
    drift === 0
      ? options.events
      : options.events.map((event) => ({
          ...event,
          ts: new Date(Date.parse(event.ts) + drift).toISOString(),
        }));
  return {
    root,
    now,
    stateDir: join(root, ".devboard", ".tmp", "watchdog"),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    deps: {
      discover: () => [instance],
      collect: () => ({ events, malformed: 0, unattributed: 0 }),
      gh: options.gh,
      dedup: options.dedup ?? uniqueDedup(),
      delivery: options.delivery ?? deliveryStub(options.gh),
    },
  };
}

const SERVER_ERROR = "Synthetic error: ENOTFOUND the model endpoint";

describe("discovery", () => {
  test("matches POSIX cksum", () => {
    expect(posixCksum(Buffer.from("123456789"))).toBe(930766865);
    expect(posixCksum(Buffer.from(""))).toBe(4294967295);
  });

  test("de-duplicates, excludes the watchdog, and resolves each harness", async () => {
    const base = await temporaryDirectory("test-watchdog-discovery");
    const firstHarness = join(base, "harness-first");
    const secondHarness = join(base, "harness-second");
    await mkdir(join(firstHarness, ".tmp", "journal"), { recursive: true });
    await mkdir(join(secondHarness, ".tmp"), { recursive: true });
    const firstRepo = "/projects/first";
    const secondRepo = "/projects/second";
    const journal = journalFile(join(firstHarness, ".tmp"), firstRepo);
    await writeFile(journal, "");
    const legacy = legacyLogPath(firstHarness, firstRepo);
    await writeFile(legacy, "legacy\n");
    const installedState = join(base, "installed-state");
    const installedRepo = "/projects/installed";
    await mkdir(join(installedState, "journal"), { recursive: true });
    const installedJournal = journalFile(installedState, installedRepo);
    await writeFile(installedJournal, "");

    const snapshot = (
      pid: number,
      repoDir: string,
      port: string,
      options: {
        cwd?: string;
        staticDir?: string;
        stateDir?: string;
        ancestors?: number[];
        cmdline?: string;
      } = {},
    ): ProcessSnapshot => ({
      pid,
      cmdline: options.cmdline ?? "bun /x/server/index.ts",
      env: new Map([
        ["REPO_DIR", repoDir],
        ["PORT", port],
        ["HOST", "127.0.0.1"],
        ...(options.staticDir === undefined ? [] : ([["STATIC_DIR", options.staticDir]] as const)),
        ...(options.stateDir === undefined ? [] : ([["STATE_DIR", options.stateDir]] as const)),
      ]),
      cwd: options.cwd,
      ancestors: options.ancestors ?? [],
    });

    const instances = instancesFromProcesses(
      [
        snapshot(10, firstRepo, "8080", { staticDir: join(firstHarness, "dist") }),
        snapshot(11, firstRepo, "8080", { staticDir: join(firstHarness, "dist") }),
        snapshot(12, secondRepo, "8081", { cwd: secondHarness }),
        snapshot(99, "/projects/watchdog", "9000", { cwd: firstHarness }),
        snapshot(100, "/projects/child", "9001", { cwd: firstHarness, ancestors: [99] }),
        snapshot(13, "/projects/unknown", "not-a-port"),
        snapshot(14, "/projects/not-server", "8082", { cmdline: "bun something-else.ts" }),
        snapshot(15, installedRepo, "8083", {
          staticDir: join(secondHarness, "dist"),
          stateDir: installedState,
        }),
        snapshot(15, installedRepo, "8083", {
          staticDir: join(secondHarness, "dist"),
          stateDir: installedState,
        }),
      ],
      { selfPids: new Set([99]) },
    );

    expect(instances.map((instance) => [instance.pid, instance.port, instance.repoDir])).toEqual([
      [10, 8080, firstRepo],
      [12, 8081, secondRepo],
      [15, 8083, installedRepo],
    ]);
    expect(instances[0]?.instrumented).toBe(true);
    expect(instances[0]?.journal).toBe(journal);
    expect(instances[0]?.legacyLog).toBe(legacy);
    expect(instances[1]?.harness).toBe(secondHarness);
    expect(instances[1]?.instrumented).toBe(false);
    expect(instances[2]?.journal).toBe(installedJournal);
    expect(instances[2]?.instrumented).toBe(true);
  });

  test("excludes dashboards rooted in harness scratch", async () => {
    const base = await temporaryDirectory("test-watchdog-scratch");
    const harness = join(base, "harness");
    const installedHarness = join(
      base,
      ".devboard",
      ".tmp",
      "npm-host",
      ".devboard",
      "node_modules",
      "@dsdenes",
      "devboard",
    );
    await mkdir(join(harness, "dist"), { recursive: true });
    await mkdir(join(installedHarness, "dist"), { recursive: true });
    const scratchRepo = join(harness, ".tmp", "verify-update-fixture", "broken");
    const installedScratchRepo = join(base, ".devboard", ".tmp", "npm-host");
    const realRepo = "/projects/.devboard/host";

    const snapshot = (
      pid: number,
      repoDir: string,
      port: string,
      staticDir: string,
      extra: [string, string][] = [],
    ): ProcessSnapshot => ({
      pid,
      cmdline: "bun /x/server/index.ts",
      env: new Map([
        ["REPO_DIR", repoDir],
        ["PORT", port],
        ["STATIC_DIR", staticDir],
        ...extra,
      ]),
      ancestors: [],
    });

    const instances = instancesFromProcesses(
      [
        snapshot(20, scratchRepo, "8080", join(harness, "dist")),
        snapshot(21, installedScratchRepo, "8081", join(installedHarness, "dist")),
        snapshot(22, realRepo, "8082", join(harness, "dist")),
        snapshot(23, scratchRepo, "8083", join(harness, "dist"), [
          ["DEVBOARD_WATCHDOG_FIXTURE", "1"],
        ]),
        snapshot(24, "../.devboard/.tmp/verify-update-1/checksum", "8084", join(harness, "dist")),
      ],
      { selfPids: new Set() },
    );

    expect(instances.map((instance) => [instance.pid, instance.port, instance.repoDir])).toEqual([
      [22, 8082, realRepo],
      [23, 8083, scratchRepo],
    ]);
  });

  test("excludes dashboards that read a local release directory", async () => {
    const base = await temporaryDirectory("test-watchdog-release-fixture");
    const harness = join(base, "harness");
    await mkdir(join(harness, "dist"), { recursive: true });
    const fixtureRepo = join(base, "devboard-restart-F0Snwz");
    const emptyOverride = "/projects/.devboard/empty-release-override";
    const liveFixture = "/projects/.devboard/watchdog-live-fixture";
    const realRepo = "/projects/.devboard/host";

    const snapshot = (
      pid: number,
      repoDir: string,
      port: string,
      extra: [string, string][] = [],
    ): ProcessSnapshot => ({
      pid,
      cmdline: "bun /x/server/index.ts",
      env: new Map([
        ["REPO_DIR", repoDir],
        ["PORT", port],
        ["STATIC_DIR", join(harness, "dist")],
        ...extra,
      ]),
      ancestors: [],
    });

    const instances = instancesFromProcesses(
      [
        snapshot(30, fixtureRepo, "8080", [
          ["DEVBOARD_RELEASE_DIR", join(fixtureRepo, "releases")],
        ]),
        snapshot(31, emptyOverride, "8081", [["DEVBOARD_RELEASE_DIR", ""]]),
        snapshot(32, liveFixture, "8082", [
          ["DEVBOARD_RELEASE_DIR", join(base, "releases")],
          ["DEVBOARD_WATCHDOG_FIXTURE", "1"],
        ]),
        snapshot(33, realRepo, "8083"),
      ],
      { selfPids: new Set() },
    );

    // The empty override reads the npm registry, exactly as an unset variable
    // does, so it stays a host the watchdog reads.
    expect(instances.map((instance) => [instance.pid, instance.port, instance.repoDir])).toEqual([
      [31, 8081, emptyOverride],
      [32, 8082, liveFixture],
      [33, 8083, realRepo],
    ]);
  });
});

describe("window and attribution", () => {
  test("includes 9 minutes, excludes 11 minutes and malformed records", async () => {
    const base = await temporaryDirectory("test-watchdog-window");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const lines = [
      {
        ts: new Date(window.start.getTime() + 60_000).toISOString(),
        kind: "activity",
        text: "nine",
      },
      {
        ts: new Date(window.start.getTime() - 60_000).toISOString(),
        kind: "activity",
        text: "eleven",
      },
      { ts: "not-a-date", kind: "activity", text: "malformed" },
      { ts: window.start.toISOString(), kind: "activity", text: "start" },
      { ts: window.end.toISOString(), kind: "activity", text: "end" },
    ];
    await writeFile(instance.journal, lines.map((line) => JSON.stringify(line)).join("\n"));

    const collected = readJournalEvidence(instance, { window, root: base });
    expect(collected.events.map((item) => item.text)).toEqual(["nine", "start", "end"]);
    expect(collected.malformed).toBe(1);
  });

  test("reads an error that rotation moved out of the live journal", async () => {
    const base = await temporaryDirectory("test-watchdog-journal-rotated");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const journal = openJournal({
      stateDir: join(harness, ".tmp"),
      repoDir: base,
      port: 8080,
      rotateBytes: 1,
      now: () => fixedNow,
    });
    journal.write("server-error", SERVER_ERROR);
    // The second write rotates the error aside; the live file starts over.
    journal.write("activity", "after rotation");
    await writeFile(instance.journal, "");
    const rotated = journalFiles(instance.journal)[0];
    if (rotated === undefined) throw new Error("rotation did not produce a journal");
    await appendFile(rotated, "{not json\n");

    const collected = readJournalEvidence(instance, { window, root: base });
    expect(collected.events.map((item) => item.text)).toEqual([SERVER_ERROR]);
    expect(collected.malformed).toBe(1);
    const findings = analyzeEvidence(collected.events, { window });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("server-error");
    expect(findings[0]?.quote).toBe(SERVER_ERROR);
  });

  test("a record copied into a rotated journal and the live journal counts once", async () => {
    const base = await temporaryDirectory("test-watchdog-journal-duplicate");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const journal = openJournal({
      stateDir: join(harness, ".tmp"),
      repoDir: base,
      port: 8080,
      now: () => fixedNow,
    });
    journal.write("server-error", SERVER_ERROR);
    await copyFile(instance.journal, `${instance.journal}.1700000000000-1`);

    const collected = readJournalEvidence(instance, { window, root: base });
    expect(collected.events).toHaveLength(1);
    expect(collected.events[0]?.text).toBe(SERVER_ERROR);
    expect(analyzeEvidence(collected.events, { window })).toHaveLength(1);
  });

  test("attributes an in-window omp error by dashboard process ancestry", async () => {
    const base = await temporaryDirectory("test-watchdog-omp");
    const logsDir = join(base, "logs");
    await mkdir(logsDir, { recursive: true });
    const instance = instanceFor(base, 8080);
    const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
    const records = [
      line({
        timestamp: new Date(window.end.getTime() - 60_000).toISOString(),
        level: "error",
        pid: 500,
        message: "connection error",
      }),
      line({
        timestamp: new Date(window.end.getTime() - 2 * 60_000).toISOString(),
        level: "warn",
        pid: 501,
        message: "unrelated warning",
      }),
      line({
        timestamp: new Date(window.end.getTime() - 3 * 60_000).toISOString(),
        level: "warn",
        pid: 502,
        message: "ui.loop-blocked",
        blockedMs: 1314,
        cpuMs: 252,
      }),
      line({
        timestamp: new Date(window.start.getTime() - 60_000).toISOString(),
        level: "error",
        pid: 500,
        message: "older error",
      }),
      line({
        timestamp: new Date(window.end.getTime() - 3 * 60_000).toISOString(),
        level: "error",
        pid: 42,
        message: "watchdog's own error",
      }),
      line({
        timestamp: new Date(window.end.getTime() - 4 * 60_000).toISOString(),
        level: "debug",
        pid: 500,
        message: "debug noise",
      }),
      "{not json",
    ];
    const logPath = join(logsDir, "omp.2026-10-24.1.log");
    await writeFile(logPath, records.join("\n"));

    const collected = readOmpEvidence({
      logsDir,
      window,
      instances: [instance],
      selfPids: new Set([42]),
      // 500 is a dashboard peer; 501 is a stranger; 502 is the operator's own
      // omp session in the project directory, a child of a shell, not the
      // dashboard — its warnings are not dashboard evidence.
      processInfo: (pid) =>
        pid === 500
          ? { ancestors: [instance.pid, 1] }
          : pid === 502
            ? { ancestors: [3180812, 247286] }
            : { ancestors: [] },
    });

    expect(collected.events.map((item) => item.text)).toEqual(["connection error"]);
    expect(collected.events[0]?.level).toBe("error");
    expect(collected.events[0]?.instance).toEqual(instance);
    expect(collected.unattributed).toBe(2);
    expect(collected.malformed).toBe(1);
  });

  test("one repeated omp warning is one finding despite its capture paths", async () => {
    const base = await temporaryDirectory("test-watchdog-omp-capture");
    const logsDir = join(base, "logs");
    await mkdir(logsDir, { recursive: true });
    const instance = instanceFor(base, 8080);
    const error =
      "Error: Model stopped: error 400 Upstream request failed: region unavailable\n" +
      "Upstream request failed: region unavailable (type=server_error)";
    const warning = (offsetMs: number, skill: string, capture: string) =>
      JSON.stringify({
        timestamp: new Date(window.end.getTime() - offsetMs).toISOString(),
        level: "warn",
        pid: 500,
        message: "Skill description compression failed",
        skill,
        error: `${error}\nraw-http-request=${join(logsDir, capture)}`,
      });
    await writeFile(
      join(logsDir, "omp.2026-10-24.1.log"),
      [
        warning(60_000, "differential-conformance-testing", "1793310094896-1w6x8zcj4ly8q.json"),
        warning(59_000, "drop-in-compatibility", "1793310094921-3urhboh3f1nj1.json"),
      ].join("\n"),
    );

    const collected = readOmpEvidence({
      logsDir,
      window,
      instances: [instance],
      selfPids: new Set([42]),
      processInfo: () => ({ ancestors: [instance.pid, 1] }),
    });
    expect(collected.events).toHaveLength(2);

    const findings = analyzeEvidence(collected.events, { window });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("omp-warn");
    expect(findings[0]?.quote).not.toContain("raw-http-request");
    expect(findings[0]?.instances).toEqual([instance]);
  });
});

describe("evidence mapping", () => {
  test("activity, lifecycle, update, and ordinary run text never produce a finding", async () => {
    const root = await temporaryDirectory("test-watchdog-prose");
    const owner = instanceFor(root, 8080);
    const prose = "error retry ambiguous blocked crash: the operator asked a question";
    const events = [
      event(root, 3, prose, "activity", owner),
      event(root, 3, "lifecycle implementation pass 2", "lifecycle", owner),
      event(root, 3, "update checked: error state handled", "update", owner),
      event(root, 3, "Choose an answer", "question", owner),
      event(root, 4, "run started", "run-start", owner),
      event(root, 3, "run finished", "run-stop", owner),
      event(root, 4, "lane-1 implementation Fix it", "lane-start", owner),
      event(root, 3, "lane-1 closed", "lane-stop", owner),
      event(root, 2, "lane-2 retrying", "lane-stop", owner),
    ];
    expect(analyzeEvidence(events, { window })).toEqual([]);

    const { root: fixture } = await fixtureRepository();
    const { gh, calls } = ghStub();
    const result = await runCycle(cycleFor(fixture, { events, gh }));
    expect(result.report.findings).toEqual([]);
    expect(result.report.action).toBe("none");
    expect(calls).toEqual([]);
  });

  test("one server-error record is one finding whose fingerprint excludes its path", async () => {
    const base = await temporaryDirectory("test-watchdog-journal-signal");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const journal = openJournal({
      stateDir: join(harness, ".tmp"),
      repoDir: base,
      port: 8080,
      now: () => fixedNow,
    });
    journal.write("server-error", SERVER_ERROR);

    const collected = readJournalEvidence(instance, { window, root: base });
    const findings = analyzeEvidence(collected.events, { window });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("server-error");
    expect(findings[0]?.fingerprint).toBe(
      createHash("sha256").update(`server-error\n${SERVER_ERROR}`).digest("hex").slice(0, 32),
    );
    expect(findings[0]?.instances).toEqual([instance]);
  });

  test("a journal question keeps its work-stream scope in the evidence", async () => {
    const base = await temporaryDirectory("test-watchdog-journal-scope");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const journal = openJournal({
      stateDir: join(harness, ".tmp"),
      repoDir: base,
      port: 8080,
      now: () => fixedNow,
    });
    journal.write("question", "Choose an answer", "lane:lane-7");

    const collected = readJournalEvidence(instance, { window, root: base });
    expect(collected.events).toHaveLength(1);
    expect(collected.events[0]).toMatchObject({
      kind: "question",
      text: "Choose an answer",
      scope: "lane:lane-7",
    });
  });

  test("a failed lane-stop is one finding and a closed lane is not", async () => {
    const root = await temporaryDirectory("test-watchdog-lane");
    const owner = instanceFor(root, 8080);
    const failed = event(root, 2, "lane-3 implementation Fix the build failed", "lane-stop", owner);
    const closed = event(root, 2, "lane-4 implementation Ship it closed", "lane-stop", owner);
    expect(analyzeEvidence([closed], { window })).toEqual([]);
    const findings = analyzeEvidence([failed], { window });
    expect(findings.map((finding) => finding.category)).toEqual(["lane-failed"]);
  });

  test("update-error and acp-stderr are findings of their own kind", async () => {
    const root = await temporaryDirectory("test-watchdog-kinds");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 3, "update install failed: checksum mismatch", "update-error", owner),
      event(root, 2, "acp peer wrote to stderr: unexpected token", "acp-stderr", owner),
    ];
    expect(analyzeEvidence(events, { window }).map((finding) => finding.category)).toEqual([
      "update-error",
      "acp-stderr",
    ]);
  });

  test("omp error, warn, and fatal are findings; a level-less record is not", async () => {
    const root = await temporaryDirectory("test-watchdog-omp-levels");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 3, "acp timeout", "omp-log", owner, "error"),
      event(root, 2, "slow response", "omp-log", owner, "warn"),
      event(root, 1, "cannot write session", "omp-log", owner, "fatal"),
      event(root, 1, "plain line", "omp-log", owner),
    ];
    expect(analyzeEvidence(events, { window }).map((finding) => finding.category)).toEqual([
      "omp-error",
      "omp-warn",
      "omp-fatal",
    ]);
  });

  test("omp's retried thinking-loop notice is not a finding", async () => {
    const root = await temporaryDirectory("test-watchdog-omp-retry");
    const owner = instanceFor(root, 8080);
    const retried = event(
      root,
      2,
      "Thinking loop detected; aborting stream for retry.",
      "omp-log",
      owner,
      "warn",
    );
    expect(analyzeEvidence([retried], { window })).toEqual([]);

    const terminal = event(
      root,
      1,
      "agent turn ended with provider error: Thinking loop detected: the model " +
        "repeated near-identical content (4 near-identical segments within the last 16).",
      "omp-log",
      owner,
      "warn",
    );
    expect(analyzeEvidence([terminal], { window }).map((finding) => finding.category)).toEqual([
      "omp-warn",
    ]);
  });

  test("detects a question loop and a stalled start", async () => {
    const root = await temporaryDirectory("test-watchdog-loop");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 6, "Choose an answer", "question", owner),
      event(root, 5, "Choose an answer 2", "question", owner),
      event(root, 4, "Choose an answer 3", "question", owner),
      event(root, 8, "lane-1 implementing", "lane-start", owner),
    ];
    const findings = analyzeEvidence(events, { window });
    expect(findings.map((finding) => finding.category)).toEqual(["stall", "question-loop"]);
    expect(findings[1]?.quote).toBe("Choose an answer 3");
    expect(analyzeEvidence(events.slice(0, 2), { window })).toEqual([]);
  });

  test("questions from separate runs, lanes, and peers are not a loop", async () => {
    const root = await temporaryDirectory("test-watchdog-loop-scopes");
    const owner = instanceFor(root, 8080);
    const scoped = (minutesAgo: number, scope: string): EvidenceEvent => ({
      ...event(root, minutesAgo, "Choose an answer", "question", owner),
      scope,
    });
    const restartFixture = [
      scoped(6, "lane:lane-1"),
      scoped(5, "lane:lane-1"),
      scoped(4, "run:0001-first.md"),
      scoped(3, "run:0001-first.md"),
    ];
    expect(analyzeEvidence(restartFixture, { window })).toEqual([]);

    const loop = [...restartFixture, scoped(2, "lane:lane-1")];
    const findings = analyzeEvidence(loop, { window });
    expect(findings.map((finding) => finding.category)).toEqual(["question-loop"]);
    expect(findings[0]?.quote).toBe("Choose an answer");
  });

  test("a stop at or after the start ends the stall", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-ended");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 8, "lane-1 implementing", "lane-start", owner),
      event(root, 6, "lane-1 closed", "lane-stop", owner),
      event(root, 2, "lane-2 implementing", "lane-start", owner),
    ];
    expect(analyzeEvidence(events, { window })).toEqual([]);
  });

  test("a start in a window's final five minutes stalls in the next lookback", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-lookback");
    const owner = instanceFor(root, 8080);
    const started = new Date(fixedNow.getTime() - 4 * 60 * 1000);
    const events = [event(root, 4, "lane-1 implementing", "lane-start", owner)];
    const nextWindow: Window = {
      start: fixedNow,
      end: new Date(fixedNow.getTime() + WINDOW_MS),
    };
    const lookbackFor = (target: Window): Window => ({
      start: new Date(target.start.getTime() - STALL_MS),
      end: target.end,
    });

    // The cycle that saw the start skipped it as too young to be stalled.
    expect(analyzeEvidence(events, { window, stallLookback: lookbackFor(window) })).toEqual([]);

    const findings = analyzeEvidence(events, {
      window: nextWindow,
      stallLookback: lookbackFor(nextWindow),
    });
    expect(findings.map((finding) => finding.category)).toEqual(["stall"]);
    expect(findings[0]?.quote).toBe("lane-1 implementing");
    expect(findings[0]?.ts).toBe(started.toISOString());
  });

  test("a stop in the stall lookback ends an older start", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-lookback-stop");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 14, "lane-1 implementing", "lane-start", owner),
      event(root, 13, "lane-1 closed", "lane-stop", owner),
    ];
    const stallLookback: Window = {
      start: new Date(window.start.getTime() - STALL_MS),
      end: window.end,
    };
    expect(analyzeEvidence(events, { window, stallLookback })).toEqual([]);
  });

  test("the stall lookback never extends a non-stall finding", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-lookback-signals");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 12, SERVER_ERROR, "server-error", owner),
      event(root, 12, "lane-3 implementation Fix the build failed", "lane-stop", owner),
      event(root, 11, "Choose an answer", "question", owner),
    ];
    const stallLookback: Window = {
      start: new Date(window.start.getTime() - STALL_MS),
      end: window.end,
    };
    expect(analyzeEvidence(events, { window, stallLookback })).toEqual([]);
  });

  test("a sibling lane's stop never ends another lane's stall", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-sibling");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 8, "lane-1 implementing", "lane-start", owner),
      event(root, 8, "lane-2 implementing", "lane-start", owner),
      event(root, 6, "lane-2 closed", "lane-stop", owner),
    ];
    const findings = analyzeEvidence(events, { window });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("stall");
    expect(findings[0]?.quote).toBe("lane-1 implementing");
  });

  test("a stop only ends a start of its own kind", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-kind");
    const owner = instanceFor(root, 8080);
    const lane = [
      event(root, 8, "lane-1 implementing", "lane-start", owner),
      event(root, 6, "0001-first.md: resolved", "run-stop", owner),
    ];
    expect(analyzeEvidence(lane, { window }).map((finding) => finding.quote)).toEqual([
      "lane-1 implementing",
    ]);

    const run = [
      event(root, 8, "0001-first.md: First decision", "run-start", owner),
      event(root, 6, "lane-2 failed", "lane-stop", owner),
    ];
    const stalled = analyzeEvidence(run, { window }).filter(
      (finding) => finding.category === "stall",
    );
    expect(stalled.map((finding) => finding.quote)).toEqual(["0001-first.md: First decision"]);
  });

  test("two stalled lanes are two findings with distinct fingerprints", async () => {
    const root = await temporaryDirectory("test-watchdog-stall-pair");
    const owner = instanceFor(root, 8080);
    const events = [
      event(root, 8, "lane-1 implementing", "lane-start", owner),
      event(root, 8, "lane-2 implementing", "lane-start", owner),
    ];
    const findings = analyzeEvidence(events, { window });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.quote).sort()).toEqual([
      "lane-1 implementing",
      "lane-2 implementing",
    ]);
    expect(new Set(findings.map((finding) => finding.fingerprint)).size).toBe(2);
  });

  test("the same text on two dashboards is one fingerprint", async () => {
    const base = await temporaryDirectory("test-watchdog-shared");
    const first = instanceFor(base, 8080, join(base, "first"));
    const second = instanceFor(base, 8081, join(base, "second"));
    const journals = [first, second].map((instance) => {
      const journal = openJournal({
        stateDir: join(instance.harness, ".tmp"),
        repoDir: base,
        port: instance.port,
        now: () => fixedNow,
      });
      journal.write("server-error", SERVER_ERROR);
      return readJournalEvidence(instance, { window, root: base }).events;
    });
    const findings = analyzeEvidence(journals.flat(), { window });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toBe(
      createHash("sha256").update(`server-error\n${SERVER_ERROR}`).digest("hex").slice(0, 32),
    );
    expect(findings[0]?.instances.map((instance) => instance.port).sort()).toEqual([8080, 8081]);
  });
});

describe("filing", () => {
  test("files one issue per recorded filing and records it in the ledger", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();
    const { dedup, calls: dedupCalls } = dedupStub((request) => filedWithinRoom(request));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.exitCode).toBe(0);
    expect(result.report.action).toBe("filed");
    expect(dedupCalls).toHaveLength(1);
    expect(dedupCalls[0]?.request.filingRoom).toBe(2);
    // The coordinator never files: the peer's records are the only filings.
    expect(calls).toEqual([]);
    expect(result.report.issues).toHaveLength(2);

    const ledger = loadLedger(stateDir);
    for (const issue of result.report.issues) {
      const entry = ledger.findings[issue.fingerprint];
      expect(entry?.disposition).toBe(`filed:${issue.url}`);
      expect(entry?.url).toBe(issue.url);
      expect(entry?.filedAt).toBe(fixedNow.toISOString());
    }
    expect(ledger.pendingFiling).toEqual([]);

    expect(result.report.issues.map((issue) => issue.url).sort()).toEqual([
      "https://github.com/acme/fixture/issues/100",
      "https://github.com/acme/fixture/issues/101",
    ]);
    expect(result.report.issues.map((issue) => issue.line).sort()).toEqual(
      [SERVER_ERROR, "update install failed: checksum mismatch"].sort(),
    );

    expect(existsSync(join(stateDir, "latest.json"))).toBe(true);
    const latest = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
    expect(latest.action).toBe("filed");
    expect(latest.issues).toHaveLength(2);
    expect(result.runDir).toBeDefined();
    expect(existsSync(join(result.runDir as string, "report.json"))).toBe(true);
    expect(existsSync(join(result.runDir as string, "report.md"))).toBe(true);
    expect(existsSync(join(result.runDir as string, "coordinator.log"))).toBe(true);
  });

  test("each recorded filing is persisted before the next cycle reads the ledger", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh } = ghStub();

    const first = await runCycle(cycleFor(root, { events, gh }));
    expect(first.report.action).toBe("filed");
    expect(first.report.issues).toHaveLength(2);

    // The next cycle treats both as filed and asks the peer nothing.
    const neverAsked = dedupStub(() => new Error("a filed candidate reached the agent"));
    const later = await runCycle(
      cycleFor(root, {
        events,
        gh,
        dedup: neverAsked.dedup,
        now: new Date(fixedNow.getTime() + 23 * 60 * 60 * 1000),
      }),
    );
    expect(neverAsked.calls).toHaveLength(0);
    expect(later.report.action).toBe("duplicate");
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("a start in a cycle's final five minutes stalls in the next cycle", async () => {
    const { root } = await fixtureRepository();
    const instance = instanceFor(root, 8080);
    const tempDir = join(root, ".devboard", ".tmp");
    const started = new Date(fixedNow.getTime() - 4 * 60 * 1000);
    const journal = openJournal({
      stateDir: tempDir,
      repoDir: root,
      port: instance.port,
      now: () => started,
    });
    journal.write("lane-start", "lane-1 implementing");
    const { gh, calls } = ghStub();
    const deps: NonNullable<CycleOptions["deps"]> = {
      discover: () => [instance],
      collect: (target, instances, evidenceWindow) =>
        collectEvidence({
          root: target,
          instances,
          window: evidenceWindow,
          selfPids: new Set([process.pid]),
          logsDir: join(tempDir, "omp-logs"),
        }),
      gh,
      dedup: uniqueDedup(),
      delivery: deliveryStub(gh),
    };
    const runAt = (now: Date) =>
      runCycle({ root, now, stateDir: join(tempDir, "watchdog"), deps });

    const first = await runAt(fixedNow);
    expect(first.report.findings).toEqual([]);
    expect(first.report.action).toBe("none");
    expect(calls).toHaveLength(0);

    const second = await runAt(new Date(fixedNow.getTime() + WINDOW_MS));
    expect(second.report.findings.map((finding) => finding.category)).toEqual(["stall"]);
    expect(second.report.findings[0]?.quote).toBe("lane-1 implementing");
    expect(second.report.findings[0]?.ts).toBe(started.toISOString());
    expect(second.report.action).toBe("filed");
    expect(second.report.issues).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test("an unchanged window is a duplicate and makes no gh call", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const first = await runCycle(cycleFor(root, { events, gh }));
    expect(first.report.action).toBe("filed");
    expect(calls).toEqual([]);

    const second = await runCycle(cycleFor(root, { events, gh }));
    expect(second.report.action).toBe("duplicate");
    expect(second.report.issues).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a recurrence comments once after 24 hours and never closes", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const first = await runCycle(cycleFor(root, { events, gh }));
    const url = first.report.issues[0]?.url as string;
    const fingerprint = first.report.issues[0]?.fingerprint as string;

    const soon = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 23 * 60 * 60 * 1000) }),
    );
    expect(soon.report.action).toBe("duplicate");
    expect(calls).toEqual([]);

    const later = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000) }),
    );
    expect(later.report.action).toBe("commented");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["issue", "comment", url, "--body-file", "-"]);
    const body = calls[0]?.stdin ?? "";
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    expect(body).toContain(fingerprint);
    expect(body).toContain(`- Count: ${loadLedger(stateDir).findings[fingerprint]?.count}`);
    expect(body).toContain(`- Window: ${later.report.window.start} .. ${later.report.window.end}`);
    expect(body).toContain(
      `- Last seen: ${new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000).toISOString()}`,
    );
    expect(body).toContain(SERVER_ERROR);
    expect(body.trim()).not.toBe("-");
    expect(calls.some((call) => call.argv.join(" ").includes("--body -"))).toBe(false);
    expect(later.report.issues).toEqual([]);
    const ledger = loadLedger(join(root, ".devboard", ".tmp", "watchdog"));
    expect(ledger.findings[fingerprint]?.lastCommentAt).toBe(
      new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000).toISOString(),
    );
    expect(calls.some((call) => call.argv.includes("close"))).toBe(false);
    expect(calls.some((call) => call.argv.includes("create"))).toBe(false);
  });

  test("a rejected recurrence comment is not marked and is retried", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub((_call, index) =>
      index === 0 ? { code: 1, stderr: "HTTP 422: Validation failed\nsecond line" } : {},
    );
    const first = await runCycle(cycleFor(root, { events, gh }));
    const fingerprint = first.report.issues[0]?.fingerprint as string;
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");

    const rejected = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000) }),
    );
    expect(rejected.report.action).toBe("failed");
    expect(rejected.report.reason).toBe("HTTP 422: Validation failed");
    expect(calls[0]?.stdin).toContain(fingerprint);
    expect(loadLedger(stateDir).findings[fingerprint]?.lastCommentAt).toBeUndefined();

    const retried = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 26 * 60 * 60 * 1000) }),
    );
    expect(retried.report.action).toBe("commented");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.argv).toEqual([
      "issue",
      "comment",
      first.report.issues[0]?.url,
      "--body-file",
      "-",
    ]);
    expect(calls[1]?.stdin).toContain(fingerprint);
    expect(loadLedger(stateDir).findings[fingerprint]?.lastCommentAt).toBe(
      new Date(fixedNow.getTime() + 26 * 60 * 60 * 1000).toISOString(),
    );
  });

  test("a ledger issue filed through another forge is skipped, not failed", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const first = await runCycle(cycleFor(root, { events, gh }));
    const url = first.report.issues[0]?.url as string;
    const fingerprint = first.report.issues[0]?.fingerprint as string;
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");

    // The ledger survives a forge change; this one's issue is not served here.
    const foreign: WatchdogDelivery = {
      repository: "acme/fixture",
      owns: () => false,
      create: async () => {
        throw new Error("a filed finding must never be filed again");
      },
      comment: async () => {
        throw new Error("a URL the forge does not serve must never be commented on");
      },
      state: async () => undefined,
    };
    const later = await runCycle(
      cycleFor(root, {
        events,
        gh,
        delivery: foreign,
        now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000),
      }),
    );
    expect(later.exitCode).toBe(0);
    expect(later.report.action).toBe("skipped");
    expect(later.report.reason).toBe(
      "1 ledger issue URL(s) belong to another forge; no comment was made",
    );
    expect(later.report.unowned).toEqual([
      { url, category: "server-error", fingerprint },
    ]);
    // The issue was filed through the dedup tool record, not another gh call.
    expect(calls).toHaveLength(0);
    expect(loadLedger(stateDir).findings[fingerprint]?.lastCommentAt).toBeUndefined();
    const latest = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
    expect(latest.action).toBe("skipped");
    expect(latest.unowned).toEqual([{ url, category: "server-error", fingerprint }]);
    const markdown = readFileSync(join(later.runDir as string, "report.md"), "utf8");
    expect(markdown).toContain("## Issues on another forge");
    expect(markdown).toContain(url);
  });

  test("a failed filing tool retries the pending fingerprint before new ones", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const failed = dedupStub(() => ({
      records: [],
      error: "issue_create failed: HTTP 403: Resource not accessible by integration",
    }));

    const first = await runCycle(cycleFor(root, { events, gh, dedup: failed.dedup }));
    expect(first.report.action).toBe("failed");
    expect(first.report.reason).toContain("HTTP 403: Resource not accessible by integration");
    expect(first.exitCode).toBe(1);
    expect(first.report.issues).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(1);

    const second = await runCycle(cycleFor(root, { events, gh }));
    expect(second.report.action).toBe("filed");
    expect(second.report.issues).toHaveLength(1);
    expect(calls).toEqual([]);
    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toEqual([]);
    expect(Object.values(ledger.findings)[0]?.disposition).toBe(
      `filed:${second.report.issues[0]?.url}`,
    );
  });

  test("a delivery configuration failure keeps the finding pending and writes the reports", async () => {
    const { root } = await fixtureRepository();
    git(root, "remote", "set-url", "origin", "http://127.0.0.1:3001/acme/fixture.git");
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();

    const result = await runCycle({
      root,
      now: fixedNow,
      stateDir,
      deps: {
        discover: () => [instanceFor(root, 8080)],
        collect: () => ({ events, malformed: 0, unattributed: 0 }),
        gh,
        environment: {},
      },
    });
    const reason = "the watchdog needs GITEA_TOKEN for a Gitea origin";
    expect(result.exitCode).toBe(1);
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toBe(reason);
    expect(result.report.issues).toEqual([]);
    expect(calls).toEqual([]);

    const fingerprint = result.report.findings[0]?.fingerprint as string;
    const latest = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
    expect(latest.action).toBe("failed");
    expect(latest.reason).toBe(reason);
    expect(latest.findings[0]?.fingerprint).toBe(fingerprint);
    expect(result.runDir).toBeDefined();
    const runReport = JSON.parse(
      readFileSync(join(result.runDir as string, "report.json"), "utf8"),
    );
    expect(runReport.action).toBe("failed");
    expect(runReport.reason).toBe(reason);
    expect(existsSync(join(result.runDir as string, "report.md"))).toBe(true);

    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toEqual([fingerprint]);
    expect(ledger.findings[fingerprint]?.disposition).toBe("none");

    const retried = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 60 * 1000) }),
    );
    expect(retried.report.action).toBe("filed");
    expect(retried.report.issues).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("a dedup failure keeps the first diagnostic line and fails the cycle", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh } = ghStub();
    const failed = dedupStub(() => new Error("issue_create failed: HTTP 500\nsecond line"));
    const result = await runCycle(cycleFor(root, { events, gh, dedup: failed.dedup }));
    expect(result.exitCode).toBe(1);
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toBe(
      "the deduplication agent failed: issue_create failed: HTTP 500",
    );
  });

  test("dry run files nothing and leaves the state directory untouched", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const result = await runCycle(cycleFor(root, { events, gh, dryRun: true }));
    expect(result.exitCode).toBe(0);
    expect(result.report.action).toBe("none");
    expect(result.report.issues).toEqual([]);
    expect(result.runDir).toBeUndefined();
    expect(calls).toEqual([]);
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
    expect(existsSync(join(stateDir, "state.json"))).toBe(false);
  });
});

const ISSUE_URL = "https://github.com/acme/fixture/issues/501";

/** Every forge mutation the cycle made; a state read is not one. */
function forgeMutations(calls: GhCall[]): GhCall[] {
  return calls.filter(
    (call) =>
      call.argv[0] === "issue" && (call.argv[1] === "create" || call.argv[1] === "comment"),
  );
}

function stateDirFor(root: string): string {
  return join(root, ".devboard", ".tmp", "watchdog");
}

describe("deduplication gate", () => {
  function promptRequest(lines: string[]): DedupRequest {
    return {
      repository: "acme/fixture",
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      filingRoom: lines.length,
      candidates: lines.map((line, index) => ({
        fingerprint: `fingerprint-${index}`,
        category: "server-error",
        line,
        firstSeen: fixedNow.toISOString(),
        lastSeen: fixedNow.toISOString(),
        count: 1,
        instances: [],
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
      })),
    };
  }

  /** The candidate JSON the prompt carries, between the two fixed markers. */
  function candidatesBlock(prompt: string): string {
    const start = prompt.indexOf("The complete candidate set, as JSON");
    const end = prompt.indexOf("## Filing room");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(prompt.indexOf("\n\n", start) + 2, end).trim();
  }

  test("a candidate line containing $' reaches the prompt verbatim", () => {
    const line = "bash: $'\\r': command not found";
    const prompt = dedupPrompt(promptRequest([line]));
    const candidates = JSON.parse(candidatesBlock(prompt)) as { line: string }[];
    expect(candidates.map((candidate) => candidate.line)).toEqual([line]);
    expect(prompt).not.toContain("{{candidates}}");
    expect(prompt).toContain("at most 1 of these candidates");
  });

  test("$& and $` in a candidate line stay literal instead of splicing the prompt", () => {
    const lines = ["literal $& and $` sequences"];
    const prompt = dedupPrompt(promptRequest(lines));
    const block = candidatesBlock(prompt);
    expect(block).toContain("$&");
    expect(block).toContain("$`");
    expect(block).not.toContain("{{candidates}}");
    expect(JSON.parse(block)).toEqual(promptRequest(lines).candidates);
  });

  test("one request carries the whole candidate set before any create", async () => {
    const { root } = await fixtureRepository();
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(
        root,
        1,
        "update install failed: checksum mismatch",
        "update-error",
        instanceFor(root, 8080),
      ),
    ];
    const { gh, calls } = ghStub();
    const { dedup, calls: dedupCalls } = dedupStub(
      (request) => filedWithinRoom(request),
      { calls },
    );

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.exitCode).toBe(0);
    expect(dedupCalls).toHaveLength(1);
    expect(dedupCalls[0]?.createsBefore).toBe(0);
    const request = dedupCalls[0]?.request as DedupRequest;
    expect(request.repository).toBe("acme/fixture");
    expect(request.window.start).toBe(window.start.toISOString());
    expect(request.filingRoom).toBe(2);
    expect(request.candidates).toHaveLength(2);
    for (const candidate of request.candidates) {
      expect(candidate.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(candidate.category.length).toBeGreaterThan(0);
      expect(candidate.line.length).toBeGreaterThan(0);
      expect(candidate.firstSeen).toBe(fixedNow.toISOString());
      expect(candidate.lastSeen).toBe(fixedNow.toISOString());
      expect(candidate.count).toBe(1);
      expect(candidate.instances).toHaveLength(1);
      expect(candidate.window).toEqual({
        start: window.start.toISOString(),
        end: window.end.toISOString(),
      });
    }
    expect(result.report.deduplication.requested).toBe(2);
    expect(result.report.deduplication.decisions.map((entry) => entry.decision)).toEqual([
      "unique",
      "unique",
    ]);
    expect(result.report.issues).toHaveLength(2);
    // The coordinator only reads the peer's records; it never files itself.
    expect(forgeMutations(calls)).toEqual([]);
  });

  test("the request carries no issue list and the agent reports its own read", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh } = ghStub();
    const { dedup, calls } = dedupStub((request) => ({
      records: request.candidates.map((candidate) =>
        duplicateRecord(candidate, { issue: ISSUE_URL }),
      ),
      reads: [1],
    }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    const request = calls[0]?.request as DedupRequest;
    expect(Object.keys(request).sort()).toEqual([
      "candidates",
      "filingRoom",
      "repository",
      "window",
    ]);
    expect(JSON.stringify(request)).not.toContain(ISSUE_URL);
    expect(JSON.stringify(request)).not.toContain("open_issues");
    const prompt = dedupPrompt(request);
    expect(prompt).toContain(request.candidates[0]?.fingerprint as string);
    expect(prompt).not.toContain(ISSUE_URL);
    expect(result.report.deduplication.openIssuesRead).toBe(1);
  });

  test("a turn that read no open issue files nothing and fails the cycle", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub((request) => ({
      records: request.candidates.map((candidate, index) => filedRecord(candidate, 100 + index)),
    }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    const reason = "the deduplication turn read no open issue";
    expect(result.exitCode).toBe(1);
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toBe(reason);
    expect(result.report.issues).toEqual([]);
    expect(result.report.deduplication.openIssuesRead).toBe(0);
    expect(forgeMutations(calls)).toEqual([]);

    const fingerprint = result.report.findings[0]?.fingerprint as string;
    expect(result.report.deduplication.decisions).toHaveLength(1);
    expect(result.report.deduplication.decisions[0]?.fingerprint).toBe(fingerprint);
    expect(result.report.deduplication.decisions[0]?.decision).toBe("failed");
    expect(result.report.deduplication.decisions[0]?.reason).toBe(reason);

    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toEqual([fingerprint]);
    expect(ledger.findings[fingerprint]?.disposition).toBe("none");
    expect(ledger.findings[fingerprint]?.url).toBeUndefined();
    expect(result.report.pending).toBe(1);
  });

  test("a turn that read the open issues files the records it wrote", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh } = ghStub();
    const { dedup } = dedupStub((request) => {
      const candidate = request.candidates[0];
      if (candidate === undefined) throw new Error("missing candidate");
      return { records: [filedRecord(candidate, 100)], reads: [3] };
    });

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.exitCode).toBe(0);
    expect(result.report.action).toBe("filed");
    expect(result.report.issues).toHaveLength(1);
    expect(result.report.deduplication.openIssuesRead).toBe(3);
    expect(loadLedger(stateDirFor(root)).pendingFiling).toEqual([]);
  });

  test("a duplicate is silent, named in the report, and never filed in the ledger", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub((request) => ({
      records: request.candidates.map((candidate) =>
        duplicateRecord(candidate, { issue: ISSUE_URL }),
      ),
      reads: [1],
    }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.exitCode).toBe(0);
    expect(result.report.action).toBe("duplicate");
    expect(forgeMutations(calls)).toEqual([]);
    expect(result.report.issues).toEqual([]);
    const fingerprint = result.report.findings[0]?.fingerprint as string;
    const decision = result.report.deduplication.decisions[0];
    expect(decision?.fingerprint).toBe(fingerprint);
    expect(decision?.decision).toBe("duplicate");
    expect(decision?.issue).toBe(ISSUE_URL);
    expect(result.report.deduplication.openIssuesRead).toBe(1);

    const ledger = loadLedger(stateDir);
    expect(ledger.findings[fingerprint]?.disposition).toBe(`duplicate:${ISSUE_URL}`);
    expect(ledger.findings[fingerprint]?.duplicateOf).toBe(ISSUE_URL);
    expect(ledger.findings[fingerprint]?.url).toBeUndefined();
    expect(ledger.findings[fingerprint]?.filedAt).toBeUndefined();
    expect(ledger.findings[fingerprint]?.lastCommentAt).toBeUndefined();
    expect(ledger.pendingFiling).toEqual([]);

    const runReport = JSON.parse(
      readFileSync(join(result.runDir as string, "report.json"), "utf8"),
    ) as Report;
    expect(runReport.deduplication.decisions[0]?.issue).toBe(ISSUE_URL);
    expect(runReport.action).toBe("duplicate");
    expect(runReport.findings).toHaveLength(1);
    expect(runReport.issues).toEqual([]);
    expect(runReport.pending).toBe(0);
  });

  test("two candidates the agent marks duplicates of each other file one issue", async () => {
    const { root } = await fixtureRepository();
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub((request) => {
      const first = request.candidates[0];
      const second = request.candidates[1];
      if (first === undefined || second === undefined) throw new Error("missing candidates");
      return {
        records: [
          filedRecord(first, 100),
          duplicateRecord(second, { representative: first.fingerprint }),
        ],
        reads: [1],
      };
    });

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.report.action).toBe("filed");
    expect(result.report.issues).toHaveLength(1);
    expect(forgeMutations(calls)).toEqual([]);
    const representative = result.report.deduplication.decisions[0]?.fingerprint;
    const grouped = result.report.deduplication.decisions.find(
      (entry) => entry.decision === "duplicate",
    );
    expect(grouped?.representative).toBe(representative);
    expect(grouped?.issue).toBeUndefined();
    expect(result.report.issues[0]?.fingerprint).toBe(representative);
    expect(result.report.issues[0]?.line).toBe(SERVER_ERROR);
  });

  test("a filed record marks the ledger and never calls delivery.create", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub((request) => ({
      records: request.candidates.map((candidate, index) => filedRecord(candidate, 700 + index)),
      reads: [1],
    }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.report.action).toBe("filed");
    expect(forgeMutations(calls)).toEqual([]);
    expect(result.report.deduplication.decisions[0]?.decision).toBe("unique");
    expect(result.report.issues[0]?.url).toBe("https://github.com/acme/fixture/issues/700");
    expect(result.report.issues[0]?.line).toBe(SERVER_ERROR);

    const ledger = loadLedger(stateDir);
    const fingerprint = result.report.issues[0]?.fingerprint as string;
    expect(ledger.findings[fingerprint]?.disposition).toBe(
      `filed:${result.report.issues[0]?.url as string}`,
    );
    expect(ledger.findings[fingerprint]?.filedAt).toBe(fixedNow.toISOString());
    expect(ledger.pendingFiling).toEqual([]);
  });

  test("a failed dedup turn fails closed and retries the next cycle", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const cases: Array<{ label: string; dedup: Dedup }> = [
      {
        label: "cannot start",
        dedup: async () => {
          throw new Error("the deduplication agent needs an enabled OpenCode Go subscription");
        },
      },
      {
        label: "exits nonzero",
        dedup: async () => {
          throw new Error("Agent process exited before answering. (killed)");
        },
      },
      {
        label: "times out",
        dedup: async () => {
          throw new Error("the deduplication agent timed out after 240000ms");
        },
      },
    ];

    for (const entry of cases) {
      const { gh, calls } = ghStub();
      const result = await runCycle(cycleFor(root, { events, gh, dedup: entry.dedup }));
      const fingerprint = result.report.findings[0]?.fingerprint as string;
      expect(result.exitCode, entry.label).toBe(1);
      expect(result.report.action, entry.label).toBe("failed");
      expect(result.report.reason, entry.label).toContain("deduplication agent");
      expect(result.report.issues, entry.label).toEqual([]);
      expect(forgeMutations(calls), entry.label).toEqual([]);
      expect(
        result.report.deduplication.decisions.every(
          (decision) => decision.decision === "failed" && decision.reason !== undefined,
        ),
        entry.label,
      ).toBe(true);
      expect(loadLedger(stateDir).pendingFiling, entry.label).toContain(fingerprint);
      expect(loadLedger(stateDir).findings[fingerprint]?.disposition, entry.label).toBe("none");
    }

    const retried = await runCycle(
      cycleFor(root, {
        events,
        gh: ghStub().gh,
        dedup: uniqueDedup(),
        now: new Date(fixedNow.getTime() + 60 * 1000),
      }),
    );
    expect(retried.report.action).toBe("filed");
    expect(retried.report.issues).toHaveLength(1);
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("a turn that records nothing leaves every candidate pending", async () => {
    const { root } = await fixtureRepository();
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub(() => ({ records: [], reads: [1] }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.report.issues).toEqual([]);
    expect(forgeMutations(calls)).toEqual([]);
    expect(result.report.deduplication.decisions).toHaveLength(2);
    expect(
      result.report.deduplication.decisions.every(
        (entry) =>
          entry.decision === "failed" &&
          entry.reason === "the deduplication turn recorded no decision",
      ),
    ).toBe(true);
    const ledger = loadLedger(stateDirFor(root));
    expect(ledger.pendingFiling).toHaveLength(2);
    expect(Object.values(ledger.findings).every((entry) => entry.disposition === "none")).toBe(
      true,
    );
  });

  test("a record for an unknown fingerprint never files or suppresses a candidate", async () => {
    const { root } = await fixtureRepository();
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub(() => ({
      records: [
        {
          fingerprint: "ffffffffffffffffffffffffffffffff",
          action: "filed",
          number: 900,
          url: "https://github.com/acme/fixture/issues/900",
        },
      ],
      reads: [1],
    }));

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.report.issues).toEqual([]);
    expect(forgeMutations(calls)).toEqual([]);
    expect(result.report.deduplication.decisions).toHaveLength(2);
    expect(
      result.report.deduplication.decisions.every((entry) => entry.decision === "failed"),
    ).toBe(true);
    expect(loadLedger(stateDirFor(root)).pendingFiling).toHaveLength(2);
  });

  test("a tool error after a record leaves every candidate pending", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();
    const { dedup } = dedupStub((request) => {
      const first = request.candidates[0];
      if (first === undefined) throw new Error("missing candidate");
      return { records: [filedRecord(first, 300)], error: "issue_create failed: HTTP 500" };
    });

    const result = await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(result.exitCode).toBe(1);
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("issue_create failed: HTTP 500");
    expect(result.report.issues).toEqual([]);
    expect(forgeMutations(calls)).toEqual([]);
    expect(result.report.deduplication.decisions).toHaveLength(2);
    expect(
      result.report.deduplication.decisions.every((entry) => entry.decision === "failed"),
    ).toBe(true);
    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toHaveLength(2);
    expect(Object.values(ledger.findings).every((entry) => entry.disposition === "none")).toBe(
      true,
    );
  });

  test("an open match suppresses silently until it is closed", async () => {
    const { root } = await fixtureRepository();
    const stateDir = stateDirFor(root);
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const duplicate = dedupStub((request) => ({
      records: request.candidates.map((candidate) =>
        duplicateRecord(candidate, { issue: ISSUE_URL }),
      ),
      reads: [1],
    }));
    const first = await runCycle(
      cycleFor(root, {
        events,
        gh,
        dedup: duplicate.dedup,
        delivery: deliveryStub(gh, { [ISSUE_URL]: "open" }),
      }),
    );
    const fingerprint = first.report.findings[0]?.fingerprint as string;
    expect(first.report.action).toBe("duplicate");
    expect(forgeMutations(calls)).toEqual([]);

    // Still open: the candidate is suppressed without another agent call.
    const neverAsked = dedupStub(() => new Error("the suppressed candidate reached the agent"));
    const second = await runCycle(
      cycleFor(root, {
        events,
        gh,
        dedup: neverAsked.dedup,
        delivery: deliveryStub(gh, { [ISSUE_URL]: "open" }),
        now: new Date(fixedNow.getTime() + 60 * 1000),
      }),
    );
    expect(neverAsked.calls).toHaveLength(0);
    expect(second.report.action).toBe("duplicate");
    expect(second.report.deduplication.suppressed).toEqual([{ fingerprint, issue: ISSUE_URL }]);
    expect(second.report.deduplication.requested).toBe(0);
    expect(forgeMutations(calls)).toEqual([]);

    // Closed: the same evidence reaches the agent again and is filed.
    const unique = dedupStub((request) => filedWithinRoom(request));
    const third = await runCycle(
      cycleFor(root, {
        events,
        gh,
        dedup: unique.dedup,
        delivery: deliveryStub(gh, { [ISSUE_URL]: "closed" }),
        now: new Date(fixedNow.getTime() + 120 * 1000),
      }),
    );
    expect(unique.calls).toHaveLength(1);
    expect(unique.calls[0]?.request.candidates[0]?.fingerprint).toBe(fingerprint);
    expect(third.report.action).toBe("filed");
    expect(third.report.issues).toHaveLength(1);
    expect(forgeMutations(calls)).toEqual([]);
    expect(loadLedger(stateDir).findings[fingerprint]?.disposition).toMatch(/^filed:/);
  });

  test("the agent decides, never string similarity or a shared prefix", async () => {
    const { root } = await fixtureRepository();
    const firstLine = "Synthetic error: ENOTFOUND the model endpoint alpha";
    const secondLine = "Synthetic error: ENOTFOUND the model endpoint beta";
    const events = [
      event(root, 2, firstLine, "server-error", instanceFor(root, 8080)),
      event(root, 1, secondLine, "server-error", instanceFor(root, 8080)),
    ];

    // Different lines, agent says duplicates: one issue.
    const { gh, calls } = ghStub();
    const grouped = dedupStub((request) => {
      const first = request.candidates[0];
      const second = request.candidates[1];
      if (first === undefined || second === undefined) throw new Error("missing candidates");
      return {
        records: [
          filedRecord(first, 100),
          duplicateRecord(second, { representative: first.fingerprint }),
        ],
        reads: [1],
      };
    });
    const one = await runCycle(cycleFor(root, { events, gh, dedup: grouped.dedup }));
    expect(one.report.issues).toHaveLength(1);
    expect(forgeMutations(calls)).toEqual([]);

    // A long shared prefix, agent says unique: both are filed.
    const { root: other } = await fixtureRepository();
    const prefix = `Synthetic error: ${"x".repeat(60)}`;
    const longEvents = [
      event(other, 2, `${prefix} one`, "server-error", instanceFor(other, 8080)),
      event(other, 1, `${prefix} two`, "server-error", instanceFor(other, 8080)),
    ];
    const uniqueGh = ghStub();
    const unique = dedupStub((request) => filedWithinRoom(request));
    const both = await runCycle(
      cycleFor(other, { events: longEvents, gh: uniqueGh.gh, dedup: unique.dedup }),
    );
    expect(both.report.issues).toHaveLength(2);
    expect(forgeMutations(uniqueGh.calls)).toEqual([]);
  });

  test("the dedup pass reads records and the peer's MCP surface has exactly two writes", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const { dedup, calls: dedupCalls } = dedupStub((request) => ({
      records: request.candidates.map((candidate) =>
        duplicateRecord(candidate, { issue: ISSUE_URL }),
      ),
      reads: [1],
    }));
    await runCycle(cycleFor(root, { events, gh, dedup }));
    expect(dedupCalls).toHaveLength(1);
    expect(calls).toEqual([]);

    // The peer's MCP surface exposes the reads and exactly two writes.
    expect(DEDUP_TOOLS.map((tool) => tool.name)).toEqual([
      "issues_list",
      "issue_get",
      "issue_create",
      "watchdog_duplicate_record",
    ]);
    const fake: ForgeIssues = {
      forge: "gitea",
      repository: "acme/fixture",
      list: async () => [
        { number: 501, title: "open", state: "open", labels: [], url: ISSUE_URL, createdAt: null },
      ],
      listAll: async () => [
        { number: 501, title: "open", state: "open", labels: [], url: ISSUE_URL, createdAt: null },
      ],
      get: async (number) => ({
        number,
        title: "open",
        body: "body",
        state: "open",
        labels: [],
        url: ISSUE_URL,
        createdAt: null,
      }),
      ensureLabel: async () => {
        throw new Error("mutation");
      },
      create: async () => {
        throw new Error("mutation");
      },
      comment: async () => {
        throw new Error("mutation");
      },
      close: async () => {
        throw new Error("mutation");
      },
    };
    let out = "";
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "issue_close", arguments: { number: 501 } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "issues_list", arguments: { state: "closed" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "issues_list", arguments: { state: "open" } },
      },
    ];
    await startDedupStdio({
      issues: fake,
      environment: {},
      input: (async function* () {
        yield new TextEncoder().encode(requests.map((line) => JSON.stringify(line)).join("\n"));
      })(),
      output: {
        write: (text: string) => {
          out += text;
          return true;
        },
      },
      diagnostics: { write: () => true },
    });
    const replies = out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const listed = replies.find((reply) => reply.id === 2)?.result as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "issues_list",
      "issue_get",
      "issue_create",
      "watchdog_duplicate_record",
    ]);
    const writeAttempt = replies.find((reply) => reply.id === 3)?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(writeAttempt.isError).toBe(true);
    expect(writeAttempt.content[0]?.text).toContain("Unknown tool");
    const closedAttempt = replies.find((reply) => reply.id === 4)?.result as {
      isError?: boolean;
    };
    expect(closedAttempt.isError).toBe(true);
    const readAttempt = replies.find((reply) => reply.id === 5)?.result as {
      content: Array<{ text: string }>;
    };
    expect(readAttempt.content[0]?.text).toContain(ISSUE_URL);
  });

  test("issue_create validates the fingerprint first and reports an unrecorded filing", async () => {
    const created: string[] = [];
    const fake: ForgeIssues = {
      forge: "gitea",
      repository: "acme/fixture",
      list: async () => [],
      listAll: async () => [],
      get: async (number) => ({
        number,
        title: "open",
        body: "body",
        state: "open",
        labels: [],
        url: ISSUE_URL,
        createdAt: null,
      }),
      ensureLabel: async () => {},
      create: async (input) => {
        created.push(input.title);
        return {
          number: 601,
          title: input.title,
          body: input.body,
          state: "open",
          labels: input.labels ?? [],
          url: `${ISSUE_URL}/601`,
          createdAt: null,
        };
      },
      comment: async () => {},
      close: async () => {
        throw new Error("mutation");
      },
    };
    const call = async (
      arguments_: Record<string, unknown>,
      environment: Record<string, string | undefined>,
    ) => {
      let out = "";
      await startDedupStdio({
        issues: fake,
        environment,
        input: (async function* () {
          yield new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "issue_create", arguments: arguments_ },
            }),
          );
        })(),
        output: {
          write: (text: string) => {
            out += text;
            return true;
          },
        },
        diagnostics: { write: () => true },
      });
      const reply = JSON.parse(out.trim()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      return reply.result;
    };
    const base = await temporaryDirectory("test-watchdog-dedup-create");
    const runDir = join(base, "run");
    const candidate = { title: "Synthetic candidate", body: "## Summary\n\nEvidence.", labels: [] };
    const bare = { REPO_DIR: base, STATE_DIR: base };

    const missing = await call(candidate, bare);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("fingerprint");
    const empty = await call({ ...candidate, fingerprint: "" }, bare);
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain("fingerprint");
    expect(created).toEqual([]);

    // A valid call still files once and records the filing for its candidate.
    const filed = await call({ ...candidate, fingerprint: "fp-1" }, {
      ...bare,
      DEVBOARD_DEDUP_RUN_DIR: runDir,
    });
    expect(filed.isError).toBeUndefined();
    expect(created).toHaveLength(1);
    const records = readFileSync(join(runDir, "dedup-records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        fingerprint: "fp-1",
        action: "filed",
        number: 601,
        url: `${ISSUE_URL}/601`,
        title: candidate.title,
        at: expect.any(String),
      },
    ]);

    // A filing record the cycle cannot append names the issue that exists now.
    const unrecorded = await call({ ...candidate, fingerprint: "fp-2" }, bare);
    expect(unrecorded.isError).toBe(true);
    expect(unrecorded.content[0]?.text).toContain("#601");
    expect(unrecorded.content[0]?.text).toContain(`${ISSUE_URL}/601`);
    expect(created).toHaveLength(2);
  });

  test("issues_list reads past one page so the oldest open issue is visible", async () => {
    const root = await temporaryDirectory("test-watchdog-dedup-all");
    const stateDir = join(root, ".devboard", ".tmp");
    const runDir = join(stateDir, "runs", "cycle-1");
    await mkdir(stateDir, { recursive: true });
    const url = (number: number): string => `https://forge.test/acme/fixture/issues/${number}`;
    const newestFirst = Array.from({ length: 250 }, (_, index) => ({
      number: 250 - index,
      title: `open ${250 - index}`,
      state: "open" as const,
      labels: [],
      url: url(250 - index),
      createdAt: null,
    }));
    const oldest = newestFirst[newestFirst.length - 1];
    if (oldest === undefined) throw new Error("missing the oldest fixture issue");
    const fake: ForgeIssues = {
      forge: "gitea",
      repository: "acme/fixture",
      list: async (_state, limit = 100) => newestFirst.slice(0, limit),
      listAll: async () => newestFirst,
      get: async (number) => ({
        number,
        title: `open ${number}`,
        body: "body",
        state: "open",
        labels: [],
        url: url(number),
        createdAt: null,
      }),
      ensureLabel: async () => {
        throw new Error("mutation");
      },
      create: async () => {
        throw new Error("mutation");
      },
      comment: async () => {
        throw new Error("mutation");
      },
      close: async () => {
        throw new Error("mutation");
      },
    };
    const exchanges = async (
      issues: ForgeIssues,
      environment: Record<string, string>,
      requests: Array<Record<string, unknown>>,
    ): Promise<Array<Record<string, unknown>>> => {
      let out = "";
      await startDedupStdio({
        issues,
        repoDir: root,
        environment,
        input: (async function* () {
          yield new TextEncoder().encode(requests.map((line) => JSON.stringify(line)).join("\n"));
        })(),
        output: {
          write: (text: string) => {
            out += text;
            return true;
          },
        },
        diagnostics: { write: () => true },
      });
      return out
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const call = (id: number, name: string, args: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const replies = await exchanges(fake, { DEVBOARD_DEDUP_RUN_DIR: runDir }, [
      call(1, "issues_list", { state: "open" }),
      call(2, "issues_list", { state: "open", limit: 200 }),
      call(3, "watchdog_duplicate_record", { fingerprint: "fp-oldest", issue: oldest.url }),
    ]);
    const payload = (id: number): Record<string, unknown> => {
      const result = replies.find((reply) => reply.id === id)?.result as
        | { content: Array<{ text: string }> }
        | undefined;
      return JSON.parse(result?.content[0]?.text ?? "{}") as Record<string, unknown>;
    };
    const complete = payload(1) as {
      issues: Array<{ number: number }>;
      truncated: boolean;
    };
    expect(complete.issues).toHaveLength(250);
    expect(complete.issues.map((issue) => issue.number)).toContain(oldest.number);
    expect(complete.truncated).toBe(false);

    const page = payload(2) as { issues: Array<{ number: number }>; truncated: boolean };
    expect(page.issues).toHaveLength(200);
    expect(page.issues.map((issue) => issue.number)).not.toContain(oldest.number);
    expect(page.truncated).toBe(true);

    const recorded = payload(3);
    expect(recorded.decision).toBe("duplicate");
    expect(recorded.issue).toBe(oldest.url);
    const duplicateRecords = readFileSync(join(runDir, "dedup-records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(duplicateRecords).toEqual([
      expect.objectContaining({ fingerprint: "fp-oldest", action: "duplicate", issue: oldest.url }),
    ]);
    const readCounts = readFileSync(join(runDir, "dedup-reads.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { count: number }).count);
    expect(readCounts).toEqual([250, 200]);

    // A read stopped at the forge's page ceiling reports itself, never a full page.
    const capped = await exchanges(
      { ...fake, listAll: async () => Array.from({ length: GITEA_ISSUE_READ_MAX }, () => oldest) },
      {},
      [call(1, "issues_list", { state: "open" })],
    );
    const cappedResult = capped.find((reply) => reply.id === 1)?.result as {
      content: Array<{ text: string }>;
    };
    const cappedPayload = JSON.parse(cappedResult.content[0]?.text ?? "{}") as {
      issues: unknown[];
      truncated: boolean;
    };
    expect(cappedPayload.issues).toHaveLength(GITEA_ISSUE_READ_MAX);
    expect(cappedPayload.truncated).toBe(true);
  });

  test("the four captured omp warnings file at most one issue", async () => {
    const base = await temporaryDirectory("test-watchdog-dedup-omp");
    const logsDir = join(base, "logs");
    await mkdir(logsDir, { recursive: true });
    const instance = instanceFor(base, 8080);
    const error =
      "Error: Model stopped: error 400 Upstream request failed: This Go model requires " +
      "Global regions. Select Global in your workspace's Privacy settings to use it.\n" +
      "Upstream request failed: This Go model requires Global regions. Select Global in " +
      "your workspace's Privacy settings to use it. (type=server_error)";
    const skills = [
      "differential-conformance-testing",
      "drop-in-compatibility",
      "benchmark-methodology",
      "dependency-boundaries",
    ];
    const captures = [
      "1793310094896-1w6x8zcj4ly8q.json",
      "1793310094921-3urhboh3f1nj1.json",
      "1793310094935-33031adjcdxnc.json",
      "1793310094973-2314ufwemeqod.json",
    ];
    await writeFile(
      join(logsDir, "omp.2026-10-24.1.log"),
      skills
        .map((skill, index) =>
          JSON.stringify({
            timestamp: new Date(window.end.getTime() - (60 - index) * 1000).toISOString(),
            level: "warn",
            pid: 500,
            message: "Skill description compression failed",
            skill,
            error: `${error}\nraw-http-request=${join(logsDir, captures[index] as string)}`,
          }),
        )
        .join("\n"),
    );
    const collected = readOmpEvidence({
      logsDir,
      window,
      instances: [instance],
      selfPids: new Set([42]),
      processInfo: () => ({ ancestors: [instance.pid, 1] }),
    });
    expect(collected.events).toHaveLength(4);
    const events = collected.events;

    // An open issue already describes the failure: no create, no comment.
    const matched = dedupStub((request) => ({
      records: request.candidates.map((candidate) =>
        duplicateRecord(candidate, { issue: ISSUE_URL }),
      ),
      reads: [1],
    }));
    const matchedGh = ghStub();
    const matchedResult = await runCycle(
      cycleFor(base, { events, gh: matchedGh.gh, dedup: matched.dedup }),
    );
    expect(matchedResult.report.findings).toHaveLength(1);
    expect(matchedResult.report.deduplication.decisions).toHaveLength(1);
    expect(matchedResult.report.deduplication.decisions[0]?.decision).toBe("duplicate");
    expect(matchedResult.report.deduplication.decisions[0]?.issue).toBe(ISSUE_URL);
    expect(forgeMutations(matchedGh.calls)).toEqual([]);
    expect(matchedResult.report.action).toBe("duplicate");

    // No open issue matches: exactly one issue for the whole set.
    const uniqueGh = ghStub();
    const unique = dedupStub((request) => filedWithinRoom(request));
    const filed = await runCycle(
      cycleFor(base, {
        events,
        gh: uniqueGh.gh,
        dedup: unique.dedup,
        now: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
      }),
    );
    expect(filed.report.findings).toHaveLength(1);
    expect(filed.report.issues).toHaveLength(1);
    expect(forgeMutations(uniqueGh.calls)).toEqual([]);
    expect(filed.report.issues[0]?.line).not.toContain("raw-http-request");
  });
});

describe("fix pipeline removal", () => {
  test("a filing cycle leaves HEAD, the remote tip, worktrees, and status unchanged", async () => {
    const { root, origin } = await fixtureRepository();
    const before = {
      head: git(root, "rev-parse", "HEAD"),
      remote: git(origin, "rev-parse", "main"),
      worktrees: git(root, "worktree", "list"),
      status: git(root, "status", "--porcelain"),
      commits: git(root, "rev-list", "--count", "HEAD"),
    };
    const { gh, calls } = ghStub();
    const result = await runCycle(
      cycleFor(root, {
        events: [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))],
        gh,
      }),
    );
    expect(result.report.action).toBe("filed");
    expect(calls).toEqual([]);
    expect(git(root, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(origin, "rev-parse", "main")).toBe(before.remote);
    expect(git(root, "worktree", "list")).toBe(before.worktrees);
    expect(git(root, "status", "--porcelain")).toBe(before.status);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe(before.commits);
  });
});

describe("ledger migration", () => {
  test("a version 1 file is discarded and files nothing", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "state.json"), readFileSync(v1StateFixture, "utf8"));
    const versionOne = JSON.parse(readFileSync(v1StateFixture, "utf8")) as {
      version: number;
      findings: Record<string, { disposition: string }>;
    };
    expect(versionOne.version).toBe(1);
    expect(Object.values(versionOne.findings).every((entry) => entry.disposition.startsWith("blocked:")))
      .toBe(true);
    expect(loadLedger(stateDir)).toEqual(emptyLedger());

    const { gh, calls } = ghStub();
    const result = await runCycle(
      cycleFor(root, {
        events: [event(root, 2, "ADR 0001 resolved cleanly", "activity")],
        gh,
      }),
    );
    expect(calls).toEqual([]);
    expect(result.report.action).toBe("none");
    expect(result.report.findings).toEqual([]);

    const saved = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as {
      version: number;
      findings: Record<string, unknown>;
      pendingFiling: string[];
      pendingPublish?: unknown;
    };
    expect(saved.version).toBe(2);
    expect(saved.findings).toEqual({});
    expect(saved.pendingFiling).toEqual([]);
    expect("pendingPublish" in saved).toBe(false);
  });
});

describe("cycle lease", () => {
  test("serializes watchdog cycles across versions and reclaims a stale claim", async () => {
    const base = await temporaryDirectory("test-watchdog-claim");
    const path = cycleClaimPath(base);
    const first = claimCycle(path, { harnessVersion: "0.1.1" });
    expect(first).toBeDefined();
    expect(claimCycle(path, { harnessVersion: "0.1.2" })).toBeUndefined();
    expect(liveCycleClaim(path)?.harnessVersion).toBe("0.1.1");
    first?.release();
    expect(readCycleClaim(path)).toBeUndefined();

    await writeFile(
      path,
      JSON.stringify({
        pid: 999999,
        startedAt: new Date().toISOString(),
        harnessVersion: null,
        token: "stale",
      }),
    );
    const reclaimed = claimCycle(path, { harnessVersion: "0.1.2" });
    expect(reclaimed).toBeDefined();
    expect(readCycleClaim(path)?.harnessVersion).toBe("0.1.2");
    reclaimed?.release();
  });

  test("a drained worker finishes its in-flight cycle, exits, and releases its version lock", async () => {
    const root = await temporaryDirectory("test-watchdog-drain");
    const stateDir = join(root, "watchdog");
    const gate = Promise.withResolvers<void>();
    const cycleStarted = Promise.withResolvers<void>();
    let cycles = 0;
    const cycle = async (): Promise<{ report: { action: string } }> => {
      cycles += 1;
      cycleStarted.resolve();
      await gate.promise;
      return { report: { action: "none" } };
    };
    const oldWorker = runWorker({
      root,
      stateDir,
      ownerStateDir: join(root, "state"),
      harnessVersion: "0.1.1",
      cycle,
      pollMs: 20,
    });
    // The newer worker starts while the older one's cycle is in flight. It
    // must not claim a second cycle for the same window.
    const newWorker = runWorker({
      root,
      stateDir,
      ownerStateDir: join(root, "state"),
      harnessVersion: "0.1.2",
      cycle,
      pollMs: 20,
    });
    await cycleStarted.promise;
    expect(cycles).toBe(1);
    // The in-flight cycle belongs to the older version and is claimed once.
    expect(readCycleClaim(cycleClaimPath(stateDir))?.harnessVersion).toBe("0.1.1");
    const oldState = readWorkerState(versionedWorkerDirectory(stateDir, "0.1.1"));
    const newState = readWorkerState(versionedWorkerDirectory(stateDir, "0.1.2"));
    expect(oldState?.lifecycle).toBe("running");
    expect(newState?.lifecycle).toBe("running");
    expect(newState?.lastRunAt).toBe(oldState?.lastRunAt);
    expect(existsSync(versionedLockPath(stateDir, "0.1.1"))).toBe(true);
    expect(existsSync(versionedLockPath(stateDir, "0.1.2"))).toBe(true);

    writeWatchdogCommand(versionedControlDirectory(stateDir, "0.1.1"), { type: "drain" });
    gate.resolve();
    await oldWorker;

    expect(cycles).toBe(1);
    const drained = readWorkerState(versionedWorkerDirectory(stateDir, "0.1.1"));
    expect(drained?.lifecycle).toBe("stopped");
    expect(drained?.draining).toBe(true);
    expect(existsSync(versionedLockPath(stateDir, "0.1.1"))).toBe(false);
    expect(readCycleClaim(cycleClaimPath(stateDir))).toBeUndefined();
    // The newer version is the remaining live worker.
    expect(existsSync(versionedLockPath(stateDir, "0.1.2"))).toBe(true);

    writeWatchdogCommand(versionedControlDirectory(stateDir, "0.1.2"), { type: "stop" });
    await newWorker;
    expect(existsSync(versionedLockPath(stateDir, "0.1.2"))).toBe(false);
  });

  test("normalizes evidence lines without their timestamps", () => {
    expect(normalizeEvidenceLine("2026-10-24T12:00:00.000Z  an error   here")).toBe(
      "an error here",
    );
  });
});

describe("watchdog filing caps", () => {
  const owner = (root: string) => instanceFor(root, 8080);
  const twoFindings = (root: string): EvidenceEvent[] => [
    event(root, 2, "first capped error", "server-error", owner(root)),
    event(root, 1, "second capped error", "server-error", owner(root)),
  ];
  const okProjection = (stateDir: string): void => {
    writeProjection(stateDir, {
      version: 1,
      state: "ok",
      at: fixedNow.toISOString(),
      error: null,
      issues: [],
    });
  };

  test("both empty files every finding exactly as before", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    okProjection(stateDir);
    const { gh, calls } = ghStub();
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        settings: { ...DEFAULT_WATCHDOG_SETTINGS },
      }),
    );
    expect(result.report.issues).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("an hourly cap files the room and keeps the rest pending", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    okProjection(stateDir);
    const { gh, calls } = ghStub();
    const dedup = dedupStub((request) => filedWithinRoom(request));
    const first = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        dedup: dedup.dedup,
        settings: { intervalMinutes: 10, maxPerHour: 1, maxPending: null },
      }),
    );
    expect(first.report.issues).toHaveLength(1);
    expect(dedup.calls[0]?.request.filingRoom).toBe(1);
    expect(calls).toEqual([]);
    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toHaveLength(1);

    const second = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        dedup: dedup.dedup,
        settings: { intervalMinutes: 10, maxPerHour: 1, maxPending: null },
      }),
    );
    expect(second.report.issues).toEqual([]);
    expect(second.report.action).toBe("capped");
    expect(dedup.calls[1]?.request.filingRoom).toBe(0);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test("an open cap counts the last successful projection", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    writeProjection(stateDir, {
      version: 1,
      state: "ok",
      at: fixedNow.toISOString(),
      error: null,
      issues: [{ url: "https://github.com/acme/fixture/issues/1", state: "pending", version: null }],
    });
    const { gh, calls } = ghStub();
    const dedup = dedupStub((request) => filedWithinRoom(request));
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        dedup: dedup.dedup,
        settings: { intervalMinutes: 10, maxPerHour: null, maxPending: 1 },
      }),
    );
    expect(result.report.issues).toEqual([]);
    expect(dedup.calls[0]?.request.filingRoom).toBe(0);
    expect(calls).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(2);
  });

  test("an unreadable row counts as open against the pending cap", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    writeProjection(stateDir, {
      version: 1,
      state: "ok",
      at: fixedNow.toISOString(),
      error: null,
      issues: [
        { url: "https://github.com/acme/fixture/issues/377", state: "unreadable", version: null },
      ],
    });
    const { gh, calls } = ghStub();
    const dedup = dedupStub((request) => filedWithinRoom(request));
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        dedup: dedup.dedup,
        settings: { intervalMinutes: 10, maxPerHour: null, maxPending: 1 },
      }),
    );
    expect(result.report.issues).toEqual([]);
    expect(dedup.calls[0]?.request.filingRoom).toBe(0);
    expect(calls).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(2);
  });

  test("files nothing new while a cap is set and the projection is not ok", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    writeProjection(stateDir, {
      version: 1,
      state: "error",
      at: null,
      error: "gh: authentication failed",
      issues: [],
    });
    const { gh, calls } = ghStub();
    const dedup = dedupStub((request) => filedWithinRoom(request));
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        dedup: dedup.dedup,
        settings: { intervalMinutes: 10, maxPerHour: 5, maxPending: 5 },
      }),
    );
    expect(result.report.issues).toEqual([]);
    expect(dedup.calls[0]?.request.filingRoom).toBe(0);
    expect(calls).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(2);
    expect(result.report.reason).toContain("projection is not ok");
  });

  test("never caps a recurrence comment", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, SERVER_ERROR, "server-error", owner(root))];
    const { gh, calls } = ghStub();
    const first = await runCycle(cycleFor(root, { events, gh }));
    const url = first.report.issues[0]?.url as string;
    writeProjection(stateDir, {
      version: 1,
      state: "ok",
      at: fixedNow.toISOString(),
      error: null,
      issues: [{ url, state: "pending", version: null }],
    });
    const later = await runCycle(
      cycleFor(root, {
        events,
        gh,
        now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000),
        settings: { intervalMinutes: 10, maxPerHour: null, maxPending: 1 },
      }),
    );
    expect(later.report.action).toBe("commented");
    expect(calls.filter((call) => call.argv.includes("comment"))).toHaveLength(1);
  });
});

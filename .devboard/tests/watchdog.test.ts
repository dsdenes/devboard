import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
import { acquireLock } from "../watchdog/lock";
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
} from "../watchdog/coordinator";

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

function cycleFor(
  root: string,
  options: {
    events: EvidenceEvent[];
    gh: GhRun;
    now?: Date;
    dryRun?: boolean;
    settings?: WatchdogSettings;
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
      delivery: {
        repository: "acme/fixture",
        create: async (input) => createIssue(options.gh, "acme/fixture", input),
        comment: async (url, input) => commentIssue(options.gh, url, input),
      },
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
  test("files one issue per new fingerprint and records it in the ledger", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const { gh, calls } = ghStub();

    const result = await runCycle(cycleFor(root, { events, gh }));
    expect(result.exitCode).toBe(0);
    expect(result.report.action).toBe("filed");
    expect(calls).toHaveLength(2);
    expect(result.report.issues).toHaveLength(2);

    const ledger = loadLedger(stateDir);
    for (const issue of result.report.issues) {
      const entry = ledger.findings[issue.fingerprint];
      expect(entry?.disposition).toBe(`filed:${issue.url}`);
      expect(entry?.url).toBe(issue.url);
      expect(entry?.filedAt).toBe(fixedNow.toISOString());
      expect(calls.some((call) => call.stdin.includes(issue.fingerprint))).toBe(true);
    }
    expect(ledger.pendingFiling).toEqual([]);

    for (const call of calls) {
      expect(call.argv.slice(0, 5)).toEqual([
        "issue",
        "create",
        "--repo",
        "acme/fixture",
        "--title",
      ]);
      expect(call.argv.slice(5)).toEqual([expect.any(String), "--body-file", "-"]);
      const title = call.argv[5] ?? "";
      expect(
        title.startsWith("[watchdog] server-error:") ||
          title.startsWith("[watchdog] update-error:"),
      ).toBe(true);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.includes("\n")).toBe(false);
    }

    const serverError = calls.find((call) => call.stdin.includes(SERVER_ERROR));
    const body = serverError?.stdin ?? "";
    const fingerprint = result.report.issues.find(
      (issue) => issue.category === "server-error",
    )?.fingerprint;
    expect(fingerprint).toBeDefined();
    expect(body).toContain(`- Category: \`server-error\``);
    expect(body).toContain(`- Fingerprint: \`${fingerprint}\``);
    expect(body).toContain(SERVER_ERROR);
    expect(body).toContain(`- First seen: ${fixedNow.toISOString()}`);
    expect(body).toContain(`- Last seen: ${fixedNow.toISOString()}`);
    expect(body).toContain("- Count: 1");
    expect(body).toContain(window.start.toISOString());
    expect(body).toContain(window.end.toISOString());
    expect(body).toContain(join(root, ".devboard", ".tmp", "watchdog", "runs"));
    expect(body).toContain(root);
    expect(body).toContain("port 8080");
    expect(body).toContain(`pid ${instanceFor(root, 8080).pid}`);
    expect(body).toContain(`journal \`${instanceFor(root, 8080).journal}\``);

    expect(existsSync(join(stateDir, "latest.json"))).toBe(true);
    const latest = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
    expect(latest.action).toBe("filed");
    expect(latest.issues).toHaveLength(2);
    expect(result.runDir).toBeDefined();
    expect(existsSync(join(result.runDir as string, "report.json"))).toBe(true);
    expect(existsSync(join(result.runDir as string, "report.md"))).toBe(true);
    expect(existsSync(join(result.runDir as string, "coordinator.log"))).toBe(true);
  });

  test("persists each filing and comment before the next forge call", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [
      event(root, 2, SERVER_ERROR, "server-error", instanceFor(root, 8080)),
      event(root, 1, "update install failed: checksum mismatch", "update-error"),
    ];
    const filedBeforeSecondCall: number[] = [];
    const commentedBeforeSecondComment: number[] = [];
    const { gh } = ghStub((_call, index) => {
      if (index === 1) {
        filedBeforeSecondCall.push(
          Object.values(loadLedger(stateDir).findings).filter((entry) =>
            entry.disposition.startsWith("filed:"),
          ).length,
        );
      }
      if (index === 3) {
        commentedBeforeSecondComment.push(
          Object.values(loadLedger(stateDir).findings).filter(
            (entry) => entry.lastCommentAt !== undefined,
          ).length,
        );
      }
      return {};
    });

    const first = await runCycle(cycleFor(root, { events, gh }));
    expect(first.report.action).toBe("filed");
    expect(first.report.issues).toHaveLength(2);
    expect(filedBeforeSecondCall).toEqual([1]);

    const later = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000) }),
    );
    expect(later.report.action).toBe("commented");
    expect(later.report.issues).toEqual([]);
    expect(commentedBeforeSecondComment).toEqual([1]);
    const ledger = loadLedger(stateDir);
    expect(
      Object.values(ledger.findings).filter((entry) => entry.lastCommentAt !== undefined),
    ).toHaveLength(2);
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
      delivery: {
        repository: "acme/fixture",
        create: async (input) => createIssue(gh, "acme/fixture", input),
        comment: async (url, input) => commentIssue(gh, url, input),
      },
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
    expect(calls).toHaveLength(1);
  });

  test("an unchanged window is a duplicate and makes no gh call", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub();
    const first = await runCycle(cycleFor(root, { events, gh }));
    expect(first.report.action).toBe("filed");
    expect(calls).toHaveLength(1);

    const second = await runCycle(cycleFor(root, { events, gh }));
    expect(second.report.action).toBe("duplicate");
    expect(second.report.issues).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1);

    const later = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000) }),
    );
    expect(later.report.action).toBe("commented");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.argv).toEqual(["issue", "comment", url, "--body-file", "-"]);
    const body = calls[1]?.stdin ?? "";
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
    expect(calls.some((call) => call.argv.includes("create"))).toBe(true);
    expect(calls.filter((call) => call.argv.includes("create"))).toHaveLength(1);
  });

  test("a rejected recurrence comment is not marked and is retried", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub((_call, index) =>
      index === 1 ? { code: 1, stderr: "HTTP 422: Validation failed\nsecond line" } : {},
    );
    const first = await runCycle(cycleFor(root, { events, gh }));
    const fingerprint = first.report.issues[0]?.fingerprint as string;
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");

    const rejected = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000) }),
    );
    expect(rejected.report.action).toBe("failed");
    expect(rejected.report.reason).toBe("HTTP 422: Validation failed");
    expect(calls[1]?.stdin).toContain(fingerprint);
    expect(loadLedger(stateDir).findings[fingerprint]?.lastCommentAt).toBeUndefined();

    const retried = await runCycle(
      cycleFor(root, { events, gh, now: new Date(fixedNow.getTime() + 26 * 60 * 60 * 1000) }),
    );
    expect(retried.report.action).toBe("commented");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.argv).toEqual([
      "issue",
      "comment",
      first.report.issues[0]?.url,
      "--body-file",
      "-",
    ]);
    expect(calls[2]?.stdin).toContain(fingerprint);
    expect(loadLedger(stateDir).findings[fingerprint]?.lastCommentAt).toBe(
      new Date(fixedNow.getTime() + 26 * 60 * 60 * 1000).toISOString(),
    );
  });

  test("a failed gh call retries the pending fingerprint before new ones", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const { gh, calls } = ghStub((_call, index) =>
      index === 0
        ? { code: 1, stderr: "HTTP 403: Resource not accessible by integration\nsecond line" }
        : {},
    );

    const first = await runCycle(cycleFor(root, { events, gh }));
    expect(first.report.action).toBe("failed");
    expect(first.report.reason).toBe("HTTP 403: Resource not accessible by integration");
    expect(first.exitCode).toBe(1);
    expect(first.report.issues).toEqual([]);
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(1);

    const second = await runCycle(cycleFor(root, { events, gh }));
    expect(second.report.action).toBe("filed");
    expect(second.report.issues).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.argv.includes("create"))).toHaveLength(2);
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
    expect(calls).toHaveLength(1);
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("a timed-out gh call is a failure with a bounded reason", async () => {
    const { root } = await fixtureRepository();
    const events = [event(root, 1, SERVER_ERROR, "server-error", instanceFor(root, 8080))];
    const timedOut = await runCycle(
      cycleFor(root, {
        events,
        gh: ghStub(() => ({ code: 1, timedOut: true, stderr: "the command timed out\n" })).gh,
      }),
    );
    expect(timedOut.report.action).toBe("failed");
    expect(timedOut.report.reason).toBe("the command timed out");

    const { root: silent } = await fixtureRepository();
    const noDiagnostic = await runCycle(
      cycleFor(silent, {
        events,
        gh: ghStub(() => ({ code: 1, timedOut: true, stderr: "" })).gh,
      }),
    );
    expect(noDiagnostic.report.reason).toBe("gh timed out");

    const { root: long } = await fixtureRepository();
    const truncated = await runCycle(
      cycleFor(long, {
        events,
        gh: ghStub(() => ({ code: 1, stderr: `${"y".repeat(400)}\nnext line` })).gh,
      }),
    );
    expect(truncated.report.reason?.length).toBe(300);
    expect(truncated.report.reason?.endsWith("…")).toBe(true);
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
    expect(calls).toHaveLength(1);
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

describe("singleton", () => {
  test("serializes invocations and reclaims a stale lock", async () => {
    const base = await temporaryDirectory("test-watchdog-lock");
    const path = join(base, "lock");
    const first = acquireLock(path);
    expect(first.acquired).toBe(true);
    const second = acquireLock(path);
    expect(second.acquired).toBe(false);
    if (first.acquired) first.release();

    await writeFile(path, "999999\n");
    const reclaimed = acquireLock(path);
    expect(reclaimed.acquired).toBe(true);
    if (reclaimed.acquired) reclaimed.release();
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
    expect(calls.filter((call) => call.argv.includes("create"))).toHaveLength(2);
    expect(loadLedger(stateDir).pendingFiling).toEqual([]);
  });

  test("an hourly cap files the room and keeps the rest pending", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    okProjection(stateDir);
    const { gh, calls } = ghStub();
    const first = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        settings: { intervalMinutes: 10, maxPerHour: 1, maxPending: null },
      }),
    );
    expect(first.report.issues).toHaveLength(1);
    expect(calls.filter((call) => call.argv.includes("create"))).toHaveLength(1);
    const ledger = loadLedger(stateDir);
    expect(ledger.pendingFiling).toHaveLength(1);

    const second = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        settings: { intervalMinutes: 10, maxPerHour: 1, maxPending: null },
      }),
    );
    expect(second.report.issues).toEqual([]);
    expect(second.report.action).toBe("capped");
    expect(loadLedger(stateDir).pendingFiling).toHaveLength(1);
    expect(calls.filter((call) => call.argv.includes("create"))).toHaveLength(1);
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
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        settings: { intervalMinutes: 10, maxPerHour: null, maxPending: 1 },
      }),
    );
    expect(result.report.issues).toEqual([]);
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
    const result = await runCycle(
      cycleFor(root, {
        events: twoFindings(root),
        gh,
        settings: { intervalMinutes: 10, maxPerHour: 5, maxPending: 5 },
      }),
    );
    expect(result.report.issues).toEqual([]);
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

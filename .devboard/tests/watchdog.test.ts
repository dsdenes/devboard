import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Instance, ProcessSnapshot } from "../watchdog/discovery";
import {
  instancesFromProcesses,
  legacyLogPath,
  posixCksum,
} from "../watchdog/discovery";
import { journalFile } from "../server/journal";
import {
  normalizeEvidenceLine,
  readJournalEvidence,
  readLegacyEvidence,
  readOmpEvidence,
  type EvidenceEvent,
  type Window,
} from "../watchdog/collect";
import { analyzeEvidence } from "../watchdog/findings";
import { acquireLock } from "../watchdog/lock";
import { loadLedger } from "../watchdog/ledger";
import {
  runCycle,
  type CycleDeps,
  type IntegrateOutcome,
} from "../watchdog/coordinator";

/**
 * Every fixture lives under the repository's `.devboard/.tmp`. The tests use a
 * real git repository for the merge machinery but never touch a remote, the
 * network, or a model.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(harnessRoot, "..");
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

async function fixtureRepository(): Promise<{ root: string; harness: string }> {
  const base = await temporaryDirectory("test-watchdog-repo");
  const root = join(base, "repo");
  const harness = join(root, ".devboard");
  await mkdir(harness, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Harness instructions\n");
  await writeFile(join(root, ".gitignore"), ".devboard/.tmp/\n.worktree/\n");
  await writeFile(join(harness, "README.md"), "# Harness\n");
  await writeFile(join(harness, "marker.txt"), "baseline\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "devboard@example.test");
  git(root, "config", "user.name", "Devboard Test");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
  return { root, harness };
}

function instanceFor(root: string, port: number, harness = join(root, ".devboard")): Instance {
  return {
    pid: 4000 + port,
    port,
    repoDir: root,
    host: "127.0.0.1",
    harness,
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
): EvidenceEvent {
  return {
    source: join(root, ".devboard", ".tmp", "journal", "fixture.jsonl"),
    kind,
    ts: new Date(fixedNow.getTime() - minutesAgo * 60 * 1000).toISOString(),
    text,
    ...(owner === undefined ? {} : { instance: owner }),
  };
}

const SENTINELS = [
  "synthetic error: ENOTFOUND the model endpoint",
  "command failed: bun run build exited with code 1",
  "retrying after a transient failure",
  "BLOCKER: cannot proceed without the operator",
  "I am not sure which config is correct; this is confusing",
];

function stubDeps(
  root: string,
  events: EvidenceEvent[],
  overrides: Partial<CycleDeps> & {
    onAgent?: (worktree: string) => void;
    onIntegrate?: () => void;
  } = {},
): { deps: Partial<CycleDeps>; counts: { agent: number; gate: number; integrate: number } } {
  const instance = instanceFor(root, 8080);
  const counts = { agent: 0, gate: 0, integrate: 0, publish: 0 };
  const deps: Partial<CycleDeps> = {
    discover: () => [instance],
    collect: () => ({ events, malformed: 0, unattributed: 0 }),
    agent: async (_prompt, worktree) => {
      counts.agent += 1;
      overrides.onAgent?.(worktree);
      return { code: 0, stdout: "", stderr: "" };
    },
    gate: async () => {
      counts.gate += 1;
      return { ok: true };
    },
    integrate: async (): Promise<IntegrateOutcome> => {
      counts.integrate += 1;
      overrides.onIntegrate?.();
      return { ok: true, commit: "a".repeat(40), pushed: true, refreshed: 1, deferred: [] };
    },
    publish: async () => {
      counts.publish += 1;
      return { ok: true, refreshed: 1, deferred: [] };
    },
    ...overrides,
  };
  return { deps, counts };
}

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

  test("reads a legacy log only while it is inside the window", async () => {
    const base = await temporaryDirectory("test-watchdog-legacy");
    const harness = join(base, "harness");
    await mkdir(join(harness, ".tmp"), { recursive: true });
    const instance = instanceFor(base, 8080, harness);
    const legacy = legacyLogPath(harness, base);
    await writeFile(legacy, "legacy failure line\n");
    await utimes(legacy, window.end, window.end);
    const instanceWithLegacy = { ...instance, legacyLog: legacy };
    expect(
      readLegacyEvidence(instanceWithLegacy, { window }).map((item) => item.text),
    ).toEqual(["legacy failure line"]);
    const old = new Date(window.start.getTime() - 60_000);
    await utimes(legacy, old, old);
    expect(readLegacyEvidence(instanceWithLegacy, { window })).toEqual([]);
  });

  test("includes an in-window omp error and drops self and unrelated lines", async () => {
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
        level: "error",
        pid: 502,
        sessionId: "self-session",
        message: "watchdog session error",
      }),
      "{not json",
    ];
    const logPath = join(logsDir, "omp.2026-10-24.1.log");
    await writeFile(logPath, records.join("\n"));
    await utimes(logPath, window.end, window.end);

    const collected = readOmpEvidence({
      logsDir,
      window,
      instances: [instance],
      selfPids: new Set([42]),
      selfSessions: new Set(["self-session"]),
      processInfo: (pid) =>
        pid === 500
          ? { cwd: base, ancestors: [] }
          : pid === 501
            ? { cwd: "/elsewhere", ancestors: [] }
            : { cwd: base, ancestors: [] },
    });

    expect(collected.events.map((item) => item.text)).toEqual(["connection error"]);
    expect(collected.events[0]?.instance).toEqual(instance);
    expect(collected.unattributed).toBe(1);
    expect(collected.malformed).toBe(1);
  });
});

describe("findings", () => {
  test("produces one finding per synthetic signal", async () => {
    const root = await temporaryDirectory("test-watchdog-findings");
    const events = SENTINELS.map((text, index) => event(root, index + 1, text));
    const findings = analyzeEvidence(events, { root, window });
    expect(findings.map((finding) => finding.category).sort()).toEqual([
      "blocker",
      "confusion",
      "error",
      "failed-command",
      "retry",
    ]);
    expect(findings.every((finding) => finding.quote.length > 0)).toBe(true);
    expect(
      findings.every((finding) => finding.source === ".devboard/.tmp/journal/fixture.jsonl"),
    ).toBe(true);
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
    const findings = analyzeEvidence(events, { root, window });
    expect(findings.map((finding) => finding.category)).toEqual(["stall", "question-loop"]);
  });

  test("invents nothing from a clean window", async () => {
    const root = await temporaryDirectory("test-watchdog-clean");
    const findings = analyzeEvidence([event(root, 2, "ADR 0001 resolved cleanly")], {
      root,
      window,
    });
    expect(findings).toEqual([]);
  });
});

describe("cycle", () => {
  test("records a no-op for a clean window", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const before = git(root, "rev-parse", "HEAD");
    const { deps, counts } = stubDeps(root, []);
    const result = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(result.report.action).toBe("none");
    expect(result.report.reason).toBe("no actionable finding");
    expect(result.exitCode).toBe(0);
    expect(counts).toEqual({ agent: 0, gate: 0, integrate: 0, publish: 0 });
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  test("runs with zero dashboards", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const { deps, counts } = stubDeps(root, []);
    const result = await runCycle({
      root,
      now: fixedNow,
      stateDir,
      deps: {
        ...deps,
        discover: () => [],
        collect: () => ({ events: [], malformed: 0, unattributed: 0 }),
      },
    });
    expect(result.report.instances).toEqual([]);
    expect(result.report.findings).toEqual([]);
    expect(result.report.action).toBe("none");
    expect(result.exitCode).toBe(0);
    expect(counts.agent).toBe(0);
  });

  test("publishes once and reports the same window as duplicate", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    const { deps, counts } = stubDeps(root, events, {
      onAgent(worktree) {
        writeFileSync(join(worktree, ".devboard", "healed.txt"), "fixed\n");
      },
    });

    const first = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(first.report.action).toBe("published");
    expect(first.report.commit).toBe("a".repeat(40));
    expect(first.report.dashboards).toEqual({ refreshed: 1, deferred: [] });
    expect(counts).toEqual({ agent: 1, gate: 1, integrate: 1, publish: 0 });
    const runDir = first.runDir as string;
    expect(existsSync(join(runDir, "report.json"))).toBe(true);
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
    expect(existsSync(join(runDir, "coordinator.log"))).toBe(true);
    expect(existsSync(join(stateDir, "latest.json"))).toBe(true);
    const ledger = loadLedger(stateDir);
    expect(Object.values(ledger.findings)[0]?.disposition).toBe(`published:${"a".repeat(40)}`);

    const second = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(second.report.action).toBe("duplicate");
    expect(second.exitCode).toBe(0);
    expect(counts).toEqual({ agent: 1, gate: 1, integrate: 1, publish: 0 });
  });

  test("captures the prompt, canonical cwd, and worktree path in a stub agent", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const capture = join(root, "..", "capture.json");
    const stub = join(root, "..", "stub-agent.ts");
    await writeFile(
      stub,
      `const capture = Bun.argv[2] as string;
const prompt = await Bun.stdin.text();
await Bun.write(capture, JSON.stringify({
  cwd: process.cwd(),
  prompt,
  worktree: process.env.WATCHDOG_WORKTREE ?? null,
  start: process.env.WATCHDOG_WINDOW_START ?? null,
}));
`,
    );
    const events = SENTINELS.map((text, index) => event(root, index + 1, text));
    const instance = instanceFor(root, 8080);
    const previous = process.env.WATCHDOG_AGENT_COMMAND;
    process.env.WATCHDOG_AGENT_COMMAND = `bun ${stub} ${capture}`;
    try {
      const result = await runCycle({
        root,
        now: fixedNow,
        stateDir,
        deps: {
          discover: () => [
            instance,
            { ...instance, pid: 8081, port: 8081, repoDir: "/projects/second" },
            { ...instance, pid: 8082, port: 8082, repoDir: "/projects/third" },
          ],
          collect: () => ({ events, malformed: 0, unattributed: 0 }),
          gate: async () => {
            throw new Error("the gate must not run after an empty worktree");
          },
        },
      });
      expect(result.report.action).toBe("blocked");
    } finally {
      if (previous === undefined) delete process.env.WATCHDOG_AGENT_COMMAND;
      else process.env.WATCHDOG_AGENT_COMMAND = previous;
    }

    const captured = JSON.parse(readFileSync(capture, "utf8")) as {
      cwd: string;
      prompt: string;
      worktree: string;
      start: string;
    };
    expect(captured.cwd).toBe(root);
    expect(captured.start).toBe(window.start.toISOString());
    expect(captured.worktree).toContain(join(root, ".worktree", "watchdog-"));
    for (const sentinel of SENTINELS) expect(captured.prompt).toContain(sentinel);
    expect(captured.prompt).toContain(window.start.toISOString());
    expect(captured.prompt).toContain(window.end.toISOString());
    expect(captured.prompt).toContain("port 8080");
    expect(captured.prompt).toContain("port 8081");
    expect(captured.prompt).toContain("port 8082");
    expect(captured.prompt).toContain(".devboard/**");
    expect(captured.prompt).toContain(captured.worktree);
  });

  test("stops before merging when a gate fails and keeps the worktree", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    let integrated = 0;
    const { deps } = stubDeps(root, events, {
      onAgent(worktree) {
        writeFileSync(join(worktree, ".devboard", "healed.txt"), "fixed\n");
      },
      gate: async () => ({ ok: false, failed: "bun test", detail: "a test failed" }),
      integrate: async () => {
        integrated += 1;
        return { ok: true, refreshed: 0, deferred: [] };
      },
    });
    const result = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("bun test");
    expect(result.exitCode).toBe(1);
    expect(integrated).toBe(0);
    expect(result.report.worktree).toBeDefined();
    expect(existsSync(result.report.worktree as string)).toBe(true);
  });

  test("blocks a change outside .devboard and keeps the worktree", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    let integrated = 0;
    const { deps } = stubDeps(root, events, {
      onAgent(worktree) {
        writeFileSync(join(worktree, "host-file.txt"), "not allowed\n");
      },
      integrate: async () => {
        integrated += 1;
        return { ok: true, refreshed: 0, deferred: [] };
      },
    });
    const result = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(result.report.action).toBe("blocked");
    expect(result.report.blocked).toContain("host-file.txt");
    expect(integrated).toBe(0);
    expect(existsSync(result.report.worktree as string)).toBe(true);
  });

  test("exits nonzero when the agent session fails and keeps the worktree", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    const { deps, counts } = stubDeps(root, events, {
      agent: async () => ({ code: 7, stdout: "", stderr: "model unavailable" }),
    });
    const result = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("exit 7");
    expect(result.exitCode).toBe(1);
    expect(counts.gate).toBe(0);
    expect(counts.integrate).toBe(0);
    expect(existsSync(result.report.worktree as string)).toBe(true);
  });

  test("blocks while operator work is uncommitted and never starts an agent", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    writeFileSync(join(root, "operator.txt"), "mine\n");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    const { deps, counts } = stubDeps(root, events);
    const result = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(result.report.action).toBe("blocked");
    expect(result.report.blocked).toContain("operator.txt");
    expect(result.report.reason).toContain("uncommitted operator work");
    expect(result.exitCode).toBe(0);
    expect(counts.agent).toBe(0);
  });

  test("retries publish on the next cycle after a successful push", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    let publishCalls = 0;
    const { deps, counts } = stubDeps(root, events, {
      onAgent(worktree) {
        writeFileSync(join(worktree, ".devboard", "healed.txt"), "fixed\n");
      },
      integrate: async () => ({
        ok: false,
        commit: "b".repeat(40),
        pushed: true,
        refreshed: 0,
        deferred: [],
        detail: "publish: unreachable remote",
      }),
      publish: async () => {
        publishCalls += 1;
        return { ok: true, refreshed: 2, deferred: ["8080"] };
      },
    });
    const first = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(first.report.action).toBe("failed");
    expect(first.report.commit).toBe("b".repeat(40));
    expect(first.exitCode).toBe(1);
    expect(loadLedger(stateDir).pendingPublish?.commit).toBe("b".repeat(40));

    const second = await runCycle({ root, now: fixedNow, stateDir, deps });
    expect(second.report.action).toBe("published");
    expect(second.report.reason).toContain("on retry");
    expect(second.report.dashboards).toEqual({ refreshed: 2, deferred: ["8080"] });
    expect(second.exitCode).toBe(0);
    expect(publishCalls).toBe(1);
    expect(counts).toEqual({ agent: 1, gate: 1, integrate: 0, publish: 0 });
    expect(loadLedger(stateDir).pendingPublish).toBeUndefined();
  });

  test("dry run writes no run directory and invokes no agent", async () => {
    const { root } = await fixtureRepository();
    const stateDir = join(root, ".devboard", ".tmp", "watchdog");
    const events = [event(root, 1, "synthetic error: ENOTFOUND the model endpoint")];
    const { deps, counts } = stubDeps(root, events);
    const result = await runCycle({ root, now: fixedNow, stateDir, dryRun: true, deps });
    expect(result.report.action).toBe("blocked");
    expect(result.runDir).toBeUndefined();
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
    expect(existsSync(join(stateDir, "state.json"))).toBe(false);
    expect(counts.agent).toBe(0);
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

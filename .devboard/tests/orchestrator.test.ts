import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  IssueOrchestrator,
  DEFAULT_COOLDOWN_MS,
  dryRunReport,
} from "../orchestrator/coordinator";
import { loadLedger, readLedger, recordHandled, writeLedger } from "../orchestrator/ledger";
import { acquireLock, lockPath } from "../orchestrator/lock";
import { agentArgv, startRun, type RunHandle } from "../orchestrator/runner";
import {
  loadState,
  readStateFile,
  statePath,
  writeState,
  type OrchestratorIssue,
  type OrchestratorState,
} from "../orchestrator/state";

/**
 * Every fixture lives under the repository's `.devboard/.tmp`. The tests use a
 * stub tracker, a real spawned stub agent, and an in-repo temporary directory;
 * they never touch the network, a model, or a GitHub object.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const stubAgent = join(import.meta.dir, "fixtures", "stub-orchestrator-agent.ts");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "test-orchestrator"): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function issue(number: number, title = `Issue ${number}`): OrchestratorIssue {
  return {
    number,
    title,
    url: `https://example.test/issues/${number}`,
    createdAt: `2026-10-${String(20 + (number % 5)).padStart(2, "0")}T00:00:00Z`,
  };
}

function readState(stateDir: string): OrchestratorState {
  return JSON.parse(readFileSync(statePath(stateDir), "utf8")) as OrchestratorState;
}

function readAgentLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function starts(path: string): Array<Record<string, unknown>> {
  return readAgentLog(path).filter((entry) => entry.event === "start");
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
  description = "the expected state",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

function runDirectories(stateDir: string): string[] {
  const directory = join(stateDir, "orchestrator", "runs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

interface Fixture {
  root: string;
  stateDir: string;
  agentLog: string;
  issues: OrchestratorIssue[];
  orchestrator: IssueOrchestrator;
}

/**
 * A coordinator over a stub tracker and a real stub agent. `argvFor` gives each
 * run its own exit code and stderr line, so a failure can be followed by a
 * success without rebuilding the fixture.
 */
async function fixture(options: {
  issues: OrchestratorIssue[];
  sleeps?: number[];
  exits?: number[];
  stderr?: string;
  clock?: { now: Date };
  cooldownMs?: number;
  argv?: string[];
  log?: (line: string) => void;
}): Promise<Fixture> {
  const base = await temporaryDirectory();
  const root = join(base, "repo");
  const stateDir = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const agentLog = join(base, "agent.log");
  const sleeps = [...(options.sleeps ?? [])];
  const exits = [...(options.exits ?? [])];
  const issues = options.issues;
  const clock = options.clock ?? { now: new Date("2026-10-27T12:00:00.000Z") };

  const startWith = (arguments_: {
    argv: string[];
    cwd: string;
    stateDir: string;
    now?: Date;
  }): RunHandle => {
    const sleep = sleeps.shift() ?? 0;
    const exitCode = exits.shift() ?? 0;
    return startRun({
      ...arguments_,
      argv:
        options.argv === undefined
          ? [
              process.execPath,
              stubAgent,
              `--log=${agentLog}`,
              `--sleep=${sleep}`,
              `--exit=${exitCode}`,
              ...(options.stderr === undefined ? [] : [`--stderr=${options.stderr}`]),
            ]
          : options.argv,
    });
  };

  const orchestrator = new IssueOrchestrator({
    root,
    repository: "acme/fixture",
    stateDir,
    listIssues: async () => [...issues],
    startRun: startWith,
    argv: ["omp", "--print", "--auto-approve", "/implement-all-issues"],
    now: () => new Date(clock.now.getTime()),
    cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    intervalMs: 50,
    log: options.log,
  });
  orchestrator.publishStartup();
  return { root, stateDir, agentLog, issues, orchestrator };
}

describe("agentArgv", () => {
  test("names the installed command and appends no scope", () => {
    expect(agentArgv({})).toEqual(["omp", "--print", "--auto-approve", "/implement-all-issues"]);
    expect(agentArgv({ ORCHESTRATOR_AGENT_COMMAND: "   " })).toEqual([
      "omp",
      "--print",
      "--auto-approve",
      "/implement-all-issues",
    ]);
  });

  test("replaces the whole argv when the override is set, without a shell", () => {
    expect(agentArgv({ ORCHESTRATOR_AGENT_COMMAND: "  bun  agent.ts --flag=x " })).toEqual([
      "bun",
      "agent.ts",
      "--flag=x",
    ]);
  });
});

describe("trigger policy", () => {
  test("runs once for a fresh backlog and records every captured issue", async () => {
    const fixtureUnderTest = await fixture({
      issues: [issue(1), issue(2), issue(3)],
      sleeps: [400],
    });
    const { stateDir, agentLog, orchestrator } = fixtureUnderTest;

    const cycling = orchestrator.cycle();
    const running = await waitFor(
      () => (readState(stateDir).status === "running" ? readState(stateDir) : undefined),
      5_000,
      "the running state",
    );
    expect(running.open).toBe(3);
    expect(running.issues.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(running.startedAt).not.toBeNull();

    // The state stays `running` for the whole agent lifetime.
    await new Promise((settle) => setTimeout(settle, 150));
    expect(readState(stateDir).status).toBe("running");

    await cycling;
    const idle = readState(stateDir);
    expect(idle.status).toBe("idle");
    expect(idle.open).toBe(0);
    expect(idle.issues).toEqual([]);
    expect(idle.finishedAt).not.toBeNull();
    expect(idle.lastExitCode).toBe(0);

    const ledger = loadLedger(stateDir);
    expect(Object.keys(ledger.handled).sort()).toEqual(["1", "2", "3"]);
    const runs = runDirectories(stateDir);
    expect(runs).toHaveLength(1);
    for (const entry of Object.values(ledger.handled)) {
      expect(entry.runId).toBe(runs[0]!);
    }

    const log = readAgentLog(agentLog);
    expect(log.filter((entry) => entry.event === "start")).toHaveLength(1);
    expect(log[0]!.cwd).toBe(fixtureUnderTest.root);

    const runDir = join(stateDir, "orchestrator", "runs", runs[0]!);
    for (const name of ["command.json", "stdout.log", "stderr.log", "result.json"]) {
      expect(existsSync(join(runDir, name))).toBe(true);
    }
    expect(runs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  test("starts no run when no new issue exists and never retriggers a handled one", async () => {
    const { issues, agentLog, orchestrator } = await fixture({ issues: [issue(1), issue(2)] });

    await orchestrator.cycle();
    expect(starts(agentLog)).toHaveLength(1);

    expect(await orchestrator.tick()).toBe("idle");
    issues.push(issue(2, "Issue 2 renamed"));
    expect(await orchestrator.tick()).toBe("idle");
    await orchestrator.drain();
    expect(starts(agentLog)).toHaveLength(1);
  });

  test("starts exactly one run for a newly created issue", async () => {
    const { issues, agentLog, stateDir, orchestrator } = await fixture({ issues: [issue(1)] });

    await orchestrator.cycle();
    expect(starts(agentLog)).toHaveLength(1);

    issues.push(issue(2));
    await orchestrator.cycle();
    expect(starts(agentLog)).toHaveLength(2);
    expect(Object.keys(loadLedger(stateDir).handled).sort()).toEqual(["1", "2"]);
    expect(readState(stateDir).status).toBe("idle");
  });

  test("queues exactly one follow-up for an issue created during a run", async () => {
    const { issues, stateDir, agentLog, orchestrator } = await fixture({
      issues: [issue(1), issue(2)],
      sleeps: [500, 200],
    });

    await orchestrator.tick();
    await waitFor(
      () => (readState(stateDir).status === "running" ? true : undefined),
      5_000,
      "the first run",
    );
    await waitFor(
      () => (starts(agentLog).length === 1 ? true : undefined),
      5_000,
      "the running agent",
    );
    issues.push(issue(3));
    // Polling during the run notices the new issue; it must not spawn a peer.
    expect(await orchestrator.tick()).toBe("running");
    expect(await orchestrator.tick()).toBe("running");
    expect(starts(agentLog)).toHaveLength(1);

    const second = waitFor(
      () => (readState(stateDir).issues.some((entry) => entry.number === 3) ? readState(stateDir).issues : undefined),
      5_000,
      "the follow-up run's captured set",
    );
    await orchestrator.drain();
    expect((await second).map((entry) => entry.number)).toEqual([3]);

    const log = readAgentLog(agentLog);
    const startsInOrder = log.filter((entry) => entry.event === "start");
    expect(startsInOrder).toHaveLength(2);
    // No overlap: the first run ended before the second began.
    expect(log.map((entry) => entry.event)).toEqual(["start", "end", "start", "end"]);

    const ledger = loadLedger(stateDir);
    expect(Object.keys(ledger.handled).sort()).toEqual(["1", "2", "3"]);
    expect(readState(stateDir).status).toBe("idle");

    // Nothing further runs while no new number appears.
    expect(await orchestrator.tick()).toBe("idle");
    await orchestrator.drain();
    expect(starts(agentLog)).toHaveLength(2);
  });
});

describe("failure policy", () => {
  test("records the failure, holds the cooldown, then retries and clears it", async () => {
    const clock = { now: new Date("2026-10-27T12:00:00.000Z") };
    const { stateDir, agentLog, orchestrator } = await fixture({
      issues: [issue(1), issue(2)],
      sleeps: [0, 0],
      exits: [7, 0],
      stderr: "boom: the agent could not start\nsecond line",
      clock,
      cooldownMs: 5 * 60_000,
    });

    await orchestrator.cycle();
    const failed = readState(stateDir);
    expect(failed.status).toBe("failed");
    expect(failed.lastExitCode).toBe(7);
    expect(failed.lastError).toBe("boom: the agent could not start");
    expect(failed.nextAttemptAt).toBe("2026-10-27T12:05:00.000Z");
    expect(failed.open).toBe(2);
    expect(failed.issues.map((entry) => entry.number)).toEqual([1, 2]);
    expect(loadLedger(stateDir).handled).toEqual({});
    expect(starts(agentLog)).toHaveLength(1);

    clock.now = new Date("2026-10-27T12:04:59.000Z");
    expect(await orchestrator.tick()).toBe("cooldown");
    await orchestrator.drain();
    expect(starts(agentLog)).toHaveLength(1);

    clock.now = new Date("2026-10-27T12:05:01.000Z");
    expect(await orchestrator.tick()).toBe("triggered");
    await orchestrator.drain();
    expect(starts(agentLog)).toHaveLength(2);

    const recovered = readState(stateDir);
    expect(recovered.status).toBe("idle");
    expect(recovered.lastExitCode).toBe(0);
    expect(recovered.lastError).toBeNull();
    expect(recovered.nextAttemptAt).toBeNull();
    expect(Object.keys(loadLedger(stateDir).handled).sort()).toEqual(["1", "2"]);
  });

  test("spawns nothing when no issue is open", async () => {
    const { stateDir, agentLog, orchestrator } = await fixture({ issues: [] });

    expect(await orchestrator.tick()).toBe("idle");
    await orchestrator.drain();
    expect(starts(agentLog)).toHaveLength(0);
    expect(readState(stateDir).status).toBe("idle");
    expect(readState(stateDir).open).toBe(0);
  });
});

describe("the ledger", () => {
  test("records the run id and timestamp and survives a reload", async () => {
    const stateDir = await temporaryDirectory();
    const ledger = recordHandled(
      { version: 1, handled: {} },
      [issue(4), issue(5)],
      "2026-10-27T12-00-00-000Z",
      new Date("2026-10-27T12:00:03.000Z"),
    );
    writeLedger(stateDir, ledger);

    const reloaded = loadLedger(stateDir);
    expect(reloaded.handled["4"]).toEqual({
      number: 4,
      runId: "2026-10-27T12-00-00-000Z",
      at: "2026-10-27T12:00:03.000Z",
    });
    expect(reloaded.version).toBe(1);
  });

  test("prunes a closed issue so a reopened one triggers again", async () => {
    const { issues, stateDir, agentLog, orchestrator } = await fixture({
      issues: [issue(1), issue(2)],
    });
    await orchestrator.cycle();
    expect(Object.keys(readLedger(stateDir).handled).sort()).toEqual(["1", "2"]);

    issues.splice(1, 1);
    expect(await orchestrator.tick()).toBe("idle");
    expect(Object.keys(readLedger(stateDir).handled)).toEqual(["1"]);

    issues.push(issue(2));
    await orchestrator.cycle();
    expect(Object.keys(readLedger(stateDir).handled).sort()).toEqual(["1", "2"]);
    expect(starts(agentLog)).toHaveLength(2);
  });
});

describe("state files", () => {
  test("never exposes a partial document to a concurrent reader", async () => {
    const stateDir = await temporaryDirectory();
    const template: OrchestratorState = {
      version: 1,
      root: "/fixture/root",
      repo: "acme/fixture",
      status: "idle",
      startedAt: null,
      finishedAt: null,
      open: 0,
      issues: [],
      lastExitCode: null,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: "2026-10-27T12:00:00.000Z",
    };
    writeState(stateDir, template);
    let writes = 0;
    let reads = 0;
    let done = false;

    const writer = (async () => {
      for (let index = 0; index < 200; index += 1) {
        writeState(stateDir, {
          ...template,
          open: index,
          issues: [],
          updatedAt: new Date(Date.now() + index).toISOString(),
        });
        writes += 1;
        await new Promise((settle) => setImmediate(settle));
      }
      done = true;
    })();
    const reader = (async () => {
      while (!done) {
        const state = readStateFile(statePath(stateDir));
        if (state !== undefined) reads += 1;
        await new Promise((settle) => setImmediate(settle));
      }
    })();
    await Promise.all([writer, reader]);

    expect(writes).toBe(200);
    expect(reads).toBeGreaterThan(0);
    expect(readStateFile(statePath(stateDir))?.open).toBe(199);
    expect(readdirSync(join(stateDir, "orchestrator")).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("keeps a damaged or foreign state file aside and starts fresh", async () => {
    const stateDir = await temporaryDirectory();
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    const path = statePath(stateDir);

    writeFileSync(path, '{"version": 1, "root":');
    expect(readStateFile(path)).toBeUndefined();
    expect(loadState(stateDir)).toBeUndefined();
    const quarantined = readdirSync(join(stateDir, "orchestrator")).filter((name) =>
      name.startsWith("state.json.invalid-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(stateDir, "orchestrator", quarantined[0]!), "utf8")).toBe(
      '{"version": 1, "root":',
    );
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, JSON.stringify({ version: 2, root: stateDir }));
    expect(loadState(stateDir)).toBeUndefined();
    expect(
      readdirSync(join(stateDir, "orchestrator")).filter((name) =>
        name.startsWith("state.json.invalid-"),
      ),
    ).toHaveLength(2);

    const fixtureUnderTest = await fixture({ issues: [] });
    expect(readState(fixtureUnderTest.stateDir).version).toBe(1);
  });

  test("treats a missing file as no state rather than an error", async () => {
    const stateDir = await temporaryDirectory();
    expect(loadState(stateDir)).toBeUndefined();
    expect(readStateFile(statePath(stateDir))).toBeUndefined();
  });

  test("keeps the cooldown across a restart instead of bypassing it", async () => {
    const stateDir = await temporaryDirectory();
    const now = new Date("2026-10-27T12:00:00.000Z");
    const state: OrchestratorState = {
      version: 1,
      root: "/fixture/root",
      repo: "acme/fixture",
      status: "failed",
      startedAt: null,
      finishedAt: "2026-10-27T11:59:00.000Z",
      open: 1,
      issues: [issue(1)],
      lastExitCode: 3,
      lastError: "boom",
      nextAttemptAt: "2026-10-27T12:05:00.000Z",
      updatedAt: "2026-10-27T11:59:00.000Z",
    };
    writeState(stateDir, state);

    const orchestrator = new IssueOrchestrator({
      root: "/fixture/root",
      repository: "acme/fixture",
      stateDir,
      listIssues: async () => [issue(1)],
      startRun: () => {
        throw new Error("the cooldown must not spawn");
      },
      argv: ["true"],
      now: () => now,
    });
    orchestrator.publishStartup();
    const restarted = readState(stateDir);
    expect(restarted.status).toBe("failed");
    expect(restarted.nextAttemptAt).toBe("2026-10-27T12:05:00.000Z");
    expect(restarted.open).toBe(0);
    expect(await orchestrator.tick()).toBe("cooldown");
  });

  test("reports what the next poll would do", () => {
    const report = dryRunReport({
      repository: "acme/fixture",
      issues: [issue(1), issue(2)],
      ledger: recordHandled(
        { version: 1, handled: {} },
        [issue(1)],
        "run",
        new Date("2026-10-27T12:00:00.000Z"),
      ),
      state: undefined,
      now: new Date("2026-10-27T12:00:00.000Z"),
    });
    expect(report).toMatchObject({ repo: "acme/fixture", open: 2, action: "trigger" });
  });
});

describe("singleton lock", () => {
  test("reports the live owner and releases cleanly", async () => {
    const directory = await temporaryDirectory();
    const path = lockPath(directory);
    const first = acquireLock(path);
    expect(first.acquired).toBe(true);
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number; startedAt: string };
    expect(owner.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(owner.startedAt))).toBe(true);

    const second = acquireLock(path);
    expect(second.acquired).toBe(false);
    expect(second.acquired === false ? second.owner?.pid : undefined).toBe(process.pid);

    if (first.acquired) first.release();
    expect(existsSync(path)).toBe(false);
  });

  test("reclaims a lock whose owner is gone", async () => {
    const directory = await temporaryDirectory();
    const path = lockPath(directory);
    await mkdir(join(directory, "orchestrator"), { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
    expect(dead.status).toBe(0);
    writeFileSync(
      path,
      `${JSON.stringify({ pid: dead.pid, startedAt: "2026-10-27T12:00:00.000Z" })}\n`,
    );

    const reclaimed = acquireLock(path);
    expect(reclaimed.acquired).toBe(true);
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(owner.pid).toBe(process.pid);
    if (reclaimed.acquired) reclaimed.release();
  });
});

describe("the command line", () => {
  function git(directory: string, ...args: string[]): void {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  async function canonicalFixture(repository = "acme/fixture"): Promise<string> {
    const base = await temporaryDirectory("test-orchestrator-cli");
    const root = join(base, "repo");
    await mkdir(join(root, ".devboard"), { recursive: true });
    await writeFile(join(root, ".devboard", "marker"), "harness\n");
    git(root, "init", "-q");
    git(root, "config", "user.email", "devboard@example.test");
    git(root, "config", "user.name", "Devboard Test");
    git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");
    return root;
  }

  /** A fake tracker and a fake agent on PATH, each recording its invocation. */
  async function toolBin(directory: string): Promise<{ bin: string; ompLog: string }> {
    const bin = join(directory, "bin");
    await mkdir(bin, { recursive: true });
    const ompLog = join(directory, "omp.log");
    const issues = [
      { number: 21, title: "First", url: "https://example.test/21", createdAt: "2026-10-20T00:00:00Z" },
      { number: 22, title: "Second", url: "https://example.test/22", createdAt: "2026-10-21T00:00:00Z" },
    ];
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\ncat <<'JSON'\n${issues.map((entry) => JSON.stringify(entry)).join("\n")}\nJSON\n`,
    );
    await writeFile(
      join(bin, "omp"),
      `#!/bin/sh\npwd >> ${ompLog}\necho "$@" >> ${ompLog}\nexit 0\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "omp"), 0o755);
    return { bin, ompLog };
  }

  function cli(
    args: string[],
    options: { env?: Record<string, string>; cwd?: string } = {},
  ): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [join(harnessRoot, "orchestrator", "main.ts"), ...args], {
      cwd: options.cwd ?? harnessRoot,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("prints help and exits 0", () => {
    const result = cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--dry-run");
  });

  test("refuses a linked worktree, a plain directory, and a foreign repository", async () => {
    const root = await canonicalFixture();
    const base = await temporaryDirectory("test-orchestrator-refuse");
    const linked = join(base, "linked");
    const added = spawnSync("git", ["-C", root, "worktree", "add", "-q", linked], {
      encoding: "utf8",
    });
    expect(added.status).toBe(0);

    const worktreeResult = cli(["--once", "--dry-run", "--root", linked, "--repo", "acme/fixture"]);
    expect(worktreeResult.code).toBe(2);
    expect(worktreeResult.stderr).toContain("worktree");

    // A directory that is not a checkout root is refused; inside this
    // repository it is nested in the worktree, so the message names that.
    const plain = join(base, "plain");
    await mkdir(join(plain, ".devboard"), { recursive: true });
    const plainResult = cli(["--once", "--dry-run", "--root", plain]);
    expect(plainResult.code).toBe(2);
    expect(plainResult.stderr).toContain("not the checkout root");

    const missingHarness = join(root, "adrs");
    await mkdir(missingHarness, { recursive: true });
    const missingResult = cli(["--once", "--dry-run", "--root", missingHarness]);
    expect(missingResult.code).toBe(2);

    const foreign = cli(["--once", "--dry-run", "--root", root, "--repo", "other/fixture"]);
    expect(foreign.code).toBe(2);
    expect(foreign.stderr).toContain("is not the checkout's origin");
  });

  test("--once --dry-run prints one report and writes nothing", async () => {
    const root = await canonicalFixture();
    const { bin } = await toolBin(await temporaryDirectory("test-orchestrator-bin"));
    const result = cli(["--once", "--dry-run", "--root", root, "--repo", "acme/fixture"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      repo: string;
      open: number;
      issues: OrchestratorIssue[];
      action: string;
    };
    expect(report.repo).toBe("acme/fixture");
    expect(report.open).toBe(2);
    expect(report.issues.map((entry) => entry.number)).toEqual([21, 22]);
    expect(report.action).toBe("trigger");
    expect(existsSync(join(root, ".devboard", ".tmp"))).toBe(false);
    expect(existsSync(join(root, ".devboard", ".tmp", "orchestrator"))).toBe(false);
  });

  test("--once runs the default argv once in the root and publishes state", async () => {
    const root = await canonicalFixture();
    const { bin, ompLog } = await toolBin(await temporaryDirectory("test-orchestrator-bin"));
    const result = cli(["--once", "--root", root, "--repo", "acme/fixture"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.code).toBe(0);
    const lines = readFileSync(ompLog, "utf8").trim().split("\n");
    expect(lines[0]).toBe(root);
    expect(lines[1]).toBe("--print --auto-approve /implement-all-issues");

    const stateDir = join(root, ".devboard", ".tmp");
    const state = readState(stateDir);
    expect(state.status).toBe("idle");
    expect(state.repo).toBe("acme/fixture");
    expect(state.root).toBe(root);
    expect(state.lastExitCode).toBe(0);
    expect(Object.keys(loadLedger(stateDir).handled).sort()).toEqual(["21", "22"]);

    const runs = runDirectories(stateDir);
    expect(runs).toHaveLength(1);
    const command = JSON.parse(
      readFileSync(join(stateDir, "orchestrator", "runs", runs[0]!, "command.json"), "utf8"),
    ) as { argv: string[]; cwd: string };
    expect(command.argv).toEqual(["omp", "--print", "--auto-approve", "/implement-all-issues"]);
    expect(command.cwd).toBe(root);
  });

  test("a second invocation reports the live owner and changes nothing", async () => {
    const root = await canonicalFixture();
    const { bin, ompLog } = await toolBin(await temporaryDirectory("test-orchestrator-bin"));
    const stateDir = join(root, ".devboard", ".tmp");
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    writeFileSync(
      lockPath(stateDir),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );

    const result = cli(["--once", "--root", root, "--repo", "acme/fixture"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already running");
    expect(existsSync(ompLog)).toBe(false);
    expect(existsSync(statePath(stateDir))).toBe(false);
    expect(runDirectories(stateDir)).toEqual([]);
  });
});

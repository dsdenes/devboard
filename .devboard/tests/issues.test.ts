import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import { recordedChildAlive } from "../server/state";
import { readHarnessVersion, runningHarnessDir } from "../server/version";
import { writeCommand } from "../issues/control";
import { migrateLegacyLedger, legacyLiveLock, legacyLockRefusal } from "../issues/legacy";
import { pruneLedger } from "../issues/ledger";
import { acquireLock, liveLockOwner } from "../issues/lock";
import { controlDirectory, ledgerPath, lockPath, statePath } from "../issues/paths";
import { preflightIssues } from "../issues/preflight";
import {
  appendActivityLine,
  emptyState,
  loadState,
  parseState,
  readActivity,
  trimActivityLines,
  writeState,
  type IssuesIssue,
  type IssuesState,
} from "../issues/state";
import { parseResponse, pollOpenIssues } from "../issues/tracker";
import { IssuesWorker, type AcpPeer, type IssuesPeerOptions } from "../issues/worker";

/**
 * Durable worker tests. Every fixture lives under `.devboard/.tmp`; the tracker
 * is a list, the ACP peer is a controllable fake, and no GitHub object, model,
 * process outside the test, or systemd unit is involved.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];
const workers: IssuesWorker[] = [];

afterAll(async () => {
  for (const worker of workers) {
    await worker.stop().catch(() => undefined);
  }
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "test-issues"): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function issue(number: number, title = `Issue ${number}`): IssuesIssue {
  return {
    number,
    title,
    url: `https://github.com/acme/fixture/issues/${number}`,
    createdAt: `2026-10-${String(20 + (number % 5)).padStart(2, "0")}T00:00:00Z`,
  };
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

class ControlledPeer implements AcpPeer {
  readonly pid = undefined;
  readonly argv = ["stub-acp"];
  readonly prompts: string[] = [];
  readonly activity: AcpActivity[] = [];
  readonly questions: AcpQuestion[] = [];
  closed = false;
  private settled = false;
  private readonly resolveRun: (value: unknown) => void;
  private readonly rejectRun: (error: Error) => void;
  private readonly options: IssuesPeerOptions;

  constructor(options: IssuesPeerOptions) {
    this.options = options;
    const deferred = Promise.withResolvers<unknown>();
    this.resolveRun = deferred.resolve;
    this.rejectRun = deferred.reject;
    this.promise = deferred.promise;
  }

  private readonly promise: Promise<unknown>;

  run(prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    return this.promise;
  }

  answer(id: number | string, value: string): boolean {
    const question = this.questions.find((candidate) => String(candidate.id) === String(id));
    if (question === undefined) return false;
    const activity = { text: `answered ${value}`, append: false };
    this.activity.push(activity);
    this.options.onActivity(activity);
    return true;
  }

  close(): void {
    this.closed = true;
    if (!this.settled) {
      this.settled = true;
      this.rejectRun(new Error("Agent process exited before answering."));
    }
  }

  emit(text: string, append = false): void {
    this.options.onActivity({ text, append });
  }

  ask(question: AcpQuestion): void {
    this.questions.push(question);
    this.options.onQuestion(question);
  }

  succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveRun({});
  }

  fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onStderr(`${message}\n`);
    this.rejectRun(new Error(message));
  }
}

interface Fixture {
  root: string;
  stateDir: string;
  worker: IssuesWorker;
  peers: ControlledPeer[];
  issues: IssuesIssue[];
  state: () => IssuesState;
  path: string;
}

async function fixture(options: {
  label?: string;
  issues?: IssuesIssue[];
  repository?: string;
  root?: string;
  stateDir?: string;
  harnessVersion?: string;
  now?: () => Date;
  beforeStart?: (root: string, stateDir: string) => void;
}): Promise<Fixture> {
  const base = await temporaryDirectory(options.label);
  const root = options.root ?? join(base, "repo");
  const stateDir = options.stateDir ?? join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const issues = options.issues ?? [];
  const peers: ControlledPeer[] = [];
  options.beforeStart?.(root, stateDir);
  const worker = new IssuesWorker({
    repoDir: root,
    stateDir,
    intervalMs: 60_000,
    ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    ...(options.now === undefined ? {} : { now: options.now }),
    listIssues: async () => ({ kind: "issues", issues: [...issues], etag: "etag-1" }),
    connect: (peerOptions) => {
      const peer = new ControlledPeer(peerOptions);
      peers.push(peer);
      return peer;
    },
  });
  workers.push(worker);
  expect(worker.start(options.repository ?? "acme/fixture")).toBe(true);
  return {
    root,
    stateDir,
    worker,
    peers,
    issues,
    state: () => worker.currentState,
    path: statePath(stateDir, root),
  };
}

async function stop(fixtureUnderTest: Fixture): Promise<void> {
  await fixtureUnderTest.worker.stop();
}

describe("trigger policy", () => {
  test("runs once for the backlog and marks every captured issue handled", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), issue(3)] });
    try {
      const peer = await waitFor(() => f.peers[0], "the first peer");
      expect(peer.prompts).toEqual(["/implement-all-issues"]);
      await waitFor(() => (f.state().lifecycle === "running" ? true : undefined), "running");
      expect(f.state().activeRun?.issueNumbers).toEqual([1, 2, 3]);
      peer.emit("working");
      peer.succeed();

      const idle = await waitFor(
        () => (f.state().lifecycle === "idle" ? f.state() : undefined),
        "idle",
      );
      expect(idle.runs[0]?.status).toBe("succeeded");
      expect(idle.runs[0]?.issueNumbers).toEqual([1, 2, 3]);
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(Object.keys(ledger.handled).sort()).toEqual(["1", "2", "3"]);
      expect(idle.queue.every((entry) => entry.handled)).toBe(true);
      expect(peer.closed).toBe(true);
      const runId = idle.runs[0]!.runId;
      expect(readActivity(join(f.stateDir, "issues", readdirSync(join(f.stateDir, "issues"))[0]!, "runs", runId))).toContain(
        "working",
      );
    } finally {
      await stop(f);
    }
  });

  test("never retriggers a handled issue and runs for a newly opened one", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const first = await waitFor(() => f.peers[0], "the first peer");
      first.succeed();
      await waitFor(() => (f.state().lifecycle === "idle" ? true : undefined), "idle");

      await f.worker.poll();
      expect(f.peers).toHaveLength(1);

      f.issues.push(issue(2));
      await f.worker.poll();
      const second = await waitFor(() => f.peers[1], "the second peer");
      second.succeed();
      await waitFor(() => (f.state().queue.every((entry) => entry.handled) ? true : undefined), "handled queue");
      expect(f.state().queue.map((entry) => entry.number)).toEqual([1, 2]);
    } finally {
      await stop(f);
    }
  });

  test("an issue created during a run earns exactly one follow-up", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const first = await waitFor(() => f.peers[0], "the first peer");
      f.issues.push(issue(2));
      await f.worker.poll();
      await f.worker.poll();
      expect(f.peers).toHaveLength(1);
      first.succeed();

      const second = await waitFor(() => f.peers[1], "the follow-up peer");
      expect(second.prompts).toEqual(["/implement-all-issues"]);
      await waitFor(
        () => (f.state().activeRun?.issueNumbers.join(",") === "2" ? true : undefined),
        "the follow-up capture",
      );
      second.succeed();
      await waitFor(
        () => (f.state().lifecycle === "idle" && f.state().queue.every((entry) => entry.handled) ? true : undefined),
        "the follow-up success",
      );
      expect(f.peers).toHaveLength(2);
    } finally {
      await stop(f);
    }
  });

  test("a failed run publishes the first stderr line and a five-minute cooldown", async () => {
    let now = new Date("2026-10-27T00:00:00Z");
    const f = await fixture({ issues: [issue(1)], now: () => now });
    try {
      const peer = await waitFor(() => f.peers[0], "the first peer");
      peer.fail("tracker said no");
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the failed state",
      );
      expect(failed.lastError).toBe("tracker said no");
      expect(failed.runs[0]?.status).toBe("failed");
      const remaining = Date.parse(failed.nextAttemptAt!) - now.getTime();
      expect(remaining).toBeGreaterThan(4 * 60_000);
      expect(remaining).toBeLessThanOrEqual(5 * 60_000);
      expect(
        existsSync(ledgerPath(f.stateDir, f.root))
          ? Object.keys(JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8")).handled).length
          : 0,
      ).toBe(0);

      await f.worker.poll();
      expect(f.peers).toHaveLength(1);

      // Only elapsed time lifts the cooldown: there is no check-now control.
      now = new Date(now.getTime() + 6 * 60_000);
      await f.worker.poll();
      const retry = await waitFor(() => f.peers[1], "the retry after the cooldown");
      retry.succeed();
      await waitFor(() => (f.state().lifecycle === "idle" ? true : undefined), "the retry success");
      expect(f.state().nextAttemptAt).toBeNull();
    } finally {
      await stop(f);
    }
  });

  test("surfaces an ACP question and accepts its answer", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const peer = await waitFor(() => f.peers[0], "the peer");
      peer.ask({ id: 7, message: "Which scope?", options: [], properties: {}, required: undefined });
      const question = await waitFor(() => f.state().question, "the question");
      expect(question.message).toBe("Which scope?");

      writeCommand(controlDirectory(f.stateDir, f.root), { type: "answer", id: 7, value: "all" });
      await waitFor(() => (f.state().question === null ? true : undefined), "the answered question");
      expect(peer.activity.map((entry) => entry.text)).toContain("answered all");
      peer.succeed();
      await waitFor(() => (f.state().lifecycle === "idle" ? true : undefined), "idle");
    } finally {
      await stop(f);
    }
  });
});

describe("lifecycle", () => {
  test("stop ends the active run and leaves its issue unhandled", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const first = await waitFor(() => f.peers[0], "the first peer");
      first.succeed();
      await waitFor(
        () => (f.state().lifecycle === "idle" && f.state().queue.every((entry) => entry.handled) ? true : undefined),
        "the first success",
      );

      f.issues.push(issue(3));
      await f.worker.poll();
      const stopping = await waitFor(() => f.peers[1], "the peer to stop");
      await waitFor(() => (f.state().lifecycle === "running" ? true : undefined), "running");
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "stop" });
      const stopped = await waitFor(
        () => (f.state().lifecycle === "stopped" ? f.state() : undefined),
        "stopped",
      );
      expect(stopping.closed).toBe(true);
      expect(stopped.enabled).toBe(false);
      expect(stopped.runs[0]?.status).toBe("stopped");
      expect(stopped.runs[0]?.issueNumbers).toEqual([3]);
      expect(existsSync(lockPath(f.root))).toBe(false);
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(ledger.handled["3"]).toBeUndefined();
      expect(stopped.nextAttemptAt).toBeNull();
    } finally {
      await stop(f);
    }
  });
});

describe("state and isolation", () => {
  test("writes atomically, records the worker version, and quarantines damage", async () => {
    const f = await fixture({ issues: [], harnessVersion: "0.9.7" });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
      const state = f.state();
      expect(state.worker?.pid).toBe(process.pid);
      expect(state.worker?.harnessVersion).toBe("0.9.7");
      expect(state.worker?.argv.length).toBeGreaterThan(0);
      expect(readdirSync(join(f.stateDir, "issues", readdirSync(join(f.stateDir, "issues"))[0]!)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await stop(f);
    }

    const base = await temporaryDirectory("damaged");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(join(stateDir, "issues"), { recursive: true });
    const damaged = statePath(stateDir, root);
    await mkdir(join(damaged, ".."), { recursive: true });
    writeFileSync(damaged, '{"version": 1, "root":');
    expect(loadState(damaged)).toBeUndefined();
    const names = readdirSync(join(damaged, ".."));
    expect(names.some((name) => name.includes(".invalid-"))).toBe(true);
    expect(readFileSync(join(damaged, "..", names.find((name) => name.includes(".invalid-"))!), "utf8")).toBe(
      '{"version": 1, "root":',
    );
  });

  test("two repositories sharing a state directory never share records", async () => {
    const base = await temporaryDirectory("isolation");
    const firstState = join(base, "state");
    const first = await fixture({ stateDir: firstState, issues: [issue(1)] });
    const second = await fixture({ stateDir: firstState, issues: [issue(2)], label: "isolation-two" });
    try {
      expect(first.path).not.toBe(second.path);
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(second.path)).toBe(true);
      const firstPeer = await waitFor(() => first.peers[0], "the first peer");
      const secondPeer = await waitFor(() => second.peers[0], "the second peer");
      firstPeer.succeed();
      secondPeer.succeed();
      await waitFor(() => (first.state().lifecycle === "idle" ? true : undefined), "first idle");
      await waitFor(() => (second.state().lifecycle === "idle" ? true : undefined), "second idle");
      expect(first.state().queue.map((entry) => entry.number)).toEqual([1]);
      expect(second.state().queue.map((entry) => entry.number)).toEqual([2]);
    } finally {
      await stop(first);
      await stop(second);
    }
  });

  test("one checkout cannot host a second worker with another state directory", async () => {
    const base = await temporaryDirectory("lock-isolation");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const held = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: "0.1.test",
      argv: ["worker"],
    });
    expect(held.acquired).toBe(true);
    try {
      const second = new IssuesWorker({
        repoDir: root,
        stateDir: join(base, "other-state"),
        harnessVersion: "0.1.test",
        listIssues: async () => ({ kind: "issues", issues: [], etag: null }),
        connect: () => {
          throw new Error("must not connect");
        },
      });
      expect(second.start("acme/fixture")).toBe(false);
      expect(liveLockOwner(lockPath(root))?.stateDir).toBe(stateDir);
    } finally {
      if (held.acquired) held.release();
    }
  });

  test("records the source checkout's commit-count version by default", async () => {
    const f = await fixture({ issues: [] });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
      expect(f.state().worker?.harnessVersion).toBe(readHarnessVersion(runningHarnessDir()));
      expect(f.state().worker?.harnessVersion).not.toBe("0.1.0");
    } finally {
      await stop(f);
    }
  });

  test("terminates a proven orphaned ACP child on a fresh start", async () => {
    const base = await temporaryDirectory("orphan");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setTimeout(() => undefined, 60_000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    const identity = await waitFor(
      () => {
        try {
          const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
          const cwd = readlinkSync(`/proc/${pid}/cwd`);
          return argv.length > 0 ? { argv, cwd } : undefined;
        } catch {
          return undefined;
        }
      },
      "the child identity",
      2000,
    );
    const { argv, cwd } = identity;
    const path = statePath(stateDir, root);
    const stale = emptyState({ repo: "acme/fixture", root, intervalMs: 60_000 });
    writeState(path, { ...stale, acp: { pid, argv, cwd } });
    expect(recordedChildAlive({ pid, argv, cwd })).toBe(true);
    expect(loadState(path)?.acp?.pid).toBe(pid);
    const worker = new IssuesWorker({
      repoDir: root,
      stateDir,
      intervalMs: 60_000,
      harnessVersion: "0.1.test",
      listIssues: async () => ({ kind: "issues", issues: [], etag: null }),
      connect: () => {
        throw new Error("must not connect");
      },
    });
    workers.push(worker);
    try {
      expect(worker.start("acme/fixture")).toBe(true);
      const outcome = await Promise.race([
        child.exited.then(() => "exited" as const),
        Bun.sleep(3000).then(() => "timeout" as const),
      ]);
      expect(outcome).toBe("exited");
      expect(worker.currentState.acp).toBeNull();
    } finally {
      await worker.stop();
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It was already terminated by the worker.
      }
    }
  });

  test("reclaims a lock whose owner is gone", async () => {
    const base = await temporaryDirectory("reclaim");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(join(root, ".devboard", ".tmp", "issues"), { recursive: true });
    writeFileSync(
      lockPath(root),
      JSON.stringify({ pid: 999_999_999, startedAt: new Date(0).toISOString(), repo: root, stateDir, harnessVersion: null, argv: [] }),
    );
    const f = await fixture({ stateDir, issues: [], beforeStart: () => undefined });
    try {
      expect(liveLockOwner(lockPath(f.root))?.pid).toBe(process.pid);
    } finally {
      await stop(f);
    }
    expect(existsSync(lockPath(f.root))).toBe(false);
  });
});

describe("ledger", () => {
  test("drops a closed issue so a reopened one is new again", () => {
    const ledger = {
      version: 1 as const,
      handled: {
        "1": { number: 1, runId: "run", at: "2026-10-01T00:00:00Z" },
        "2": { number: 2, runId: "run", at: "2026-10-01T00:00:00Z" },
      },
    };
    const pruned = pruneLedger(ledger, new Set([1]));
    expect(Object.keys(pruned.handled)).toEqual(["1"]);
    expect(pruneLedger(ledger, new Set([1, 2]))).toBe(ledger);
  });
});

describe("tracker", () => {
  test("treats a 304 as no change and keeps the etag", async () => {
    const result = await pollOpenIssues({
      repository: "acme/fixture",
      etag: '"abc"',
      run: () => ({
        code: 1,
        stdout: 'HTTP/2.0 304 Not Modified\netag: "abc"\n\n',
        stderr: "",
      }),
    });
    expect(result).toEqual({ kind: "not-modified", etag: '"abc"' });
  });

  test("excludes pull requests, sorts, and reads retry headers", async () => {
    const response = [
      "HTTP/2.0 200 OK",
      'etag: "next"',
      "",
      JSON.stringify(issue(2)),
      JSON.stringify(issue(1)),
    ].join("\n");
    const result = await pollOpenIssues({
      repository: "acme/fixture",
      run: () => ({ code: 0, stdout: response, stderr: "" }),
    });
    expect(result.kind).toBe("issues");
    if (result.kind !== "issues") return;
    expect(result.issues.map((entry) => entry.number)).toEqual([1, 2]);
    expect(result.etag).toBe('"next"');

    const limited = await pollOpenIssues({
      repository: "acme/fixture",
      run: () => ({
        code: 1,
        stdout: "HTTP/2.0 403 Forbidden\nretry-after: 120\n\n",
        stderr: "",
      }),
    });
    expect(limited.kind).toBe("rate-limited");
    if (limited.kind !== "rate-limited") return;
    expect(Date.parse(limited.until) - Date.now()).toBeGreaterThan(100_000);
    expect(parseResponse("HTTP/1.1 200 OK\n").blocks[0]?.status).toBe(200);
  });
});

describe("activity bounds", () => {
  test("keeps the first 1,000 entries and prefixes the trimmed marker", () => {
    const lines: string[] = [];
    for (let index = 0; index < 1200; index += 1) appendActivityLine(lines, `line ${index}`, false);
    expect(lines.length).toBe(1000);
    expect(lines[0]).toBe("Earlier activity was trimmed.");
    expect(lines[1]).toBe("line 201");
    expect(lines[999]).toBe("line 1199");

    const wide: string[] = [];
    trimActivityLines(wide);
    wide.push("x".repeat(1024 * 1024));
    trimActivityLines(wide);
    expect(wide).toEqual(["x".repeat(1024 * 1024)]);
  });
});

describe("legacy orchestrator", () => {
  test("imports handled numbers only for the matching root and absent ledger", async () => {
    const base = await temporaryDirectory("legacy");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    writeFileSync(
      join(stateDir, "orchestrator", "state.json"),
      JSON.stringify({ version: 1, root, repo: "acme/fixture", status: "idle" }),
    );
    writeFileSync(
      join(stateDir, "orchestrator", "ledger.json"),
      JSON.stringify({ version: 1, handled: { "4": { number: 4, runId: "legacy", at: "2026-10-01T00:00:00Z" } } }),
    );

    expect(migrateLegacyLedger({ stateDir, repoDir: root })).toEqual([
      { number: 4, runId: "legacy", at: "2026-10-01T00:00:00Z" },
    ]);
    expect(migrateLegacyLedger({ stateDir, repoDir: join(base, "elsewhere") })).toBeUndefined();

    const f = await fixture({ root, stateDir, issues: [issue(4)] });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
      // The migrated number is already handled, so no run covers it.
      expect(f.state().queue.find((entry) => entry.number === 4)?.handled).toBe(true);
      expect(f.peers).toHaveLength(0);
    } finally {
      await stop(f);
    }
  });

  test("refuses Start while a legacy orchestrator lock names a live process", async () => {
    const base = await temporaryDirectory("legacy-lock");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    const bin = join(base, "bin");
    const home = join(base, "home");
    await mkdir(join(root, ".devboard"), { recursive: true });
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    await mkdir(bin, { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-all-issues.md"), "# command\n");
    for (const name of ["gh", "omp"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      Bun.spawnSync({ cmd: ["chmod", "+x", join(bin, name)] });
    }
    writeFileSync(
      join(stateDir, "orchestrator", "lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    Bun.spawnSync({
      cmd: ["git", "init", "-q", root],
    });
    Bun.spawnSync({ cmd: ["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/fixture.git"] });

    const owner = legacyLiveLock(stateDir);
    expect(owner?.pid).toBe(process.pid);
    expect(legacyLockRefusal(owner!, stateDir)).toContain("systemctl --user stop devboard-orchestrator.service");
    const result = await preflightIssues({
      repoDir: root,
      stateDir,
      environment: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("legacy devboard-orchestrator");
    expect(result.message).toContain("pid " + process.pid);
  });
});

describe("state document", () => {
  test("rejects another version and accepts the empty stopped state", () => {
    const state: IssuesState = {
      version: 1,
      repo: "acme/fixture",
      root: "/tmp/repo",
      lifecycle: "stopped",
      enabled: false,
      worker: null,
      poll: { intervalMs: 2000, lastPollAt: null, nextPollAt: null, etag: null, notModified: false, rateLimitedUntil: null, error: null },
      queue: [],
      runs: [],
      activeRun: null,
      question: null,
      acp: null,
      nextAttemptAt: null,
      lastError: null,
      lastExitCode: null,
      finishedAt: null,
      notice: null,
      updatedAt: "2026-10-27T00:00:00Z",
    };
    expect(parseState(JSON.stringify({ ...state, version: 2 }))).toBeUndefined();
    expect(parseState(JSON.stringify(state))?.lifecycle).toBe("stopped");

    const path = join(testRoot, "state-document.json");
    writeState(path, state);
    expect(loadState(path)?.repo).toBe("acme/fixture");
  });
});

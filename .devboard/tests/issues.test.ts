import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import { IssuesBridge } from "../server/issues";
import { recordedChildAlive } from "../server/process";
import { readHarnessVersion, runningHarnessDir } from "../server/version";
import { writeCommand } from "../issues/control";
import { claimIssue } from "../issues/claims";
import { migrateLegacyLedger, legacyLiveLock, legacyLockRefusal } from "../issues/legacy";
import { pruneLedger } from "../issues/ledger";
import { acquireLock, liveLockOwner, pidAlive, readLock, versionLockPath, type LockResult } from "../issues/lock";
import { createApp } from "../server/app";
import { testProviderService } from "../server/fixtures/test-providers";
import { readGoalDraftOwnerState } from "../server/goal-draft-owner";
import {
  controlDirectory,
  ledgerPath,
  lockPath,
  runDirectory,
  runsDirectory,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/paths";
import { preflightIssues } from "../issues/preflight";
import { closedByRun, recordClosedByRun } from "../issues/self-close";
import {
  appendActivityLine,
  emptyState,
  loadState,
  loadStateWithText,
  parseRunFile,
  parseState,
  readActivity,
  trimActivityLines,
  writeActivity,
  writeRunFile,
  writeState,
  type IssuesIssue,
  type IssuesState,
  type RunFile,
} from "../issues/state";
import {
  fetchIssueState,
  parseResponse,
  pollOpenIssues,
  writeIssueProcessing,
  type IssueStateResult,
} from "../issues/tracker";
import {
  IssuesWorker,
  MAX_CONCURRENT_PEERS,
  MAX_FOLLOW_UP_TURNS,
  isGoalIssue,
  promptFor,
  reconcileProcessingLabels,
  type AcpPeer,
  type IssuesPeerOptions,
  type WorkerOptions,
} from "../issues/worker";

/**
 * Durable worker tests. Every fixture lives under `.devboard/.tmp`; the tracker
 * is a list, the ACP peer is a controllable fake, and no GitHub object, model,
 * or process outside the test is involved.
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

function issue(number: number, title = `Issue ${number}`, labels: string[] = []): IssuesIssue {
  return {
    number,
    title,
    url: `https://github.com/acme/fixture/issues/${number}`,
    createdAt: `2026-10-${String(20 + (number % 5)).padStart(2, "0")}T00:00:00Z`,
    labels,
  };
}

function goalIssue(number: number, title = `Goal ${number}`): IssuesIssue {
  return issue(number, title, ["goal"]);
}

/** A finished run record only the previous state document can still name. */
function finishedRun(runId: string, root: string): RunFile {
  return {
    version: 1,
    runId,
    repo: "acme/fixture",
    status: "succeeded",
    argv: ["omp", "acp"],
    cwd: root,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    exitCode: 0,
    issues: [],
    firstStderrLine: null,
    workerPid: 1,
    harnessVersion: "0.1.test",
  };
}

/**
 * Polls a fixture's in-memory state. The suite runs files in parallel, so a
 * worker write can lag the awaited call by seconds under load; the deadline is
 * generous for that reason and never shortens a wait that already succeeded.
 */
async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

/**
 * Completes one poll this call owns. The worker skips a poll call while an
 * interval poll is still in flight, so a single call can report no completion
 * of its own; repeat it until the poll that finished is one this call asked
 * for.
 */
async function pollCompleted(fixture: Fixture, timeoutMs = 20_000): Promise<void> {
  const before = fixture.state().poll.lastPollAt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await fixture.worker.poll();
    if (fixture.state().poll.lastPollAt !== before) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for a completed poll");
}

/** A live process plus the exact identity `recordedChildAlive` compares. */
async function recordedProcess() {
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
        return argv.length > 0 ? { pid, argv, cwd } : undefined;
      } catch {
        return undefined;
      }
    },
    "a child identity",
    2000,
  );
  return { child, identity };
}

class ControlledPeer implements AcpPeer {
  readonly pid = undefined;
  readonly argv = ["stub-acp"];
  readonly prompts: string[] = [];
  readonly activity: AcpActivity[] = [];
  readonly questions: AcpQuestion[] = [];
  closed = false;
  private turn: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  private readonly options: IssuesPeerOptions;
  readonly environment: Record<string, string | undefined> | undefined;

  constructor(options: IssuesPeerOptions) {
    this.options = options;
    this.environment = options.env;
  }

  run(prompt: string): Promise<unknown> {
    return this.startTurn(prompt);
  }

  prompt(prompt: string): Promise<unknown> {
    return this.startTurn(prompt);
  }

  private startTurn(prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    const deferred = Promise.withResolvers<unknown>();
    this.turn = { resolve: deferred.resolve, reject: deferred.reject };
    return deferred.promise;
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
    const turn = this.turn;
    this.turn = undefined;
    turn?.reject(new Error("Agent process exited before answering."));
  }

  emit(text: string, append = false): void {
    this.options.onActivity({ text, append });
  }

  ask(question: AcpQuestion): void {
    this.questions.push(question);
    this.options.onQuestion(question);
  }

  /** Ends the current turn cleanly; the worker then verifies the issue. */
  succeed(): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.resolve({});
  }

  fail(message: string): void {
    const turn = this.turn;
    this.turn = undefined;
    this.options.onStderr(`${message}\n`);
    turn?.reject(new Error(message));
  }

  /** Writes to the child's stderr without ending the turn. */
  writeStderr(message: string): void {
    this.options.onStderr(`${message}\n`);
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
  issueState?: (number: number) => Promise<IssueStateResult>;
  writeProcessing?: WorkerOptions["writeProcessing"];
  listIssues?: WorkerOptions["listIssues"];
  providerEnvironment?: WorkerOptions["providerEnvironment"];
  pollTimeoutMs?: number;
  turnSilenceMs?: number;
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
    ...(options.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: options.pollTimeoutMs }),
    ...(options.turnSilenceMs === undefined ? {} : { turnSilenceMs: options.turnSilenceMs }),
    ...(options.providerEnvironment === undefined
      ? {}
      : { providerEnvironment: options.providerEnvironment }),
    listIssues:
      options.listIssues ??
      (async () => ({ kind: "issues", issues: [...issues], etag: "etag-1" })),
    issueState: options.issueState ?? (async () => ({ kind: "state", state: "closed" })),
    writeProcessing: options.writeProcessing ?? (async () => ({ kind: "ok" })),
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
    path: versionedStatePath(
      stateDir,
      root,
      options.harnessVersion ?? readHarnessVersion(harnessRoot),
    ),
  };
}

async function stop(fixtureUnderTest: Fixture): Promise<void> {
  await fixtureUnderTest.worker.stop();
}

/**
 * Ends every turn a peer opens, up to the bound the worker enforces, so a run
 * whose issue never closes reaches its failure verdict.
 */
async function exhaustTurns(peer: ControlledPeer): Promise<void> {
  for (let turn = 1; turn <= MAX_FOLLOW_UP_TURNS + 1; turn += 1) {
    peer.succeed();
    if (turn > MAX_FOLLOW_UP_TURNS) return;
    await waitFor(
      () => (peer.prompts.length === turn + 1 ? true : undefined),
      `follow-up turn ${turn + 1}`,
    );
  }
}

describe("per-issue fleet", () => {
  test("starts one peer per unhandled issue in the same poll, with exact prompts", async () => {
    const f = await fixture({
      issues: [issue(1), issue(2), goalIssue(3), goalIssue(4)],
    });
    try {
      await waitFor(() => (f.peers.length === 4 ? true : undefined), "four peers");
      const prompts = f.peers.map((peer) => peer.prompts[0]).sort();
      expect(prompts).toEqual([
        "/implement-goal-issue 3",
        "/implement-goal-issue 4",
        "/implement-issue 1",
        "/implement-issue 2",
      ]);
      expect(f.peers.every((peer) => peer.prompts.length === 1)).toBe(true);
      expect(f.peers.every((peer) => peer.closed === false)).toBe(true);
      const agents = f.state().agents;
      expect(agents).toHaveLength(4);
      expect(agents.map((agent) => agent.issueNumber).sort()).toEqual([1, 2, 3, 4]);
      expect(new Set(agents.map((agent) => agent.runId)).size).toBe(4);
      expect(f.state().lifecycle).toBe("running");
    } finally {
      await stop(f);
    }
  });

  test("resolves the provider environment again for every issue run", async () => {
    let selection = 0;
    const f = await fixture({
      issues: [issue(1), issue(2), issue(3)],
      providerEnvironment: async () => ({ SELECTION: String((selection += 1)) }),
    });
    try {
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "three peers");
      expect(f.peers.map((peer) => peer.environment?.SELECTION).sort()).toEqual([
        "1",
        "2",
        "3",
      ]);
    } finally {
      await stop(f);
    }
  });

  test("starts at most thirty peers at once and fills a slot when one finishes", async () => {
    const issues = Array.from({ length: MAX_CONCURRENT_PEERS + 5 }, (_, index) =>
      issue(index + 1),
    );
    const f = await fixture({ issues });
    try {
      await waitFor(
        () => (f.peers.length === MAX_CONCURRENT_PEERS ? true : undefined),
        "thirty peers",
        8000,
      );
      await f.worker.poll();
      expect(f.peers).toHaveLength(MAX_CONCURRENT_PEERS);
      expect(f.state().agents).toHaveLength(MAX_CONCURRENT_PEERS);
      expect(f.state().agents.map((agent) => agent.issueNumber).sort((a, b) => a - b)).toEqual(
        issues.slice(0, MAX_CONCURRENT_PEERS).map((entry) => entry.number),
      );
      expect(
        f.state().queue.filter((entry) => entry.agentRunId === null).map((entry) => entry.number),
      ).toEqual(issues.slice(MAX_CONCURRENT_PEERS).map((entry) => entry.number));

      const finishing = f.peers.find((peer) => peer.prompts[0] === "/implement-issue 1")!;
      finishing.succeed();
      const started = await waitFor(
        () =>
          f.state().agents.find((agent) => agent.issueNumber === MAX_CONCURRENT_PEERS + 1),
        "the next queued peer",
      );
      expect(started.issueNumber).toBe(MAX_CONCURRENT_PEERS + 1);
      expect(f.peers).toHaveLength(MAX_CONCURRENT_PEERS + 1);
      expect(f.peers.filter((peer) => peer.closed === false)).toHaveLength(MAX_CONCURRENT_PEERS);
      expect(f.state().agents).toHaveLength(MAX_CONCURRENT_PEERS);
    } finally {
      await stop(f);
    }
  });

  test("never starts a second peer for an issue that already has one", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), goalIssue(3), issue(4)] });
    try {
      await waitFor(() => (f.peers.length === 4 ? true : undefined), "four peers");
      await f.worker.poll();
      await f.worker.poll();
      expect(f.peers).toHaveLength(4);
      expect(f.state().agents).toHaveLength(4);
    } finally {
      await stop(f);
    }
  });

  test("a tracker read that outlives its deadline records an error and polls again", async () => {
    let now = new Date("2026-10-29T00:00:00Z");
    let reads = 0;
    const f = await fixture({
      now: () => now,
      pollTimeoutMs: 20,
      listIssues: () => {
        reads += 1;
        if (reads === 1) return new Promise<never>(() => undefined);
        return Promise.resolve({ kind: "issues", issues: [], etag: null });
      },
    });
    try {
      const failed = await waitFor(
        () => (f.state().poll.error === null ? undefined : f.state().poll),
        "the timed-out poll",
      );
      expect(failed.error).toContain("did not answer within 20 ms");
      expect(failed.nextPollAt).toBe(new Date(now.getTime() + 60_000).toISOString());
      expect(f.state().lastError).toBe(failed.error);

      now = new Date(now.getTime() + 61_000);
      await waitFor(() => (reads >= 2 ? true : undefined), "a poll after the deadline");
      const recovered = await waitFor(
        () => (f.state().poll.error === null ? f.state().poll : undefined),
        "the recovered poll",
      );
      expect(recovered.lastPollAt).toBe(now.toISOString());
    } finally {
      await stop(f);
    }
  });

  test("starts a peer for an issue first seen while three peers run", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), issue(3)] });
    try {
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "three peers");
      const before = [...f.peers];
      f.issues.push(issue(4));
      await f.worker.poll();
      const fourth = await waitFor(
        () => f.peers.find((peer) => peer.prompts[0] === "/implement-issue 4"),
        "the fourth peer",
      );
      expect(fourth).toBeDefined();
      expect(f.peers).toHaveLength(4);
      expect(before.every((peer) => peer.closed === false)).toBe(true);
      expect(f.state().agents.map((agent) => agent.issueNumber).sort()).toEqual([1, 2, 3, 4]);
    } finally {
      await stop(f);
    }
  });

  test("records one handled ledger entry per successful issue", async () => {
    const f = await fixture({ issues: [issue(1), goalIssue(2)] });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      for (const peer of f.peers) peer.succeed();
      const handled = await waitFor(
        () => (f.state().queue.every((entry) => entry.handled) ? f.state() : undefined),
        "both handled",
      );
      expect(handled.agents).toEqual([]);
      expect(handled.runs.every((run) => run.status === "succeeded")).toBe(true);
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(Object.keys(ledger.handled).sort()).toEqual(["1", "2"]);
      expect(ledger.handled["1"].runId).not.toBe(ledger.handled["2"].runId);
      expect(handled.lifecycle).toBe("idle");
    } finally {
      await stop(f);
    }
  });

  test("a turn that leaves its issue open fails after its follow-up turns", async () => {
    const f = await fixture({
      issues: [issue(1)],
      issueState: async () => ({ kind: "state", state: "open" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      f.peers[0]!.writeStderr("implement-goal-issue: no write access");
      await exhaustTurns(f.peers[0]!);
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(1) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed run",
      );
      expect(f.peers[0]!.prompts).toHaveLength(MAX_FOLLOW_UP_TURNS + 1);
      expect(f.peers[0]!.prompts[1]).toContain("Continue issue #1");
      expect(failed.queue.find((entry) => entry.number === 1)?.handled).toBe(false);
      const run = failed.runs.find((entry) => entry.issueNumbers.includes(1));
      expect(run?.firstStderrLine).toContain("issue #1 is still open");
      expect(run?.firstStderrLine).toContain("no write access");
      expect(failed.agents).toEqual([]);
      expect(failed.cooldowns["1"]).toBeDefined();
      if (existsSync(ledgerPath(f.stateDir, f.root))) {
        const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
        expect(ledger.handled["1"]).toBeUndefined();
      }
    } finally {
      await stop(f);
    }
  });

  test("a turn that yields before closing its issue gets a follow-up turn", async () => {
    let reads = 0;
    const f = await fixture({
      issues: [issue(1)],
      issueState: async () => {
        reads += 1;
        return { kind: "state", state: reads === 1 ? "open" : "closed" } as IssueStateResult;
      },
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the peer");
      peer.succeed();
      await waitFor(() => (peer.prompts.length === 2 ? true : undefined), "the follow-up turn");
      expect(peer.closed).toBe(false);
      expect(peer.prompts[0]).toBe("/implement-issue 1");
      expect(peer.prompts[1]).toContain("Continue issue #1");
      expect(peer.prompts[1]).toContain(`Follow-up turn 2 of ${MAX_FOLLOW_UP_TURNS + 1}`);
      peer.succeed();
      const handled = await waitFor(
        () =>
          f.state().queue.find((entry) => entry.number === 1)?.handled ? f.state() : undefined,
        "the handled issue",
      );
      expect(peer.closed).toBe(true);
      expect(handled.runs.find((run) => run.issueNumbers.includes(1))?.status).toBe("succeeded");
      expect(handled.lastError).toBeNull();
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(Object.keys(ledger.handled)).toEqual(["1"]);
    } finally {
      await stop(f);
    }
  });

  test("clears a still-open error when a later poll drops that issue", async () => {
    const f = await fixture({
      issues: [issue(1)],
      issueState: async () => ({ kind: "state", state: "open" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      await exhaustTurns(f.peers[0]!);
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(1) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed run",
      );
      expect(failed.lastError).toContain("issue #1 is still open");
      f.issues.length = 0;
      await f.worker.poll();
      const closed = f.state();
      expect(closed.lastError).toBeNull();
      expect(closed.queue).toEqual([]);
      expect(closed.runs.find((run) => run.issueNumbers.includes(1))?.status).toBe("failed");
    } finally {
      await stop(f);
    }
  });

  test("a failed issue-state lookup fails the run without handling it", async () => {
    const f = await fixture({
      issues: [issue(1)],
      issueState: async () => ({ kind: "error", detail: "tracker unreachable" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      f.peers[0]!.succeed();
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(1) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed run",
      );
      expect(failed.queue.find((entry) => entry.number === 1)?.handled).toBe(false);
      expect(failed.runs.find((run) => run.issueNumbers.includes(1))?.firstStderrLine).toContain(
        "could not verify issue #1: tracker unreachable",
      );
      expect(failed.cooldowns["1"]).toBeDefined();
    } finally {
      await stop(f);
    }
  });

  test("a closed issue still records exactly one handled entry", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      f.peers[0]!.succeed();
      const handled = await waitFor(
        () => (f.state().queue.every((entry) => entry.handled) ? f.state() : undefined),
        "the handled queue",
      );
      expect(handled.agents).toEqual([]);
      expect(handled.runs.find((run) => run.issueNumbers.includes(1))?.status).toBe("succeeded");
    } finally {
      await stop(f);
    }
  });

  test("a failed agent cools down only its own issue while the others run", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), issue(3), issue(4)] });
    try {
      await waitFor(() => (f.peers.length === 4 ? true : undefined), "four peers");
      const failing = f.peers.find((peer) => peer.prompts[0] === "/implement-issue 2")!;
      failing.fail("the tracker refused the push");
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(2) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed run",
      );
      expect(failed.runs.find((run) => run.issueNumbers.includes(2))?.firstStderrLine).toBe(
        "the tracker refused the push",
      );
      expect(failed.queue.find((entry) => entry.number === 2)?.handled).toBe(false);
      const until = Date.parse(failed.cooldowns["2"] ?? "");
      expect(until - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      expect(failed.cooldowns["1"]).toBeUndefined();
      expect(failed.cooldowns["3"]).toBeUndefined();
      expect(failed.cooldowns["4"]).toBeUndefined();
      expect(failed.agents).toHaveLength(3);
      expect(f.peers.filter((peer) => peer.closed).length).toBe(1);

      await f.worker.poll();
      expect(f.peers).toHaveLength(4);
      expect(f.state().lifecycle).toBe("running");

      for (const peer of f.peers) {
        if (!peer.closed) peer.succeed();
      }
      const settled = await waitFor(
        () => (f.state().agents.length === 0 ? f.state() : undefined),
        "the other agents to finish",
      );
      expect(settled.lifecycle).toBe("failed");
      expect(settled.cooldowns["2"]).toBeDefined();
    } finally {
      await stop(f);
    }
  });

  test("Check now clears every cooldown and retries the gated issue", async () => {
    const f = await fixture({ issues: [issue(1), issue(2)] });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      const failing = f.peers[0]!;
      const failingPrompt = failing.prompts[0]!;
      failing.fail("first attempt failed");
      await waitFor(() => (Object.keys(f.state().cooldowns).length === 1 ? true : undefined), "a cooldown");
      expect(f.peers).toHaveLength(2);

      writeCommand(controlDirectory(f.stateDir, f.root), { type: "check" });
      const retried = await waitFor(
        () => f.peers.find((peer) => peer.prompts[0] === failingPrompt && peer !== failing),
        "the retried peer",
      );
      expect(retried).toBeDefined();
      await waitFor(() => (Object.keys(f.state().cooldowns).length === 0 ? true : undefined), "no cooldowns");
    } finally {
      await stop(f);
    }
  });

  test("a poll with no unhandled issue starts no peer and publishes idle", async () => {
    const f = await fixture({ issues: [] });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
      expect(f.peers).toHaveLength(0);
      expect(f.state().lifecycle).toBe("idle");
      expect(f.state().agents).toEqual([]);
    } finally {
      await stop(f);
    }
  });

  test("a handled issue is not retriggered and a reopened one is new again", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const first = await waitFor(() => f.peers[0], "the first peer");
      first.succeed();
      await waitFor(
        () => (f.state().queue.every((entry) => entry.handled) ? true : undefined),
        "the handled queue",
      );
      await f.worker.poll();
      expect(f.peers).toHaveLength(1);

      f.issues.splice(0, f.issues.length);
      await f.worker.poll();
      expect(f.state().queue).toEqual([]);
      await waitFor(() => (Object.keys(JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8")).handled).length === 0 ? true : undefined), "the pruned ledger");

      f.issues.push(issue(1));
      await f.worker.poll();
      const reopened = await waitFor(() => f.peers[1], "the reopened peer");
      expect(reopened.prompts).toEqual(["/implement-issue 1"]);
    } finally {
      await stop(f);
    }
  });
});

describe("per-agent state and answers", () => {
  test("keeps each agent's activity, run directory, and question separate", async () => {
    const f = await fixture({ issues: [issue(1), issue(2)] });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      const [first, second] = f.peers;
      first!.ask({ id: 9, message: "First scope?", options: [], properties: {}, required: undefined });
      second!.ask({ id: 9, message: "Second scope?", options: [], properties: {}, required: undefined });
      first!.emit("first output");
      second!.emit("second output");
      const asked = await waitFor(
        () => (f.state().agents.every((agent) => agent.question !== null) ? f.state() : undefined),
        "both questions",
      );
      const firstAgent = asked.agents.find((agent) => agent.issueNumber === 1)!;
      const secondAgent = asked.agents.find((agent) => agent.issueNumber === 2)!;
      expect(firstAgent.question?.message).toBe("First scope?");
      expect(secondAgent.question?.message).toBe("Second scope?");

      const runsBase = runsDirectory(f.stateDir, f.root);
      expect(readdirSync(runsBase).sort()).toEqual(
        [firstAgent.runId, secondAgent.runId].sort(),
      );
      expect(readActivity(join(runsBase, firstAgent.runId))).toEqual(["first output"]);
      expect(readActivity(join(runsBase, secondAgent.runId))).toEqual(["second output"]);

      writeCommand(controlDirectory(f.stateDir, f.root), {
        type: "answer",
        id: 9,
        value: "only first",
        runId: firstAgent.runId,
      });
      const answered = await waitFor(
        () =>
          f.state().agents.find((agent) => agent.runId === firstAgent.runId)?.question === null
            ? f.state()
            : undefined,
        "the first answer",
      );
      expect(answered.agents.find((agent) => agent.runId === secondAgent.runId)?.question).not.toBeNull();
      expect(first!.activity.map((entry) => entry.text)).toContain("answered only first");
      expect(second!.activity.map((entry) => entry.text)).not.toContain("answered only first");
    } finally {
      await stop(f);
    }
  });

  test("refuses an answer without a run id or with an unknown one", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      const peer = await waitFor(() => f.peers[0], "the peer");
      peer.ask({ id: 4, message: "Which scope?", options: [], properties: {}, required: undefined });
      const agent = await waitFor(
        () => f.state().agents.find((entry) => entry.question !== null),
        "the question",
      );
      const answers = controlDirectory(f.stateDir, f.root);

      writeCommand(answers, { type: "answer", id: 4, value: "missing run" });
      await waitFor(
        () => (f.state().notice === "An answer needs its run id." ? true : undefined),
        "the missing-run refusal",
      );
      expect(peer.activity.map((entry) => entry.text)).not.toContain("answered missing run");

      writeCommand(answers, { type: "answer", id: 4, value: "unknown run", runId: "not-a-run" });
      await waitFor(
        () => (f.state().notice === "That question is no longer waiting for an answer." ? true : undefined),
        "the unknown-run refusal",
      );
      expect(peer.activity.map((entry) => entry.text)).not.toContain("answered unknown run");
      expect(f.state().agents.find((entry) => entry.runId === agent.runId)?.question).not.toBeNull();
    } finally {
      await stop(f);
    }
  });

  test("a successful run removes only its own worktree record and closes its peer", async () => {
    const f = await fixture({ issues: [issue(1), issue(2)] });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      const [first, second] = f.peers;
      first!.succeed();
      const after = await waitFor(
        () => (f.state().agents.length === 1 ? f.state() : undefined),
        "one agent left",
      );
      expect(after.agents[0]?.issueNumber).toBe(2);
      expect(first!.closed).toBe(true);
      expect(second!.closed).toBe(false);
      expect(after.queue.find((entry) => entry.number === 1)?.handled).toBe(true);
      expect(after.queue.find((entry) => entry.number === 2)?.agentRunId).toBe(
        after.agents[0]?.runId,
      );
    } finally {
      await stop(f);
    }
  });
});

describe("ledger persistence failure", () => {
  test("a successful turn settles even when the ledger cannot be written", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "one peer");
      // A directory at the ledger path makes the atomic rename fail without
      // depending on filesystem permissions (the suite may run as root).
      const ledgerFile = ledgerPath(f.stateDir, f.root);
      await mkdir(ledgerFile);
      f.peers[0]!.succeed();
      const settled = await waitFor(
        () => (f.state().agents.length === 0 ? f.state() : undefined),
        "the run to settle despite the ledger write",
      );
      expect(settled.queue.find((entry) => entry.number === 1)?.handled).toBe(true);
      expect(settled.runs.find((run) => run.issueNumbers.includes(1))?.status).toBe("succeeded");
      expect(settled.lifecycle).toBe("idle");
      expect(settled.lastError).toContain("could not write the ledger");
      expect(readdirSync(ledgerFile)).toEqual([]);
    } finally {
      await stop(f);
    }
  });

  test("a poll's ledger write failure is recorded and the ticker keeps polling", async () => {
    const f = await fixture({ issues: [issue(1)] });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "one peer");
      const ledgerFile = ledgerPath(f.stateDir, f.root);
      await mkdir(ledgerFile);
      f.peers[0]!.succeed();
      await waitFor(
        () => (f.state().agents.length === 0 ? true : undefined),
        "the run to settle",
      );
      // The in-memory ledger now handles issue 1; closing it forces applyIssues
      // to prune and persist.
      f.issues.splice(0, f.issues.length);
      // `tick` is private; the test drives one interval iteration deterministically.
      const tick = Reflect.get(f.worker, "tick") as () => Promise<void>;
      await tick.call(f.worker);
      const polled = f.state();
      expect(polled.queue).toEqual([]);
      expect(polled.lastError).toContain("could not write the ledger");
      expect(polled.poll.lastPollAt).not.toBeNull();
      expect(polled.lifecycle).toBe("idle");
      // The ticker survived the rejection that the unguarded write produced.
      await tick.call(f.worker);
    } finally {
      await stop(f);
    }
  });
});

describe("lifecycle", () => {
  test("a pause applied while a begin is pending starts no peer for the rest of the queue", async () => {
    const firstHeld = Promise.withResolvers<void>();
    let providerCalls = 0;
    const f = await fixture({
      issues: [issue(1), issue(2), issue(3), issue(4)],
      providerEnvironment: async () => {
        providerCalls += 1;
        if (providerCalls === 1) await firstHeld.promise;
        return { SELECTION: String(providerCalls) };
      },
    });
    try {
      const polling = f.worker.poll();
      await waitFor(() => (providerCalls === 1 ? true : undefined), "the first begin");
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "pause" });
      // Consume the command the way the ticker does while the poll is in flight.
      const tick = Reflect.get(f.worker, "tick") as () => Promise<void>;
      await tick.call(f.worker);
      expect(f.state().paused).toBe(true);
      firstHeld.resolve();
      await polling;
      expect(f.peers).toHaveLength(1);
      expect(providerCalls).toBe(1);
      expect(f.state().runs).toHaveLength(1);
      expect(f.state().agents).toHaveLength(1);
      expect(
        f.state().queue.filter((entry) => entry.agentRunId === null).map((entry) => entry.number),
      ).toEqual([2, 3, 4]);
      // The next entry into maybeTrigger still refuses while paused.
      const maybeTrigger = Reflect.get(f.worker, "maybeTrigger") as () => Promise<void>;
      await maybeTrigger.call(f.worker);
      expect(f.peers).toHaveLength(1);
      expect(f.state().runs).toHaveLength(1);
    } finally {
      await stop(f);
    }
  });

  test("pause drains every peer before reporting paused", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), goalIssue(3)] });
    try {
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "three peers");
      const workerVersion = f.state().worker?.harnessVersion ?? null;
      const liveRuns = f.state().runs.filter((run) => run.status === "running");
      expect(liveRuns).toHaveLength(3);
      expect(liveRuns.every((run) => run.harnessVersion === workerVersion)).toBe(true);
      expect(liveRuns.every((run) => run.workerPid === f.state().worker?.pid)).toBe(true);
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "pause" });
      await waitFor(() => (f.state().lifecycle === "pausing" ? true : undefined), "pausing");
      expect(f.state().pauseSource).toBe("operator");
      expect(f.peers.every((peer) => peer.closed === false)).toBe(true);
      f.peers[0]!.succeed();
      expect(f.state().lifecycle).toBe("pausing");
      f.peers[1]!.succeed();
      f.peers[2]!.succeed();
      const paused = await waitFor(
        () => (f.state().lifecycle === "paused" ? f.state() : undefined),
        "paused",
      );
      expect(paused.paused).toBe(true);
      expect(paused.agents).toEqual([]);
    } finally {
      await stop(f);
    }
  });

  test("Stop closes every peer, stops every run, and writes no cooldown", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), goalIssue(3)] });
    try {
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "three peers");
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "stop" });
      const stopped = await waitFor(
        () => (f.state().lifecycle === "stopped" ? f.state() : undefined),
        "stopped",
      );
      expect(f.peers.every((peer) => peer.closed === true)).toBe(true);
      expect(stopped.runs.map((run) => run.status)).toEqual(["stopped", "stopped", "stopped"]);
      expect(stopped.agents).toEqual([]);
      expect(stopped.cooldowns).toEqual({});
      expect(stopped.queue.every((entry) => entry.handled === false)).toBe(true);
      expect(existsSync(lockPath(f.root))).toBe(false);
    } finally {
      await stop(f);
    }
  });

  test("check now while paused writes a notice and polls nothing", async () => {
    const f = await fixture({ issues: [] });
    try {
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "pause" });
      await waitFor(() => (f.state().lifecycle === "paused" ? true : undefined), "paused");
      const last = f.state().poll.lastPollAt;
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "check" });
      const notice = await waitFor(() => f.state().notice, "the refusal notice");
      expect(notice).toBe("Check now is unavailable while paused.");
      expect(f.state().poll.lastPollAt).toBe(last);
    } finally {
      await stop(f);
    }
  });
});

describe("goal issue settlement", () => {
  test("a goal left open by a finished turn gets the continuation turn", async () => {
    let reads = 0;
    const f = await fixture({
      issues: [goalIssue(12)],
      issueState: async () => {
        reads += 1;
        return { kind: "state", state: reads === 1 ? "open" : "closed" } as IssueStateResult;
      },
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the peer");
      expect(peer.prompts[0]).toBe("/implement-goal-issue 12");
      peer.succeed();
      await waitFor(() => (peer.prompts.length === 2 ? true : undefined), "the continuation turn");
      expect(peer.prompts[1]).toContain("Continue issue #12");
      expect(peer.closed).toBe(false);
      peer.succeed();
      const handled = await waitFor(
        () =>
          f.state().queue.find((entry) => entry.number === 12)?.handled ? f.state() : undefined,
        "the handled goal issue",
      );
      expect(handled.runs.find((run) => run.issueNumbers.includes(12))?.status).toBe("succeeded");
      expect(closedByRun(f.stateDir, f.root, 12)).toBeNull();
    } finally {
      await stop(f);
    }
  });

  test("a goal-issue peer that stops answering fails the run naming the open issue", async () => {
    let now = new Date("2026-11-02T12:00:00.000Z");
    const f = await fixture({
      issues: [goalIssue(7)],
      now: () => now,
      turnSilenceMs: 60_000,
      issueState: async () => ({ kind: "state", state: "open" }),
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the peer");
      expect(peer.prompts[0]).toBe("/implement-goal-issue 7");
      // The peer never answers its turn and produces no further output.
      await f.worker.poll();
      expect(f.state().runs.some((run) => run.issueNumbers.includes(7) && run.status === "running"))
        .toBe(true);

      now = new Date(now.getTime() + 61_000);
      await f.worker.poll();
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(7) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed goal run",
      );
      expect(peer.closed).toBe(true);
      expect(failed.lastError).toContain("the agent produced no output");
      expect(failed.lastError).toContain("issue #7 is still open");
      expect(failed.queue.find((entry) => entry.number === 7)?.handled).toBe(false);
      expect(failed.cooldowns["7"]).toBeDefined();
      expect(failed.agents).toEqual([]);
      expect(failed.runs.find((run) => run.issueNumbers.includes(7))?.firstStderrLine).toContain(
        "issue #7 is still open",
      );
    } finally {
      await stop(f);
    }
  });

  test("a poll that drops a still-open goal issue fails the run instead of stopping it", async () => {
    let open = [goalIssue(9)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
      issueState: async () => ({ kind: "state", state: "open" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      open = [];
      await f.worker.poll();
      const failed = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(9) && run.status === "failed")
            ? f.state()
            : undefined,
        "the failed goal run",
      );
      expect(failed.runs.find((run) => run.issueNumbers.includes(9))?.status).toBe("failed");
      expect(
        failed.runs.find((run) => run.issueNumbers.includes(9))?.firstStderrLine,
      ).toContain("the tracker dropped issue #9 from its open list while it is still open");
      // The run is never recorded stopped while the tracker still says open,
      // and the cooldown keeps the next poll from restarting it at once.
      expect(failed.runs.filter((run) => run.status === "stopped")).toEqual([]);
      expect(failed.cooldowns["9"]).toBeDefined();
    } finally {
      await stop(f);
    }
  });

  test("a goal-issue run whose issue the tracker proves closed is still stopped", async () => {
    let open = [goalIssue(9)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
      issueState: async () => ({ kind: "state", state: "closed" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      open = [];
      await f.worker.poll();
      const stopped = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(9) && run.status === "stopped")
            ? f.state()
            : undefined,
        "the stopped goal run",
      );
      expect(stopped.notice).toBe("Issue #9 was closed on the tracker; its run was stopped.");
      expect(stopped.queue).toEqual([]);
      expect(stopped.cooldowns).toEqual({});
      expect(closedByRun(f.stateDir, f.root, 9)).toBeNull();
      // No run recorded the close, so nothing may claim it was handled.
      expect(existsSync(ledgerPath(f.stateDir, f.root))).toBe(false);
    } finally {
      await stop(f);
    }
  });

  test("a goal-issue run that closes its own issue settles succeeded with no notice", async () => {
    let open = [goalIssue(9)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
      issueState: async () => ({ kind: "state", state: "closed" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      const runId = f.state().agents[0]!.runId;
      expect(f.peers[0]!.environment?.DEVBOARD_ISSUES_RUN_ID).toBe(runId);
      recordClosedByRun(f.stateDir, f.root, 9, runId);

      // The run's own close drops #9 from the open list while its turn runs.
      open = [];
      await f.worker.poll();
      expect(f.peers[0]!.closed).toBe(false);
      expect(f.state().agents.map((agent) => agent.issueNumber)).toEqual([9]);
      expect(f.state().notice).toBeNull();

      f.peers[0]!.succeed();
      const settled = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(9))?.status === "succeeded"
            ? f.state()
            : undefined,
        "the succeeded goal run",
      );
      expect(settled.agents).toEqual([]);
      expect(settled.notice).toBeNull();
      expect(settled.cooldowns).toEqual({});
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(ledger.handled["9"]?.runId).toBe(runId);
      expect(closedByRun(f.stateDir, f.root, 9)).toBeNull();
    } finally {
      await stop(f);
    }
  });
});

describe("closed issues", () => {
  test("a poll that no longer lists a running issue stops that run", async () => {
    let open = [issue(1), issue(2)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
    });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      expect(f.peers[0]?.prompts[0]).toBe("/implement-issue 1");
      open = [issue(2)];
      await f.worker.poll();
      const state = await waitFor(
        () => (f.state().agents.length === 1 ? f.state() : undefined),
        "one agent",
      );
      expect(f.peers[0]!.closed).toBe(true);
      expect(f.peers[1]!.closed).toBe(false);
      expect(state.notice).toContain("Issue #1 was closed on the tracker");
      expect(state.queue.map((entry) => entry.number)).toEqual([2]);
      expect(state.runs.map((run) => run.status).sort()).toEqual(["running", "stopped"]);
      expect(state.cooldowns).toEqual({});
      expect(state.agents.map((agent) => agent.issueNumber)).toEqual([2]);
    } finally {
      await stop(f);
    }
  });

  test("a run that closed its own issue settles instead of being stopped", async () => {
    let open = [issue(1)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "the peer");
      const runId = f.state().agents[0]!.runId;
      expect(f.peers[0]!.environment?.DEVBOARD_ISSUES_RUN_ID).toBe(runId);
      expect(f.peers[0]!.environment?.DEVBOARD_ISSUES_ISSUE_NUMBER).toBe("1");
      recordClosedByRun(f.stateDir, f.root, 1, runId);

      // The run's own close drops #1 from the open list while its turn runs.
      open = [];
      await f.worker.poll();
      expect(f.peers[0]!.closed).toBe(false);
      expect(f.state().agents.map((agent) => agent.issueNumber)).toEqual([1]);
      expect(f.state().notice).toBeNull();

      f.peers[0]!.succeed();
      const settled = await waitFor(
        () =>
          f.state().runs.find((run) => run.issueNumbers.includes(1))?.status === "succeeded"
            ? f.state()
            : undefined,
        "the succeeded run",
      );
      expect(settled.agents).toEqual([]);
      expect(settled.notice).toBeNull();
      const ledger = JSON.parse(readFileSync(ledgerPath(f.stateDir, f.root), "utf8"));
      expect(ledger.handled["1"]?.runId).toBe(runId);
      expect(closedByRun(f.stateDir, f.root, 1)).toBeNull();
    } finally {
      await stop(f);
    }
  });

  test("an abandon command stops only that issue and suppresses a restart", async () => {
    let open = [issue(1), issue(2)];
    const f = await fixture({
      issues: open,
      listIssues: async () => ({ kind: "issues", issues: [...open], etag: "etag-1" }),
    });
    try {
      await waitFor(() => (f.peers.length === 2 ? true : undefined), "two peers");
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "abandon", number: 1 });
      await waitFor(() => (f.state().agents.length === 1 ? true : undefined), "one agent");
      expect(f.peers[0]!.prompts[0]).toBe("/implement-issue 1");
      expect(f.peers[0]!.closed).toBe(true);
      expect(f.peers[1]!.closed).toBe(false);
      expect(f.state().runs.filter((run) => run.status === "stopped")).toHaveLength(1);

      // The worker's own read still lists #1, so its queue alone would restart
      // the dismissed issue. The suppression must hold.
      const before = f.state().poll.lastPollAt;
      await pollCompleted(f);
      expect(f.state().poll.lastPollAt).not.toBe(before);
      expect(f.peers).toHaveLength(2);
      expect(f.state().agents.map((agent) => agent.issueNumber)).toEqual([2]);

      // Once the read drops it and a later read lists it again, it is eligible.
      open = [issue(2)];
      await f.worker.poll();
      await waitFor(() => (f.state().queue.length === 1 ? true : undefined), "a one-issue queue");
      open = [issue(1), issue(2)];
      await f.worker.poll();
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "the reopened issue's peer");
      expect(f.peers[2]!.prompts[0]).toBe("/implement-issue 1");
    } finally {
      await stop(f);
    }
    // Two real stub peers, three polls, and a third peer spawn: under the
    // suite's own parallel file load this exceeds Bun's 5 s default bound.
  }, 40_000);
});

describe("history and isolation", () => {
  test("keeps every running run directory at the concurrency cap", async () => {
    const issues = Array.from({ length: MAX_CONCURRENT_PEERS }, (_, index) => issue(index + 1));
    const f = await fixture({ issues });
    try {
      await waitFor(
        () => (f.peers.length === MAX_CONCURRENT_PEERS ? true : undefined),
        "thirty peers",
        15_000,
      );
      const directories = readdirSync(runsDirectory(f.stateDir, f.root));
      expect(directories).toHaveLength(MAX_CONCURRENT_PEERS);
      expect(f.state().runs).toHaveLength(MAX_CONCURRENT_PEERS);
      expect(f.state().runs.every((run) => run.status === "running")).toBe(true);
    } finally {
      await stop(f);
    }
  });

  test("a cwd reached through a symlink still proves its recorded child", async () => {
    const base = await temporaryDirectory("recorded-symlink");
    const real = join(base, "real");
    const link = join(base, "link");
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setTimeout(() => undefined, 60_000)"],
      cwd: link,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const identity = await waitFor(
        () => {
          try {
            const argv = readFileSync(`/proc/${child.pid}/cmdline`, "utf8")
              .split("\u0000")
              .filter(Boolean);
            return argv.length > 0 ? { pid: child.pid, argv, cwd: link } : undefined;
          } catch {
            return undefined;
          }
        },
        "the symlinked child identity",
        2000,
      );
      expect(recordedChildAlive(identity)).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      expect(recordedChildAlive(identity)).toBe(false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });

  test("a fresh start terminates every recorded ACP child", async () => {
    const base = await temporaryDirectory("orphans");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const processes = await Promise.all([recordedProcess(), recordedProcess()]);
    const children = processes.map((entry) => entry.child);
    const identities = processes.map((entry) => entry.identity);
    const runIds = identities.map((_, index) => `orphan-${index}`);
    for (const runId of runIds) {
      writeRunFile(runDirectory(stateDir, root, runId), finishedRun(runId, root));
    }
    const path = statePath(stateDir, root);
    const stale = emptyState({ repo: "acme/fixture", root, intervalMs: 60_000 });
    writeState(path, {
      ...stale,
      enabled: true,
      lifecycle: "running",
      agents: identities.map((identity, index) => ({
        runId: runIds[index]!,
        issueNumber: index + 1,
        startedAt: new Date(0).toISOString(),
        question: null,
        acp: identity,
      })),
    });
    for (const identity of identities) {
      expect(recordedChildAlive(identity)).toBe(true);
    }
    expect(parseState(readFileSync(path, "utf8"))?.agents).toHaveLength(2);

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
      for (const child of children) {
        const outcome = await Promise.race([
          child.exited.then(() => "exited" as const),
          Bun.sleep(3000).then(() => "timeout" as const),
        ]);
        expect(outcome).toBe("exited");
      }
      expect(worker.currentState.agents).toEqual([]);
      for (const runId of runIds) {
        expect(worker.currentState.runs.find((run) => run.runId === runId)?.status).toBe("stopped");
        expect(
          parseRunFile(readFileSync(join(runDirectory(stateDir, root, runId), "run.json"), "utf8"))
            ?.status,
        ).toBe("stopped");
      }
    } finally {
      await worker.stop();
      for (const child of children) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already terminated by the worker.
        }
      }
    }
  });

  test("an unparseable state file still terminates recorded children and closes recorded runs", async () => {
    const base = await temporaryDirectory("quarantined-orphans");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const { child, identity } = await recordedProcess();
    const runId = "quarantined-run";
    writeRunFile(runDirectory(stateDir, root, runId), finishedRun(runId, root));
    const path = statePath(stateDir, root);
    await mkdir(dirname(path), { recursive: true });
    // Valid JSON the current schema rejects: the file is quarantined, but the
    // child and run it records must still be recovered.
    writeFileSync(
      path,
      JSON.stringify({
        version: 999,
        repo: "acme/fixture",
        root,
        enabled: true,
        lifecycle: "running",
        agents: [
          {
            runId,
            issueNumber: 1,
            startedAt: new Date(0).toISOString(),
            question: null,
            acp: identity,
          },
        ],
      }),
    );
    expect(parseState(readFileSync(path, "utf8"))).toBeUndefined();
    expect(recordedChildAlive(identity)).toBe(true);

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
      // The exit is a real process signal, so the bound is real time.
      const outcome = await Promise.race([
        child.exited.then(() => "exited" as const),
        Bun.sleep(3000).then(() => "timeout" as const),
      ]);
      expect(outcome).toBe("exited");
      expect(worker.currentState.runs.find((run) => run.runId === runId)?.status).toBe("stopped");
      expect(
        parseRunFile(readFileSync(join(runDirectory(stateDir, root, runId), "run.json"), "utf8"))
          ?.status,
      ).toBe("stopped");
      expect(readdirSync(dirname(path)).some((name) => name.includes(".invalid-"))).toBe(true);
    } finally {
      await worker.stop();
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already terminated by the worker.
      }
    }
  });

  test("two repositories sharing a state directory never share records", async () => {
    const base = await temporaryDirectory("isolation");
    const firstState = join(base, "state");
    const first = await fixture({ stateDir: firstState, issues: [issue(1)] });
    const second = await fixture({ stateDir: firstState, issues: [issue(2)], label: "isolation-two" });
    try {
      expect(first.path).not.toBe(second.path);
      const firstPeer = await waitFor(() => first.peers[0], "the first peer");
      const secondPeer = await waitFor(() => second.peers[0], "the second peer");
      expect(firstPeer.prompts).toEqual(["/implement-issue 1"]);
      expect(secondPeer.prompts).toEqual(["/implement-issue 2"]);
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

  test("writes atomically and quarantines damage", async () => {
    const f = await fixture({ issues: [], harnessVersion: "0.9.7" });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
      const state = f.state();
      expect(state.worker?.pid).toBe(process.pid);
      expect(state.worker?.harnessVersion).toBe("0.9.7");
      expect(
        readdirSync(join(f.stateDir, "issues", readdirSync(join(f.stateDir, "issues"))[0]!)).some(
          (name) => name.endsWith(".tmp"),
        ),
      ).toBe(false);
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
    writeFileSync(damaged, '{"version": 2, "root":');
    expect(loadState(damaged)).toBeUndefined();
    const names = readdirSync(join(damaged, ".."));
    expect(names.some((name) => name.includes(".invalid-"))).toBe(true);
  });

  test("reclaims a lock whose owner is gone", async () => {
    const base = await temporaryDirectory("reclaim");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(join(root, ".devboard", ".tmp", "issues"), { recursive: true });
    writeFileSync(
      lockPath(root),
      JSON.stringify({
        pid: 999_999_999,
        startedAt: new Date(0).toISOString(),
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: [],
      }),
    );
    const f = await fixture({ stateDir, issues: [] });
    const versioned = versionLockPath(lockPath(f.root), readHarnessVersion(harnessRoot));
    try {
      expect(liveLockOwner(versioned)?.pid).toBe(process.pid);
    } finally {
      await stop(f);
    }
    expect(existsSync(versioned)).toBe(false);
  });
});

describe("repository lock", () => {
  async function lockRoot(prefix: string): Promise<{ root: string; stateDir: string }> {
    const base = await temporaryDirectory(prefix);
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(dirname(lockPath(root)), { recursive: true });
    return { root, stateDir };
  }

  test("reports a lock whose owner is this process with the recorded start", async () => {
    const { root, stateDir } = await lockRoot("lock-live");
    const held = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    try {
      expect(liveLockOwner(lockPath(root))?.stateDir).toBe(stateDir);
    } finally {
      held.release();
    }
  });

  test("a paused reclaimer never replaces the fresh lock of a concurrent starter", async () => {
    const { root, stateDir } = await lockRoot("lock-reclaim-race");
    writeFileSync(
      lockPath(root),
      JSON.stringify({
        pid: 999_999_999,
        startedAt: new Date(0).toISOString(),
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: ["stale"],
      }),
    );
    // While this caller sits between inspecting the stale holder and
    // reclaiming it, a second starter reclaims the stale file itself and
    // creates a live lock.
    let winner: LockResult | undefined;
    const losing = acquireLock(
      lockPath(root),
      { repo: root, stateDir, harnessVersion: null, argv: ["losing"] },
      {
        onStaleLock: () => {
          winner = acquireLock(lockPath(root), {
            repo: root,
            stateDir,
            harnessVersion: null,
            argv: ["winner"],
          });
        },
      },
    );
    expect(winner?.acquired).toBe(true);
    expect(losing.acquired).toBe(false);
    const held = readLock(lockPath(root));
    expect(held?.argv).toEqual(["winner"]);
    expect(held?.pid).toBe(process.pid);
    if (winner?.acquired) winner.release();
    expect(existsSync(lockPath(root))).toBe(false);
  });

  for (const [label, startedAt] of [
    ["before this process started", new Date(0)],
    ["after this process started", new Date(Date.now() + 3_600_000)],
  ] satisfies [string, Date][]) {
    test(`reclaims a live pid recorded ${label}`, async () => {
      const { root, stateDir } = await lockRoot("lock-reused-pid");
      // The pid is this live process; only the recorded start is wrong, as it
      // would be for a stale lock whose pid the OS handed to another process.
      writeFileSync(
        lockPath(root),
        JSON.stringify({
          pid: process.pid,
          startedAt: startedAt.toISOString(),
          repo: root,
          stateDir,
          harnessVersion: null,
          argv: [],
        }),
      );
      expect(liveLockOwner(lockPath(root))).toBeUndefined();
      const reclaimed = acquireLock(lockPath(root), {
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: [],
      });
      expect(reclaimed.acquired).toBe(true);
      if (reclaimed.acquired) reclaimed.release();
    });
  }
});

describe("preflight", () => {
  async function checkoutWithTools(
    origin = "https://github.com/acme/fixture.git",
  ): Promise<{
    root: string;
    bin: string;
    home: string;
    environment: Record<string, string | undefined>;
  }> {
    const base = await temporaryDirectory("preflight");
    const root = join(base, "repo");
    const bin = join(base, "bin");
    const home = join(base, "home");
    await mkdir(join(root, ".devboard"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(home, { recursive: true });
    Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
    Bun.spawnSync({
      cmd: ["git", "-C", root, "remote", "add", "origin", origin],
    });
    for (const name of ["gh", "omp"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      Bun.spawnSync({ cmd: ["chmod", "+x", join(bin, name)] });
    }
    return {
      root,
      bin,
      home,
      environment: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
      },
    };
  }

  test("refuses a missing implement-issue command and names the remedies", async () => {
    const { root, home, environment } = await checkoutWithTools();
    await mkdir(join(home, ".omp", "commands"), { recursive: true });
    await mkdir(join(root, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(root, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");

    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment,
      run: () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("implement-issue.md");
    expect(result.message).toContain(join(root, ".omp", "commands"));
    expect(result.message).toContain(join(home, ".omp", "agent", "commands"));
    expect(result.message).toContain(".devboard/install.sh");
  });

  test("refuses a missing implement-goal-issue extension", async () => {
    const { root, home, environment } = await checkoutWithTools();
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");

    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment,
      run: () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("implement-goal-issue.ts");
    expect(result.message).toContain(join(root, ".omp", "extensions"));
    expect(result.message).toContain(join(home, ".omp", "extensions"));
    expect(result.message).toContain(".devboard/install.sh");
  });

  test("accepts both installed wrappers with push permission", async () => {
    const { root, home, environment } = await checkoutWithTools();
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    await mkdir(join(home, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");
    writeFileSync(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");

    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment,
      run: () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(result).toEqual({ ok: true, repository: "acme/fixture" });
  });

  test("a permission probe that never settles fails at the preflight deadline", async () => {
    const { root, home, environment } = await checkoutWithTools();
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    await mkdir(join(home, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");
    writeFileSync(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");

    const started = Date.now();
    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment,
      timeoutMs: 20,
      run: () => new Promise<never>(() => undefined),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("did not finish within 20 ms");
  });

  test("the default gh child is killed at the preflight deadline", async () => {
    const { root, bin, home, environment } = await checkoutWithTools();
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    await mkdir(join(home, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");
    writeFileSync(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");
    const pidFile = join(bin, "gh.pid");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$$" > ${JSON.stringify(pidFile)}\nwhile :; do :; done\n`,
    );
    Bun.spawnSync({ cmd: ["chmod", "+x", join(bin, "gh")] });

    const started = Date.now();
    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment,
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("did not finish within 200 ms");

    const pid = await waitFor(
      () => {
        if (!existsSync(pidFile)) return undefined;
        const text = readFileSync(pidFile, "utf8").trim();
        return text.length === 0 ? undefined : Number(text);
      },
      "the gh child to record its pid",
    );
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      },
      "the killed gh child to disappear",
    );
  });

  test("accepts a Gitea origin with a write-capable token", async () => {
    const { root, home, environment } = await checkoutWithTools(
      "ssh://git@localhost:2223/acme/fixture.git",
    );
    await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
    await mkdir(join(home, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");
    writeFileSync(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");

    const result = await preflightIssues({
      repoDir: root,
      stateDir: join(root, "state"),
      environment: {
        ...environment,
        DEVBOARD_GITEA_URL: "http://gitea.test",
        GITEA_TOKEN: "gitea-token",
      },
      giteaFetch: async () =>
        new Response(
          JSON.stringify({ permissions: { push: true, pull: true } }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    expect(result).toEqual({ ok: true, repository: "acme/fixture" });
  });
});

describe("processing label", () => {
  test("a run writes processing before its peer and clears it when it ends", async () => {
    const labels: Array<[number, boolean]> = [];
    const f = await fixture({
      issues: [issue(4)],
      writeProcessing: async (number, active) => {
        labels.push([number, active]);
        return { kind: "ok" };
      },
    });
    try {
      await waitFor(() => (f.peers.length === 1 ? true : undefined), "one peer");
      expect(labels).toEqual([[4, true]]);
      f.peers[0]!.succeed();
      await waitFor(() => (labels.length === 2 ? true : undefined), "the cleared label");
      expect(labels).toEqual([
        [4, true],
        [4, false],
      ]);
    } finally {
      await stop(f);
    }
  });

  test("a Gitea processing write ensures, adds, and removes only that label", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let created = false;
    const giteaFetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "GET" && url.includes("/labels?")) {
        // Page two repeats the same entry, which ends the paging loop.
        return Response.json(created ? [{ id: 15, name: "processing" }] : []);
      }
      if (method === "POST" && url.endsWith("/labels")) {
        created = true;
        return Response.json({ id: 15, name: "processing" });
      }
      if (method === "POST" && url.endsWith("/issues/4/labels")) {
        return Response.json([]);
      }
      if (method === "DELETE" && url.endsWith("/issues/4/labels/15")) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };
    const options = {
      repository: "acme/fixture",
      forge: "gitea" as const,
      baseUrl: "http://gitea.test",
      environment: {},
      giteaFetch,
    };
    expect(await writeIssueProcessing(options, 4, true)).toEqual({ kind: "ok" });
    expect(created).toBe(true);
    expect(calls).toContainEqual({ method: "POST", url: "http://gitea.test/api/v1/repos/acme/fixture/issues/4/labels" });
    expect(await writeIssueProcessing(options, 4, false)).toEqual({ kind: "ok" });
    expect(calls).toContainEqual({ method: "DELETE", url: "http://gitea.test/api/v1/repos/acme/fixture/issues/4/labels/15" });
  });

  test("a reconciler clears a processing label with no live claim", async () => {
    const root = await temporaryDirectory("processing-stale");
    const cleared: number[] = [];
    const listed = issue(9);
    listed.labels = ["processing", "goal"];
    await reconcileProcessingLabels({
      issues: [listed],
      repoDir: root,
      active: new Set<number>(),
      write: async (number) => {
        cleared.push(number);
        return { kind: "ok" };
      },
    });
    expect(cleared).toEqual([9]);
    expect(listed.labels).toEqual(["goal"]);
  });

  test("a reconciler leaves a processing label whose claim is live", async () => {
    const root = await temporaryDirectory("processing-claim");
    const cleared: number[] = [];
    const listed = issue(11);
    listed.labels = ["processing"];
    expect(
      claimIssue(root, 11, { runId: "pending-test", harnessVersion: null }),
    ).toBe(true);
    await reconcileProcessingLabels({
      issues: [listed],
      repoDir: root,
      active: new Set<number>(),
      write: async (number) => {
        cleared.push(number);
        return { kind: "ok" };
      },
    });
    expect(cleared).toEqual([]);
    expect(listed.labels).toEqual(["processing"]);
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
  test("returns an error when the tracker read outlives its deadline", async () => {
    const started = Date.now();
    const result = await pollOpenIssues({
      repository: "acme/fixture",
      timeoutMs: 20,
      run: () => new Promise<never>(() => undefined),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.detail).toContain("did not answer within 20 ms");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("bounds the issue-state probe by the same deadline", async () => {
    const state = await fetchIssueState(
      {
        repository: "acme/fixture",
        timeoutMs: 20,
        run: () => new Promise<never>(() => undefined),
      },
      7,
    );
    expect(state).toEqual({ kind: "error", detail: "the tracker did not answer within 20 ms" });
  });

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
      JSON.stringify({ ...issue(2), labels: ["goal", "bug"] }),
      JSON.stringify({
        number: 1,
        title: "Issue 1",
        url: "https://github.com/acme/fixture/issues/1",
        createdAt: "2026-10-21T00:00:00Z",
      }),
    ].join("\n");
    const result = await pollOpenIssues({
      repository: "acme/fixture",
      run: () => ({ code: 0, stdout: response, stderr: "" }),
    });
    expect(result.kind).toBe("issues");
    if (result.kind !== "issues") return;
    expect(result.issues.map((entry) => entry.number)).toEqual([1, 2]);
    expect(result.issues[0]?.labels).toEqual([]);
    expect(result.issues[1]?.labels).toEqual(["goal", "bug"]);
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

  test("reads one issue state through gh", async () => {
    const calls: string[][] = [];
    const state = await fetchIssueState(
      {
        repository: "acme/fixture",
        run: (argv) => {
          calls.push(argv);
          return { code: 0, stdout: "closed\n", stderr: "" };
        },
      },
      7,
    );
    expect(state).toEqual({ kind: "state", state: "closed" });
    expect(calls[0]).toEqual(["api", "repos/acme/fixture/issues/7", "--jq", ".state"]);
  });

  test("treats a missing issue and a failed probe as errors", async () => {
    const missing = await fetchIssueState(
      {
        repository: "acme/fixture",
        run: () => ({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }),
      },
      7,
    );
    expect(missing).toEqual({ kind: "error", detail: "gh: Not Found (HTTP 404)" });

    const failed = await fetchIssueState(
      {
        repository: "acme/fixture",
        run: () => ({ code: 1, stdout: "", stderr: "gh: connection reset" }),
      },
      7,
    );
    expect(failed).toEqual({ kind: "error", detail: "gh: connection reset" });
  });

  test("reads one Gitea issue state", async () => {
    const urls: string[] = [];
    const state = await fetchIssueState(
      {
        repository: "acme/fixture",
        forge: "gitea",
        baseUrl: "http://gitea.test",
        environment: {},
        giteaFetch: async (input) => {
          urls.push(input);
          return new Response(
            JSON.stringify({
              number: 7,
              title: "Issue 7",
              html_url: "http://gitea.test/acme/fixture/issues/7",
              state: "closed",
            }),
            { status: 200 },
          );
        },
      },
      7,
    );
    expect(state).toEqual({ kind: "state", state: "closed" });
    expect(urls[0]).toBe("http://gitea.test/api/v1/repos/acme/fixture/issues/7");
  });

  test("never builds a gh argv for a GitLab origin", async () => {
    const calls: string[][] = [];
    const run = (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const polled = await pollOpenIssues({ repository: "group/project", forge: "gitlab", run });
    expect(polled.kind).toBe("unsupported");
    if (polled.kind !== "unsupported") return;
    expect(polled.detail).toContain("GitLab");

    const state = await fetchIssueState({ repository: "group/project", forge: "gitlab", run }, 7);
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.detail).toContain("GitLab");
    expect(calls).toEqual([]);
  });

  test("still reads a GitHub origin through gh", async () => {
    const calls: string[][] = [];
    const polled = await pollOpenIssues({
      repository: "acme/fixture",
      forge: "github",
      run: (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "HTTP/2.0 200 OK\n\n", stderr: "" };
      },
    });
    expect(polled.kind).toBe("issues");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("api");
    expect(calls[0]?.includes("repos/acme/fixture/issues?state=open&per_page=100")).toBe(true);
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
      JSON.stringify({
        version: 1,
        handled: { "4": { number: 4, runId: "legacy", at: "2026-10-01T00:00:00Z" } },
      }),
    );

    expect(migrateLegacyLedger({ stateDir, repoDir: root })).toEqual([
      { number: 4, runId: "legacy", at: "2026-10-01T00:00:00Z" },
    ]);
    expect(migrateLegacyLedger({ stateDir, repoDir: join(base, "elsewhere") })).toBeUndefined();

    const f = await fixture({ root, stateDir, issues: [issue(4)] });
    try {
      await waitFor(() => (f.state().poll.lastPollAt !== null ? true : undefined), "the first poll");
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
    await mkdir(join(home, ".omp", "extensions"), { recursive: true });
    await mkdir(bin, { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "implement-issue.md"), "# command\n");
    writeFileSync(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");
    for (const name of ["gh", "omp"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      Bun.spawnSync({ cmd: ["chmod", "+x", join(bin, name)] });
    }
    writeFileSync(
      join(stateDir, "orchestrator", "lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
    Bun.spawnSync({
      cmd: ["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
    });

    const owner = legacyLiveLock(stateDir);
    expect(owner?.pid).toBe(process.pid);
    expect(legacyLockRefusal(owner!, stateDir)).toContain(
      "systemctl --user stop devboard-orchestrator.service",
    );
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
  test("accepts version 2 and rejects an unknown version", () => {
    const state: IssuesState = {
      version: 2,
      repo: "acme/fixture",
      root: "/tmp/repo",
      lifecycle: "stopped",
      enabled: false,
      paused: false,
      worker: null,
      poll: {
        intervalMs: 2000,
        lastPollAt: null,
        nextPollAt: null,
        etag: null,
        notModified: false,
        rateLimitedUntil: null,
        error: null,
      },
      queue: [],
      runs: [],
      agents: [],
      cooldowns: {},
      lastError: null,
      lastExitCode: null,
      finishedAt: null,
      notice: null,
      updatedAt: "2026-10-27T00:00:00Z",
    };
    expect(parseState(JSON.stringify({ ...state, version: 3 }))).toBeUndefined();
    expect(parseState(JSON.stringify(state))?.lifecycle).toBe("stopped");

    const path = join(testRoot, "state-document.json");
    writeState(path, state);
    expect(loadState(path)?.repo).toBe("acme/fixture");
  });

  test("recovers recorded children and run ids from a file it quarantines", () => {
    const path = join(testRoot, "quarantined-records.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 999,
        repo: "acme/fixture",
        root: "/tmp/repo",
        agents: [
          {
            runId: "agent-run",
            issueNumber: 1,
            startedAt: "2026-10-27T00:00:00Z",
            acp: { pid: 4242, argv: ["omp", "acp"], cwd: "/tmp/repo" },
          },
          {
            runId: "agent-run-2",
            issueNumber: 2,
            startedAt: "2026-10-27T00:00:01Z",
            acp: null,
          },
        ],
        acp: { pid: 4343, argv: ["omp"], cwd: "/tmp/repo" },
        activeRun: { runId: "legacy-run" },
      }),
    );

    const loaded = loadStateWithText(path);
    expect(loaded.state).toBeUndefined();
    expect(loaded.records.children).toEqual([
      { pid: 4242, argv: ["omp", "acp"], cwd: "/tmp/repo" },
      { pid: 4343, argv: ["omp"], cwd: "/tmp/repo" },
    ]);
    expect(loaded.records.runIds).toEqual(["agent-run", "agent-run-2", "legacy-run"]);
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(dirname(path)).some((name) =>
        name.startsWith("quarantined-records.json.invalid-"),
      ),
    ).toBe(true);
  });

  test("loads a version 1 document with empty agents and its goal cooldowns", () => {
    const legacy = {
      version: 1,
      repo: "acme/fixture",
      root: "/tmp/repo",
      lifecycle: "failed",
      enabled: true,
      paused: false,
      worker: null,
      poll: {
        intervalMs: 2000,
        lastPollAt: null,
        nextPollAt: null,
        etag: null,
        notModified: false,
        rateLimitedUntil: null,
        error: null,
      },
      queue: [
        {
          number: 4,
          title: "Legacy issue",
          url: "https://github.com/acme/fixture/issues/4",
          createdAt: "2026-10-21T00:00:00Z",
          handled: false,
          runId: null,
        },
      ],
      runs: [],
      activeRun: {
        runId: "2026-10-27T10-00-00-000Z",
        startedAt: "2026-10-27T10:00:00.000Z",
        issueNumbers: [1, 2],
      },
      agents: [
        {
          runId: "2026-10-27T10-00-01-000Z",
          issueNumber: 3,
          startedAt: "2026-10-27T10:00:01.000Z",
          question: null,
          acp: null,
        },
      ],
      question: { id: 1, message: "Which?", options: [] },
      acp: null,
      nextAttemptAt: "2026-10-27T10:05:00.000Z",
      goalCooldowns: { "3": "2026-10-27T10:05:00.000Z" },
      lastError: "the agent failed",
      lastExitCode: 1,
      finishedAt: "2026-10-27T10:01:00.000Z",
      notice: null,
      updatedAt: "2026-10-27T10:01:00.000Z",
    };
    const parsed = parseState(JSON.stringify(legacy));
    expect(parsed?.version).toBe(2);
    expect(parsed?.agents).toEqual([]);
    expect(parsed?.cooldowns).toEqual({ "3": "2026-10-27T10:05:00.000Z" });
    expect(parsed?.queue[0]?.labels).toEqual([]);
    expect(parsed?.queue[0]?.agentRunId).toBeNull();
    expect(parsed?.queue[0]?.handled).toBe(false);
    expect(parsed?.lifecycle).toBe("failed");

    const legacyRun = parseRunFile(
      JSON.stringify({
        version: 1,
        runId: "run",
        repo: "acme/fixture",
        status: "succeeded",
        argv: [],
        cwd: "/tmp",
        startedAt: "2026-10-27T00:00:00Z",
        finishedAt: "2026-10-27T00:01:00Z",
        exitCode: 0,
        issues: [
          {
            number: 4,
            title: "Legacy issue",
            url: "https://github.com/acme/fixture/issues/4",
            createdAt: "2026-10-21T00:00:00Z",
          },
        ],
        firstStderrLine: null,
        workerPid: 1,
        harnessVersion: null,
      }),
    );
    expect(legacyRun?.issues[0]?.labels).toEqual([]);
  });
});

describe("prompt contract", () => {
  test("uses the exact per-issue command and never the all-issues command", () => {
    expect(promptFor(issue(17))).toBe("/implement-issue 17");
    expect(promptFor(goalIssue(17))).toBe("/implement-goal-issue 17");
    expect(isGoalIssue(issue(17, "Issue 17", ["long-goal"]))).toBe(false);
    expect(isGoalIssue(goalIssue(18))).toBe(true);
    expect(readFileSync(join(harnessRoot, "issues", "worker.ts"), "utf8")).not.toContain(
      "implement-all-issues",
    );
  });
});

describe("dashboard bridge", () => {
  test("a connect-time replay reaches the clients that were already attached", async () => {
    const root = await temporaryDirectory("bridge-replay");
    const stateDir = join(root, "state");
    const runId = "2026-10-27T10-00-01-000Z";
    writeActivity(runDirectory(stateDir, root, runId), ["first"]);
    writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root }),
      lifecycle: "running",
      enabled: true,
      agents: [
        {
          runId,
          issueNumber: 7,
          startedAt: "2026-10-27T10:00:00.000Z",
          question: null,
          acp: null,
        },
      ],
    });
    const held = acquireLock(lockPath(root), {
      repo: resolve(root),
      stateDir,
      harnessVersion: "0.1.0",
      argv: ["bun", "issues/worker.ts"],
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    const first: Array<Record<string, unknown>> = [];
    const second: Array<Record<string, unknown>> = [];
    const firstSocket = {
      send: (data: string) => first.push(JSON.parse(data) as Record<string, unknown>),
    };
    const secondSocket = {
      send: (data: string) => second.push(JSON.parse(data) as Record<string, unknown>),
    };
    const attached = new Map<object, Array<Record<string, unknown>>>([
      [firstSocket, first],
      [secondSocket, second],
    ]);
    const bridge = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: harnessRoot,
      send: (event, except) => {
        for (const [socket, messages] of attached) {
          if (socket !== except) messages.push(event as Record<string, unknown>);
        }
      },
      pollMs: 60_000,
    });

    bridge.replay(firstSocket);
    const firstReplay = first.findLast((event) => event.type === "issuesActivity");
    expect((firstReplay?.entries as Array<{ text: string }>).map((entry) => entry.text)).toEqual([
      "first",
    ]);

    // Activity grows after the first client's last poll; the second client's
    // replay now advances the shared baseline, so it must reach every client.
    writeActivity(runDirectory(stateDir, root, runId), ["first", "second"]);
    bridge.replay(secondSocket);

    for (const client of [first, second]) {
      const replay = client.findLast(
        (event) => event.type === "issuesActivity" && event.replay === true,
      );
      expect((replay?.entries as Array<{ text: string }>).map((entry) => entry.text)).toEqual([
        "first",
        "second",
      ]);
    }

    // The next refresh resumes from that baseline and appends only the new line.
    writeActivity(runDirectory(stateDir, root, runId), ["first", "second", "third"]);
    bridge.refresh();
    for (const client of [first, second]) {
      expect(client.at(-1)).toMatchObject({
        type: "issuesActivity",
        runId,
        entries: [{ text: "third", append: false }],
      });
      expect(client.at(-1)?.replay).toBeUndefined();
    }
    bridge.dispose();
    held.release();
  });
});

describe("parallel version workers", () => {
  test("a new version drains the old one and claims every later unit", async () => {
    const base = await temporaryDirectory("issues-fleet");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const a = await fixture({
      root,
      stateDir,
      harnessVersion: "0.1.A",
      issues: [issue(1)],
      listIssues: async () => ({
        kind: "issues" as const,
        issues: [issue(1)],
        etag: "etag-a",
      }),
    });
    try {
      await waitFor(() => (a.peers.length === 1 ? true : undefined), "the A peer");
      const b = await fixture({
        root,
        stateDir,
        harnessVersion: "0.1.B",
        issues: [issue(1), issue(2)],
        listIssues: async () => ({
          kind: "issues" as const,
          issues: [issue(1), issue(2)],
          etag: "etag-b",
        }),
      });
      try {
        await waitFor(() => (b.peers.length === 1 ? true : undefined), "the B peer");
        expect(a.state().agents.map((agent) => agent.issueNumber)).toEqual([1]);
        expect(b.state().agents.map((agent) => agent.issueNumber)).toEqual([2]);

        writeCommand(versionedControlDirectory(stateDir, root, "0.1.A"), { type: "drain" });
        await waitFor(
          () => (a.state().pauseSource === "drain" ? true : undefined),
          "the drained A worker to record its provenance",
        );
        // The in-flight unit is untouched and stays attributed to its own
        // worker version throughout the takeover.
        expect(a.state().lifecycle).toBe("pausing");
        const drainingRuns = a.state().runs.filter((run) => run.status === "running");
        expect(drainingRuns.map((run) => run.harnessVersion)).toEqual(["0.1.A"]);
        a.peers[0]!.succeed();
        await waitFor(
          () => (a.state().lifecycle === "stopped" ? true : undefined),
          "the A worker to drain",
        );
        expect(a.peers).toHaveLength(1);
        const settled = a.state().runs.find((run) => run.issueNumbers.includes(1));
        expect(settled?.status).toBe("succeeded");
        expect(settled?.harnessVersion).toBe("0.1.A");
        expect(liveLockOwner(lockPath(root))).toBeUndefined();
        expect(existsSync(versionedStatePath(stateDir, root, "0.1.A"))).toBe(true);
        expect(existsSync(versionedStatePath(stateDir, root, "0.1.B"))).toBe(true);

        b.peers[0]!.succeed();
        await waitFor(
          () => (b.state().runs.some((run) => run.status === "succeeded") ? true : undefined),
          "the B run to finish",
        );
        const ledger = JSON.parse(readFileSync(ledgerPath(stateDir, root), "utf8")) as {
          handled: Record<string, unknown>;
        };
        expect(Object.keys(ledger.handled).sort()).toEqual(["1", "2"]);
        expect(
          b.state().runs.find((run) => run.issueNumbers.includes(2))?.harnessVersion,
        ).toBe("0.1.B");
      } finally {
        await stop(b);
      }
    } finally {
      await stop(a);
    }
  });
});

describe("detached goal drafts", () => {
  test("a detached elaboration survives a dashboard replacement, answers, and stops", async () => {
    const base = await temporaryDirectory("detached-draft");
    const repo = join(base, "repo");
    const stateDir = join(base, "state");
    const drafts = join(repo, ".devboard", "goal-proposals");
    const staticDir = join(base, "static");
    await mkdir(join(repo, "adrs"), { recursive: true });
    await mkdir(drafts, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Draft</title>");
    writeFileSync(join(repo, "GOAL.md"), "# Goal\n\nFixture.\n");
    writeFileSync(join(drafts, "detached.md"), "# Draft\n\n> Unprocessed draft. STUB-HANG\n");

    const log = join(base, "agent.log");
    const options = {
      adrDir: join(repo, "adrs"),
      staticDir,
      hostname: "127.0.0.1",
      port: 0,
      repoDir: repo,
      stateDir,
      providers: testProviderService(stateDir),
      goalFile: join(repo, "GOAL.md"),
      agentCommand: `${process.execPath} ${join(harnessRoot, "server", "fixtures", "stub-agent.ts")} --goal-draft --log=${log}`,
      tracker: async () => undefined,
      restart: () => undefined,
    } as const;
    const first = createApp(options);
    interface Client {
      send(command: unknown): void;
      waitFor(
        predicate: (frame: Record<string, unknown>) => boolean,
        label: string,
      ): Promise<Record<string, unknown>>;
      close(): void;
    }
    const connect = async (port: number): Promise<Client> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: Record<string, unknown>[] = [];
      const waiters: Array<{
        predicate: (frame: Record<string, unknown>) => boolean;
        settle: (frame: Record<string, unknown>) => void;
      }> = [];
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        frames.push(frame);
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          if (waiter === undefined || !waiter.predicate(frame)) continue;
          waiters.splice(index, 1);
          waiter.settle(frame);
        }
      };
      const opened = Promise.withResolvers<void>();
      socket.onopen = () => opened.resolve();
      socket.onerror = () => opened.reject(new Error("websocket failed"));
      await opened.promise;
      return {
        send: (command) => socket.send(JSON.stringify(command)),
        waitFor: (predicate, label) => {
          const found = frames.find(predicate);
          if (found !== undefined) return Promise.resolve(found);
          const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
          const waiter = { predicate, settle: resolve };
          waiters.push(waiter);
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`timed out waiting for ${label}`));
          }, 10_000);
          return promise;
        },
        close: () => socket.close(),
      };
    };
    const path = ".devboard/goal-proposals/detached.md";
    const tab = await connect(first.port ?? 0);
    let second: ReturnType<typeof createApp> | undefined;
    try {
      tab.send({ type: "startGoalDraft", path });
      const started = await tab.waitFor(
        (frame) =>
          frame.type === "issuesDraftState" &&
          (frame.draft as Record<string, unknown> | undefined)?.path === path &&
          (frame.draft as Record<string, unknown>).status === "running" &&
          Array.isArray((frame.draft as Record<string, unknown>).activity) &&
          ((frame.draft as Record<string, unknown>).activity as unknown[]).length > 0,
        "the draft's first activity",
      );
      const draft = started.draft as Record<string, unknown>;
      const startedAt = String(draft.startedAt);
      const owner = readGoalDraftOwnerState(stateDir, repo, path);
      expect(owner?.peer?.pid).toBeGreaterThan(0);
      const pid = owner!.peer!.pid;
      expect(pidAlive(pid)).toBe(true);

      tab.send({ type: "restartServer" });
      await tab.waitFor((frame) => frame.type === "serverRestarting", "the restart handoff");
      first.stop(true);
      second = createApp({ ...options, port: first.port ?? 0 });
      const after = await connect(second.port ?? 0);
      try {
        after.send({ type: "getGoalDrafts" });
        const replay = await after.waitFor(
          (frame) =>
            frame.type === "issuesDrafts" &&
            Array.isArray(frame.runs) &&
            (frame.runs as Array<Record<string, unknown>>).some(
              (run) => run.path === path && run.startedAt === startedAt && run.status === "running",
            ),
          "the adopted draft replay",
        );
        expect(JSON.stringify(replay)).not.toContain("interrupted");
        expect(readGoalDraftOwnerState(stateDir, repo, path)?.peer?.pid).toBe(pid);
        expect(pidAlive(pid)).toBe(true);

        after.send({ type: "stopGoalDraft", path });
        const stopped = await after.waitFor(
          (frame) =>
            frame.type === "issuesDraftState" &&
            (frame.draft as Record<string, unknown> | undefined)?.path === path &&
            (frame.draft as Record<string, unknown>).status === "stopped",
          "the stopped draft",
        );
        expect(JSON.stringify(stopped)).not.toContain("interrupted");
        const deadline = Date.now() + 5_000;
        while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
        expect(pidAlive(pid)).toBe(false);

        after.send({ type: "deleteGoalDraft", path });
        const deleted = await after.waitFor(
          (frame) =>
            frame.type === "issuesDrafts" &&
            Array.isArray(frame.drafts) &&
            !(frame.drafts as Array<Record<string, unknown>>).some(
              (draft) => draft.path === path,
            ),
          "the republished list without the deleted draft",
        );
        expect(JSON.stringify(deleted)).not.toContain(path);
        expect(existsSync(join(drafts, "detached.md"))).toBe(false);
        expect(readGoalDraftOwnerState(stateDir, repo, path)).toBeUndefined();
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.stop(true);
      second?.stop(true);
    }
  }, 30_000);
});

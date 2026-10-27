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
import { controlDirectory, ledgerPath, lockPath, runsDirectory, statePath } from "../issues/paths";
import { preflightIssues } from "../issues/preflight";
import {
  appendActivityLine,
  emptyState,
  loadState,
  parseRunFile,
  parseState,
  readActivity,
  trimActivityLines,
  writeState,
  type IssuesIssue,
  type IssuesState,
} from "../issues/state";
import { parseResponse, pollOpenIssues } from "../issues/tracker";
import {
  IssuesWorker,
  isGoalIssue,
  promptFor,
  type AcpPeer,
  type IssuesPeerOptions,
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

  test("starts twelve peers at once with no concurrency cap", async () => {
    const issues = Array.from({ length: 12 }, (_, index) => issue(index + 1));
    const f = await fixture({ issues });
    try {
      await waitFor(() => (f.peers.length === 12 ? true : undefined), "twelve peers", 8000);
      expect(f.peers.map((peer) => peer.prompts[0]).sort()).toEqual(
        issues.map((entry) => `/implement-issue ${entry.number}`).sort(),
      );
      expect(f.state().agents).toHaveLength(12);
      expect(f.peers.every((peer) => peer.closed === false)).toBe(true);
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

describe("lifecycle", () => {
  test("pause drains every peer before reporting paused", async () => {
    const f = await fixture({ issues: [issue(1), issue(2), goalIssue(3)] });
    try {
      await waitFor(() => (f.peers.length === 3 ? true : undefined), "three peers");
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "pause" });
      await waitFor(() => (f.state().lifecycle === "pausing" ? true : undefined), "pausing");
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

describe("history and isolation", () => {
  test("pruning keeps every running run directory", async () => {
    const issues = Array.from({ length: 55 }, (_, index) => issue(index + 1));
    const f = await fixture({ issues });
    try {
      await waitFor(() => (f.peers.length === 55 ? true : undefined), "fifty-five peers", 15_000);
      const directories = readdirSync(runsDirectory(f.stateDir, f.root));
      expect(directories).toHaveLength(55);
      expect(f.state().runs).toHaveLength(55);
      expect(f.state().runs.every((run) => run.status === "running")).toBe(true);
    } finally {
      await stop(f);
    }
  });

  test("a fresh start terminates every recorded ACP child", async () => {
    const base = await temporaryDirectory("orphans");
    const root = join(base, "repo");
    const stateDir = join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const children = [0, 1].map(() =>
      Bun.spawn({
        cmd: [process.execPath, "-e", "setTimeout(() => undefined, 60_000)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const identities = [];
    for (const child of children) {
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
      identities.push(identity);
    }
    const path = statePath(stateDir, root);
    const stale = emptyState({ repo: "acme/fixture", root, intervalMs: 60_000 });
    writeState(path, {
      ...stale,
      enabled: true,
      lifecycle: "running",
      agents: identities.map((identity, index) => ({
        runId: `orphan-${index}`,
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
    try {
      expect(liveLockOwner(lockPath(f.root))?.pid).toBe(process.pid);
    } finally {
      await stop(f);
    }
    expect(existsSync(lockPath(f.root))).toBe(false);
  });
});

describe("preflight", () => {
  async function checkoutWithTools(): Promise<{
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
      cmd: ["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
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

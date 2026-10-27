import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import { ScoutBridge } from "../server/scout";
import { fileScoutIssue, writeScoutDraft, type GhRunner } from "../issues/scout/actions";
import { writeCommand, type ScoutCommand } from "../issues/scout/control";
import {
  controlDirectory,
  lockPath,
  scanDirectory,
  scansDirectory,
} from "../issues/scout/paths";
import { readScanFile, type ScoutState } from "../issues/scout/state";
import { ScoutWorker } from "../issues/scout/worker";
import type { ScoutRecommendation } from "../issues/scout/recommendation";
import type { AcpPeer, IssuesPeerOptions } from "../issues/worker";
import {
  createdDirectories,
  makeRepository,
  recommendation,
  scanDocument,
  sourceFiles,
  temporaryDirectory,
  type DraftRecommendation,
} from "./fixtures/scout-helpers";

/**
 * Durable Auto Scout tests. Every fixture lives under `.devboard/.tmp`; the
 * tracker, forge, and ACP peer are fakes, and no test contacts GitHub, starts a
 * real agent, or writes outside the repository.
 */

const workers: ScoutWorker[] = [];

afterAll(async () => {
  for (const worker of workers) {
    await worker.stop().catch(() => undefined);
  }
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 8000,
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
  readonly argv = ["stub-scout-acp"];
  readonly prompts: string[] = [];
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
    this.emit(`answered ${String(id)} ${value}`);
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
    this.options.onActivity({ text, append } satisfies AcpActivity);
  }

  ask(question: AcpQuestion): void {
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

/** The scan directory a prompt names. */
function scanDirectoryOf(prompt: string): string {
  return prompt.slice("/scout-recommendations ".length);
}

function writeRecommendations(scanDirectoryPath: string, document: unknown): void {
  writeFileSync(
    join(scanDirectoryPath, "recommendations.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

function readRequest(scanDirectoryPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scanDirectoryPath, "request.json"), "utf8"));
}

/** A recommendation stripped of the fields only staging adds. */
function draftOf(item: ScoutRecommendation): DraftRecommendation {
  return {
    category: item.category,
    title: item.title,
    summary: item.summary,
    impact: item.impact,
    evidence: item.evidence,
    proposedChange: item.proposedChange,
    files: item.files,
    acceptanceCriteria: item.acceptanceCriteria,
  };
}

function uniqueItems(from: number, count: number): DraftRecommendation[] {
  return Array.from({ length: count }, (_value, index) => recommendation(from + index));
}

interface Fixture {
  root: string;
  stateDir: string;
  worker: ScoutWorker;
  peers: ControlledPeer[];
  issues: string[];
  issued: Array<{ id: string; title: string; repository: string }>;
  drafted: string[];
  failingIssue: { message: string } | null;
  failingDraft: { message: string } | null;
  state: () => ScoutState;
}

async function fixture(options: {
  label?: string;
  files?: Record<string, string>;
  issues?: string[];
  retryMs?: number;
  timeoutMs?: number;
  harnessVersion?: string;
  issueDelayMs?: number;
  beforeWorker?: (root: string) => Promise<void>;
}): Promise<Fixture> {
  const base = await temporaryDirectory(options.label ?? "scout");
  const root = await makeRepository({
    files: options.files ?? sourceFiles(12),
    origin: "acme/fixture",
  });
  const stateDir = join(base, "state");
  await mkdir(stateDir, { recursive: true });
  await options.beforeWorker?.(root);

  const peers: ControlledPeer[] = [];
  const issues = [...(options.issues ?? [])];
  const issued: Array<{ id: string; title: string; repository: string }> = [];
  const drafted: string[] = [];

  let worker!: ScoutWorker;
  const f = {
    root,
    stateDir,
    peers,
    issues,
    issued,
    drafted,
    failingIssue: null as { message: string } | null,
    failingDraft: null as { message: string } | null,
    state: () => worker.currentState,
    get worker(): ScoutWorker {
      return worker;
    },
  } satisfies Fixture;
  worker = new ScoutWorker({
    repoDir: root,
    stateDir,
    retryMs: options.retryMs ?? 60_000,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    listIssues: async () => [...f.issues],
    connect: (peerOptions) => {
      const peer = new ControlledPeer(peerOptions);
      peers.push(peer);
      return peer;
    },
    fileIssue: async (request) => {
      if (options.issueDelayMs !== undefined) await Bun.sleep(options.issueDelayMs);
      if (f.failingIssue !== null) throw new Error(f.failingIssue.message);
      issued.push({
        id: request.recommendation.id,
        title: request.recommendation.title,
        repository: request.repository,
      });
      return { url: `https://github.com/acme/fixture/issues/${issued.length}` };
    },
    draftGoal: async (item) => {
      if (f.failingDraft !== null) throw new Error(f.failingDraft.message);
      drafted.push(item.id);
      return { path: `.devboard/goal-proposals/draft-${drafted.length}.md` };
    },
  });
  workers.push(worker);
  expect(worker.start("acme/fixture")).toBe(true);
  return f;
}

/** Stages nine recommendations through one completed scan. */
async function stageNine(f: Fixture): Promise<ControlledPeer> {
  const peer = await waitFor(() => f.peers[0], "the first scan peer");
  writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(uniqueItems(1, 9)));
  peer.succeed();
  await waitFor(() => (f.state().staged.length === 9 ? true : undefined), "nine staged items");
  return peer;
}

function decide(f: Fixture, command: ScoutCommand): void {
  writeCommand(controlDirectory(f.stateDir, f.root), command);
}

describe("scanning", () => {
  test("the first scan requests nine and stages nine", async () => {
    const f = await fixture({ label: "first-scan" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      expect(peer.prompts[0]).toBe(`/scout-recommendations ${scanPath}`);
      expect(scanPath.startsWith(f.root)).toBe(true);
      const request = readRequest(scanPath);
      expect(request.missing).toBe(9);
      expect(request.excludedRoots).toContain("node_modules");
      expect(request.staged).toEqual([]);
      expect(f.state().lifecycle).toBe("scanning");

      peer.emit("surveying");
      writeRecommendations(scanPath, scanDocument(uniqueItems(1, 9)));
      peer.succeed();
      const staged = await waitFor(
        () => (f.state().staged.length === 9 ? f.state() : undefined),
        "nine staged items",
      );
      expect(staged.lifecycle).toBe("idle");
      expect(staged.staged.map((item) => item.title)).toEqual(
        uniqueItems(1, 9).map((item) => item.title),
      );
      expect(staged.shortfall).toBeNull();
      expect(readScanFile(scanDirectory(f.root, basename(scanPath)))?.status).toBe("succeeded");
      const activity = JSON.parse(readFileSync(join(scanPath, "activity.json"), "utf8"));
      expect(activity).toContain("surveying");
    } finally {
      await f.worker.stop();
    }
  });

  test("a scan returning ten items is refused and the staged array is unchanged", async () => {
    const f = await fixture({ label: "over-count" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(uniqueItems(1, 10)));
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the refused scan",
      );
      expect(failed.staged).toEqual([]);
      expect(failed.lastError).toContain("10 recommendations");
      expect(failed.lastError).toContain("9 requested");
    } finally {
      await f.worker.stop();
    }
  });

  test("fewer valid items set the shortfall and schedule the retry", async () => {
    const f = await fixture({ label: "shortfall", retryMs: 600_000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument(uniqueItems(1, 3), "Only three real gaps."),
      );
      peer.succeed();
      const short = await waitFor(
        () => (f.state().staged.length === 3 ? f.state() : undefined),
        "three staged items",
      );
      expect(short.shortfall?.staged).toBe(3);
      expect(short.shortfall?.missing).toBe(6);
      expect(short.shortfall?.reason).toBe("Only three real gaps.");
      expect(short.nextAttemptAt).not.toBeNull();
      expect(Date.parse(short.nextAttemptAt!) - Date.now()).toBeGreaterThan(5 * 60_000);
      expect(short.lifecycle).toBe("idle");
    } finally {
      await f.worker.stop();
    }
  });

  test("duplicate titles against staged items, open issues, and drafts are dropped", async () => {
    const f = await fixture({
      label: "duplicates",
      issues: ["Fix the resolver duplication"],
      beforeWorker: async (root) => {
        await mkdir(join(root, ".devboard", "goal-proposals"), { recursive: true });
        writeFileSync(
          join(root, ".devboard", "goal-proposals", "tracker.md"),
          "# Proposed goal: Merge the two trackers\n",
        );
      },
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const accepted = uniqueItems(1, 2);
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument([
          { ...recommendation(3), title: "Fix the resolver duplication" },
          { ...recommendation(4), title: "Proposed goal: merge the two trackers" },
          ...accepted,
        ]),
      );
      peer.succeed();
      const staged = await waitFor(
        () => (f.state().staged.length >= 2 ? f.state() : undefined),
        "the accepted items",
      );
      expect(staged.staged.map((item) => item.title)).toEqual(accepted.map((item) => item.title));
      const activity = readFileSync(
        join(scanDirectoryOf(peer.prompts[0]!), "activity.json"),
        "utf8",
      );
      expect(activity).toContain("dropped duplicate “Fix the resolver duplication”");
      expect(activity).toContain("shortfall");
    } finally {
      await f.worker.stop();
    }
  });

  test("a scan that writes no result is closed as failed", async () => {
    const f = await fixture({ label: "no-result" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the failed scan",
      );
      expect(failed.staged).toEqual([]);
      expect(failed.lastError).toContain("recommendations.json");
    } finally {
      await f.worker.stop();
    }
  });

  test("a scan that outlives its time limit is closed as failed", async () => {
    const f = await fixture({ label: "timeout", timeoutMs: 200 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the timed-out scan",
      );
      expect(peer.closed).toBe(true);
      expect(failed.staged).toEqual([]);
      expect(failed.lastError).toContain("timed out");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const scanFile = readScanFile(scanDirectory(f.root, basename(scanPath)));
      expect(scanFile?.status).toBe("failed");
      expect(scanFile?.error).toContain("timed out");
      expect(readFileSync(join(scanPath, "activity.json"), "utf8")).toContain(
        "failed: the scan timed out",
      );
    } finally {
      await f.worker.stop();
    }
  });

  test("a question is answered with its recommended option and recorded", async () => {
    const f = await fixture({ label: "question" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      peer.ask({
        id: 77,
        message: "Which area first?",
        options: [
          { label: "tests", recommended: false },
          { label: "correctness", recommended: true },
        ],
        properties: {},
        required: undefined,
      });
      peer.ask({
        id: 78,
        message: "Which area next?",
        options: [{ label: "structure", recommended: false }],
        properties: {},
        required: undefined,
      });
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const activity = await waitFor(
        () => {
          const text = existsSync(join(scanPath, "activity.json"))
            ? readFileSync(join(scanPath, "activity.json"), "utf8")
            : "";
          return text.includes("answer: correctness") && text.includes("answer: structure")
            ? text
            : undefined;
        },
        "the recorded question and answer",
      );
      expect(activity).toContain("question: Which area first?");
    } finally {
      await f.worker.stop();
    }
  });
});

describe("decisions", () => {
  test("Approve files one issue, removes one widget, and the refill asks for one slot", async () => {
    const f = await fixture({ label: "approve" });
    try {
      await stageNine(f);
      const target = f.state().staged[2]!;
      decide(f, { type: "approve", id: target.id });
      const after = await waitFor(
        () => (f.state().staged.length === 8 ? f.state() : undefined),
        "the approval",
      );
      expect(f.issued).toEqual([
        { id: target.id, title: target.title, repository: "acme/fixture" },
      ]);
      expect(after.staged.some((item) => item.id === target.id)).toBe(false);
      expect(after.decisions.at(-1)).toMatchObject({
        id: target.id,
        kind: "approve",
        url: "https://github.com/acme/fixture/issues/1",
      });
      expect(after.notice).toContain("https://github.com/acme/fixture/issues/1");

      const refill = await waitFor(() => f.peers[1], "the refill scan peer");
      const request = readRequest(scanDirectoryOf(refill.prompts[0]!));
      expect(request.missing).toBe(1);
      expect(request.staged).toHaveLength(8);
    } finally {
      await f.worker.stop();
    }
  });

  test("a failed issue creation leaves the widget staged and reports why", async () => {
    const f = await fixture({ label: "approve-failure" });
    try {
      await stageNine(f);
      const target = f.state().staged[0]!;
      f.failingIssue = { message: "the label does not exist" };
      decide(f, { type: "approve", id: target.id });
      const failed = await waitFor(
        () => (f.state().lastError !== null ? f.state() : undefined),
        "the failure",
      );
      expect(failed.staged).toHaveLength(9);
      expect(failed.staged.some((item) => item.id === target.id)).toBe(true);
      expect(failed.decisions).toEqual([]);
      expect(failed.lastError).toContain("the label does not exist");
      expect(failed.notice).toContain("Could not file the issue");
    } finally {
      await f.worker.stop();
    }
  });

  test("Draft goal removes the widget and records its path", async () => {
    const f = await fixture({ label: "draft" });
    try {
      await stageNine(f);
      const target = f.state().staged[4]!;
      decide(f, { type: "draft", id: target.id });
      const after = await waitFor(
        () => (f.state().staged.length === 8 ? f.state() : undefined),
        "the draft",
      );
      expect(f.drafted).toEqual([target.id]);
      expect(after.decisions.at(-1)).toMatchObject({
        kind: "draft",
        path: ".devboard/goal-proposals/draft-1.md",
      });
      expect(after.notice).toContain(".devboard/goal-proposals/draft-1.md");
    } finally {
      await f.worker.stop();
    }
  });

  test("a failed draft write leaves the widget staged", async () => {
    const f = await fixture({ label: "draft-failure" });
    try {
      await stageNine(f);
      f.failingDraft = { message: "the proposals directory is read-only" };
      decide(f, { type: "draft", id: f.state().staged[1]!.id });
      const failed = await waitFor(
        () => (f.state().lastError !== null ? f.state() : undefined),
        "the draft failure",
      );
      expect(failed.staged).toHaveLength(9);
      expect(failed.lastError).toContain("read-only");
    } finally {
      await f.worker.stop();
    }
  });

  test("Reject removes the widget and a later scan may propose the same title", async () => {
    const f = await fixture({ label: "reject" });
    try {
      await stageNine(f);
      const target = f.state().staged[3]!;
      decide(f, { type: "reject", id: target.id });
      const after = await waitFor(
        () => (f.state().staged.length === 8 ? f.state() : undefined),
        "the rejection",
      );
      expect(after.decisions.at(-1)).toMatchObject({ id: target.id, kind: "reject" });
      const refill = await waitFor(() => f.peers[1], "the refill scan peer");
      writeRecommendations(scanDirectoryOf(refill.prompts[0]!), scanDocument([draftOf(target)]));
      refill.succeed();
      const staged = await waitFor(
        () => (f.state().staged.length === 9 ? f.state() : undefined),
        "the resubmitted title",
      );
      expect(staged.staged.some((item) => item.title === target.title)).toBe(true);
    } finally {
      await f.worker.stop();
    }
  });

  test("an id no longer staged is refused and never files twice", async () => {
    const f = await fixture({ label: "double" });
    try {
      await stageNine(f);
      const target = f.state().staged[0]!;
      decide(f, { type: "approve", id: target.id });
      await waitFor(() => (f.state().staged.length === 8 ? true : undefined), "the approval");
      decide(f, { type: "approve", id: target.id });
      const refused = await waitFor(
        () =>
          f.state().notice === "That recommendation is no longer staged."
            ? f.state()
            : undefined,
        "the duplicate refusal",
      );
      expect(f.issued).toHaveLength(1);
      expect(refused.staged).toHaveLength(8);
    } finally {
      await f.worker.stop();
    }
  });

  test("two queued decisions for one id file exactly one issue", async () => {
    const f = await fixture({ label: "queued", issueDelayMs: 150 });
    try {
      await stageNine(f);
      const target = f.state().staged[0]!;
      decide(f, { type: "approve", id: target.id });
      decide(f, { type: "approve", id: target.id });
      const refused = await waitFor(
        () =>
          f.state().notice === "That recommendation is no longer staged." ||
          f.state().notice === "That decision is already in progress."
            ? f.state()
            : undefined,
        "the duplicate decision's refusal",
      );
      expect(f.issued).toHaveLength(1);
      expect(refused.staged).toHaveLength(8);
      expect(refused.decisions).toHaveLength(1);
      expect(refused.decisions[0]?.id).toBe(target.id);
    } finally {
      await f.worker.stop();
    }
  });

  test("a decision during a scan never produces a tenth staged item", async () => {
    const f = await fixture({ label: "mid-scan" });
    try {
      await stageNine(f);
      decide(f, { type: "reject", id: f.state().staged[0]!.id });
      const refill = await waitFor(() => f.peers[1], "the refill scan peer");
      const request = readRequest(scanDirectoryOf(refill.prompts[0]!));
      expect(request.missing).toBe(1);
      writeRecommendations(
        scanDirectoryOf(refill.prompts[0]!),
        scanDocument(uniqueItems(11, 1)),
      );
      refill.succeed();
      const staged = await waitFor(
        () => (f.state().scan === null ? f.state() : undefined),
        "the completed refill",
      );
      expect(staged.staged).toHaveLength(9);
      expect(staged.lifecycle).toBe("idle");
      expect(staged.shortfall).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });
});

describe("persistence and lifecycle", () => {
  test("a restart restores staged items, decisions, and the shortfall", async () => {
    const f = await fixture({ label: "restart", retryMs: 600_000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument(uniqueItems(1, 4), "Four gaps."),
      );
      peer.succeed();
      await waitFor(
        () => (f.state().staged.length === 4 ? true : undefined),
        "four staged items",
      );
      decide(f, { type: "reject", id: f.state().staged[0]!.id });
      const refill = await waitFor(() => f.peers[1], "the refill scan peer");
      writeRecommendations(
        scanDirectoryOf(refill.prompts[0]!),
        scanDocument([], "No further significant gaps."),
      );
      refill.succeed();
      const before = await waitFor(
        () => (f.state().shortfall?.reason === "No further significant gaps." ? f.state() : undefined),
        "the recorded shortfall",
      );
      expect(before.decisions).toHaveLength(1);
      const stagedBefore = before.staged.map((item) => item.id);
      const decisionsBefore = before.decisions;
      const shortfallBefore = before.shortfall;

      await f.worker.stop();
      expect(existsSync(lockPath(f.root))).toBe(false);

      const resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        retryMs: 600_000,
        listIssues: async () => [],
        connect: () => new ControlledPeer({
          command: "stub",
          cwd: f.root,
          onActivity: () => undefined,
          onQuestion: () => undefined,
          onStderr: () => undefined,
        }),
      });
      workers.push(resumed);
      expect(resumed.start("acme/fixture")).toBe(true);
      expect(resumed.currentState.staged.map((item) => item.id)).toEqual(stagedBefore);
      expect(resumed.currentState.decisions).toEqual(decisionsBefore);
      expect(resumed.currentState.shortfall?.reason).toBe(shortfallBefore?.reason);
      await resumed.stop();
    } finally {
      await f.worker.stop();
    }
  });

  test("a live lock attaches without a second worker", async () => {
    const f = await fixture({ label: "live-lock" });
    try {
      const second = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        listIssues: async () => [],
      });
      workers.push(second);
      expect(second.start("acme/fixture")).toBe(false);
      expect(readFileSync(lockPath(f.root), "utf8")).toContain(String(process.pid));
      expect(second.currentState.enabled).toBe(false);
    } finally {
      await f.worker.stop();
    }
  });

  test("a replacement closes the scan its dead predecessor left running", async () => {
    const f = await fixture({ label: "interrupted" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanId = basename(scanDirectoryOf(peer.prompts[0]!));
      const owner = f.worker as unknown as { lock?: { release(): void } };
      owner.lock?.release();

      const replacement = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        listIssues: async () => [],
        connect: () => new ControlledPeer({
          command: "stub",
          cwd: f.root,
          onActivity: () => undefined,
          onQuestion: () => undefined,
          onStderr: () => undefined,
        }),
      });
      workers.push(replacement);
      expect(replacement.start("acme/fixture")).toBe(true);
      expect(replacement.currentState.lastError).toContain("interrupted");
      expect(readScanFile(scanDirectory(f.root, scanId))?.status).toBe("failed");
      expect(replacement.currentState.staged).toEqual([]);
      await replacement.stop();
    } finally {
      await f.worker.stop();
    }
  });

  test("Stop keeps the staged list and Start resumes refilling it", async () => {
    const f = await fixture({ label: "stop-start" });
    try {
      await stageNine(f);
      const ids = f.state().staged.map((item) => item.id);
      await f.worker.stop();
      expect(f.state().lifecycle).toBe("stopped");
      expect(f.state().enabled).toBe(false);
      expect(f.state().staged.map((item) => item.id)).toEqual(ids);
      expect(existsSync(lockPath(f.root))).toBe(false);

      const resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        listIssues: async () => [],
        connect: () => new ControlledPeer({
          command: "stub",
          cwd: f.root,
          onActivity: () => undefined,
          onQuestion: () => undefined,
          onStderr: () => undefined,
        }),
      });
      workers.push(resumed);
      expect(resumed.start("acme/fixture")).toBe(true);
      expect(resumed.currentState.staged.map((item) => item.id)).toEqual(ids);
      expect(resumed.currentState.enabled).toBe(true);
      await resumed.stop();
    } finally {
      await f.worker.stop();
    }
  });

  test("stale scans are left on disk under the checkout, never the state directory", async () => {
    const f = await fixture({ label: "scan-paths" });
    try {
      await stageNine(f);
      const scans = readdirSync(scansDirectory(f.root));
      expect(scans).toHaveLength(1);
      expect(scanDirectory(f.root, scans[0]!).startsWith(f.root)).toBe(true);
    } finally {
      await f.worker.stop();
    }
  });
});

describe("dashboard bridge", () => {
  test("a reload replays the board without starting a worker", async () => {
    const f = await fixture({ label: "replay" });
    try {
      await stageNine(f);
      let spawned = 0;
      const bridge = new ScoutBridge({
        repoDir: f.root,
        stateDir: f.stateDir,
        agentCommand: "stub",
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: () => {
          spawned += 1;
          return undefined;
        },
      });
      const messages: Array<Record<string, unknown>> = [];
      bridge.replay({ send: (data: string) => messages.push(JSON.parse(data)) });
      expect(messages[0]?.type).toBe("scoutState");
      expect((messages[0]?.staged as unknown[] | undefined)?.length).toBe(9);
      expect(messages[1]?.type).toBe("scoutActivity");
      expect(spawned).toBe(0);
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });

  test("a different STATE_DIR is refused without spawning a worker", async () => {
    const f = await fixture({ label: "state-refusal" });
    try {
      const otherState = await temporaryDirectory("scout-other-state");
      let spawned = 0;
      const bridge = new ScoutBridge({
        repoDir: f.root,
        stateDir: otherState,
        agentCommand: "stub",
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: () => undefined,
        pollMs: 60_000,
        preflight: async () => ({ ok: true, repository: "acme/fixture" }),
        spawnWorker: () => {
          spawned += 1;
          return undefined;
        },
      });
      const started = await bridge.start();
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.message).toContain(f.stateDir);
      expect(started.message).toContain(otherState);
      expect(spawned).toBe(0);
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });

  test("a worker with another harness version is left running with a notice", async () => {
    const f = await fixture({ label: "version-mismatch", harnessVersion: "0.0.9" });
    try {
      const bridge = new ScoutBridge({
        repoDir: f.root,
        stateDir: f.stateDir,
        agentCommand: "stub",
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: () => undefined,
        pollMs: 60_000,
      });
      const snapshot = bridge.snapshot();
      expect(snapshot.attached).toBe(true);
      expect(snapshot.notice).toContain("0.0.9");
      expect(snapshot.notice).toContain("0.1.0");
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });
});

describe("approve and draft actions", () => {
  const authExec = async (
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    if (command !== "gh") return { stdout: "", stderr: "unexpected", code: 1 };
    if (args[0] === "auth" && args[1] === "status") {
      return {
        stdout: JSON.stringify({
          hosts: { "github.com": [{ login: "acme-bot", active: true, state: "success" }] },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "auth" && args[1] === "token") {
      return { stdout: "stub-token\n", stderr: "", code: 0 };
    }
    if (args[0] === "api" && args.includes(".permissions")) {
      return { stdout: JSON.stringify({ push: true }), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "unexpected", code: 1 };
  };

  function preparedItem(): ScoutRecommendation {
    return {
      ...recommendation(1),
      id: "0123456789abcdef",
      stagedAt: "2026-10-27T10:00:00.000Z",
    };
  }

  test("Approve files one issue in the host origin with the scout label", async () => {
    const root = await makeRepository({ files: sourceFiles(2), origin: "acme/fixture" });
    const calls: string[][] = [];
    let labelPresent = false;
    const run: GhRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] === "api" && argv[1] === "repos/acme/fixture/labels/scout") {
        return labelPresent
          ? { code: 0, stdout: '{"name":"scout"}', stderr: "" }
          : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      }
      if (argv[0] === "label" && argv[1] === "create") {
        labelPresent = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "issue" && argv[1] === "create") {
        return { code: 0, stdout: "https://github.com/acme/fixture/issues/42\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const result = await fileScoutIssue({
      repoDir: root,
      repository: "acme/fixture",
      recommendation: preparedItem(),
      environment: { HOME: root, PATH: process.env.PATH ?? "" },
      exec: authExec,
      run,
    });
    expect(result.url).toBe("https://github.com/acme/fixture/issues/42");
    expect(calls.map((argv) => argv.slice(0, 2).join(" "))).toEqual([
      "api repos/acme/fixture/labels/scout",
      "label create",
      "issue create",
    ]);
    const create = calls[2]!;
    expect(create[create.indexOf("--repo") + 1]).toBe("acme/fixture");
    expect(create[create.indexOf("--title") + 1]).toBe("Simplify module 1 control flow");
    expect(create[create.indexOf("--label") + 1]).toBe("scout");
    const body = readFileSync(create[create.indexOf("--body-file") + 1]!, "utf8");
    expect(body).toContain("## Category");
    expect(body).toContain("clarity");
    expect(body).toContain("src/module-1.ts:2-6");
    expect(body).toContain("## Proposed change");
    expect(body).toContain("## Files");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("Module 1 has no nested branch deeper than two levels.");
  });

  test("an existing scout label is not created again", async () => {
    const root = await makeRepository({ files: sourceFiles(2), origin: "acme/fixture" });
    const calls: string[][] = [];
    const run: GhRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return { code: 0, stdout: '{"name":"scout"}', stderr: "" };
      return { code: 0, stdout: "https://github.com/acme/fixture/issues/7", stderr: "" };
    };
    await fileScoutIssue({
      repoDir: root,
      repository: "acme/fixture",
      recommendation: preparedItem(),
      environment: { HOME: root, PATH: process.env.PATH ?? "" },
      exec: authExec,
      run,
    });
    expect(calls.some((argv) => argv[0] === "label")).toBe(false);
    expect(calls.filter((argv) => argv[0] === "issue")).toHaveLength(1);
  });

  test("Draft goal writes one draft with the notice and never overwrites", async () => {
    const root = await makeRepository({ files: sourceFiles(2), origin: "acme/fixture" });
    const item = preparedItem();
    const first = await writeScoutDraft(item, { repoDir: root });
    const second = await writeScoutDraft(item, { repoDir: root });
    expect(first.path).toBe(".devboard/goal-proposals/simplify-module-1-control-flow.md");
    expect(second.path).toBe(".devboard/goal-proposals/simplify-module-1-control-flow-2.md");
    const body = readFileSync(join(root, first.path), "utf8");
    expect(body).toContain(
      "> Unprocessed draft. Refine it with `/goal-spec` before it becomes a goal.",
    );
    expect(body).toContain("# Proposed goal: Simplify module 1 control flow");
    expect(body).toContain("## Evidence");
    expect(body).toContain("## Proposed change");
    expect(body).toContain("## Acceptance criteria");
    expect(body).not.toContain("## Success criteria");
    expect(readdirSync(join(root, ".devboard", "goal-proposals"))).toHaveLength(2);
  });
});

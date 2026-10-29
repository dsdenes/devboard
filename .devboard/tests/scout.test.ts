import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import { ScoutBridge } from "../server/scout";
import { agentRegistry } from "../server/agents/registry";
import { fileScoutIssue, issueBody, type GhRunner } from "../issues/scout/actions";
import { writeCommand, type ScoutCommand } from "../issues/scout/control";
import {
  createScoutGitHub,
  isGitHubRateLimited,
  type ScoutGitHubClient,
  type ScoutGitHubIssue,
  type ScoutRelease,
} from "../issues/scout/github";
import {
  controlDirectory,
  lockPath,
  scanDirectory,
  scansDirectory,
  settingsPath,
  statePath,
} from "../issues/scout/paths";
import { ghCommand } from "../issues/scout/preflight";
import { readScanFile, readSettings, type ScoutState } from "../issues/scout/state";
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
 * GitHub client, forge, and ACP peer are fakes, and no test contacts GitHub,
 * starts a real agent, or writes outside the repository.
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
  /** Correction turns sent after a rejected answer. */
  readonly corrections: string[] = [];
  /** When false, a correction is refused so a rejected scan settles at once. */
  correctionEnabled = false;
  closed = false;
  private settled = false;
  private correction: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
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

  prompt(prompt: string): Promise<unknown> {
    this.corrections.push(prompt);
    if (!this.correctionEnabled) {
      return Promise.reject(new Error("the stub peer does not answer corrections"));
    }
    this.correction = Promise.withResolvers<unknown>();
    return this.correction.promise;
  }

  /** Ends the pending correction turn. */
  resolveCorrection(): void {
    this.correction?.resolve({});
    this.correction = null;
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
    this.correction?.reject(new Error("Agent process exited before answering."));
    this.correction = null;
  }

  emit(text: string, append = false): void {
    this.options.onActivity({ text, append } satisfies AcpActivity);
  }

  /** A tool progress frame: protocol traffic that maps to no activity line. */
  emitSessionUpdate(): void {
    this.options.onSessionUpdate?.();
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

/** The first line of `gh issue list` when GitHub throttles the operator's token. */
const RATE_LIMIT_ERROR =
  "gh: API rate limit exceeded for user ID 123850. If you reach out to GitHub Support for help, " +
  "please include the request ID D6E0:2832D4:EE3810:157BF95:6AE1FE3B. For more on scraping " +
  "GitHub and how it may affect your rights, please review our Terms of Service " +
  "(https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) (HTTP 403)";

describe("isGitHubRateLimited", () => {
  test("recognizes every throttling diagnostic gh prints", () => {
    for (const message of [
      RATE_LIMIT_ERROR,
      "You have exceeded a secondary rate limit.",
      "gh: You have triggered an abuse detection mechanism.",
      "gh: HTTP 429: Too Many Requests",
    ]) {
      expect(isGitHubRateLimited(message)).toBe(true);
    }
  });

  test("leaves an authorization failure an error", () => {
    expect(isGitHubRateLimited("gh: HTTP 403: Resource not accessible by integration")).toBe(
      false,
    );
  });
});

class FakeGitHub implements ScoutGitHubClient {
  readonly issues: ScoutGitHubIssue[] = [];
  readonly releases: ScoutRelease[] = [];
  readonly openTitles: string[] = [];
  readonly closing = new Map<number, string | null>();
  readonly commits = new Map<string, string>();
  readonly containing = new Map<string, string[]>();
  failIssues = false;
  /** Replaces the generic issue-read failure when set. */
  issuesError: string | null = null;
  failReleases = false;
  nextNumber = 100;

  add(issue: Partial<ScoutGitHubIssue> & { number: number; title: string }): void {
    const row: ScoutGitHubIssue = {
      number: issue.number,
      title: issue.title,
      url: issue.url ?? `https://github.com/acme/fixture/issues/${issue.number}`,
      state: issue.state ?? "open",
      createdAt: issue.createdAt ?? new Date().toISOString(),
      body: issue.body ?? "",
    };
    this.issues.push(row);
    if (row.state === "open") this.openTitles.push(row.title);
  }

  async listIssues(): Promise<ScoutGitHubIssue[]> {
    if (this.failIssues) throw new Error(this.issuesError ?? "the GitHub read failed");
    return this.issues.map((issue) => ({ ...issue }));
  }

  async listOpenIssueTitles(): Promise<string[]> {
    if (this.failIssues) throw new Error(this.issuesError ?? "the GitHub read failed");
    return [...this.openTitles];
  }

  async listReleases(): Promise<ScoutRelease[]> {
    if (this.failReleases) throw new Error("the release read failed");
    return this.releases.map((release) => ({ ...release }));
  }

  async closingCommit(issueNumber: number): Promise<string | null> {
    return this.closing.get(issueNumber) ?? null;
  }

  async resolveCommit(short: string): Promise<string | null> {
    return this.commits.get(short) ?? null;
  }

  async containingReleaseTags(commit: string, releases: ScoutRelease[]): Promise<string[]> {
    const tags = this.containing.get(commit) ?? [];
    return tags.filter((tag) => releases.some((release) => release.tag === tag));
  }
}

/** A client whose issue list never settles while `hanging` is set. */
class HangingGitHub extends FakeGitHub {
  hanging = true;

  override async listIssues(): Promise<ScoutGitHubIssue[]> {
    if (this.hanging) return await new Promise<ScoutGitHubIssue[]>(() => undefined);
    return await super.listIssues();
  }
}

/** The injected `gh issue create`: records the issue and mirrors it on GitHub. */
function fakeFiling(f: Fixture): typeof fileScoutIssue {
  return async (request) => {
    if (f.failingIssue !== null) throw new Error(f.failingIssue.message);
    const number = f.github.nextNumber++;
    const issue: ScoutGitHubIssue = {
      number,
      title: request.recommendation.title,
      url: `https://github.com/acme/fixture/issues/${number}`,
      state: "open",
      createdAt: f.clock.now.toISOString(),
      body: issueBody(request.recommendation),
    };
    f.github.issues.push(issue);
    f.github.openTitles.push(issue.title);
    f.filed.push({
      id: request.recommendation.id,
      number,
      title: request.recommendation.title,
      repository: request.repository,
      body: issue.body,
      significance: request.recommendation.significance,
    });
    return { url: issue.url, number };
  };
}

/** The scan directory a prompt names. */
function scanDirectoryOf(prompt: string): string {
  return prompt.slice("/scout-recommendations ".length);
}

/** Waits until the scan recorded a terminal status, not a guessed duration. */
async function waitSettled(root: string, prompt: string, description = "the scan to settle") {
  const scanId = basename(scanDirectoryOf(prompt));
  return await waitFor(
    () => {
      const file = readScanFile(scanDirectory(root, scanId));
      return file !== undefined && file.status !== "running" ? file : undefined;
    },
    description,
  );
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

function activityOf(scanDirectoryPath: string): string {
  try {
    return readFileSync(join(scanDirectoryPath, "activity.json"), "utf8");
  } catch {
    return "";
  }
}

function uniqueItems(from: number, count: number): DraftRecommendation[] {
  return Array.from({ length: count }, (_value, index) => recommendation(from + index));
}

interface Fixture {
  root: string;
  stateDir: string;
  github: FakeGitHub;
  peers: ControlledPeer[];
  filed: Array<{
    id: string;
    number: number;
    title: string;
    repository: string;
    body: string;
    significance: number;
  }>;
  failingIssue: { message: string } | null;
  clock: { now: Date };
  state: () => ScoutState;
  worker: ScoutWorker;
}

async function fixture(options: {
  label?: string;
  github?: FakeGitHub;
  files?: Record<string, string>;
  syncMs?: number;
  cadenceMs?: number;
  readTimeoutMs?: number;
  timeoutMs?: number;
  limit?: { maxPerHour: number; maxPending: number };
  harnessVersion?: string;
  now?: Date;
  draftHeading?: string;
  fileIssue?: typeof fileScoutIssue;
}): Promise<Fixture> {
  const base = await temporaryDirectory(options.label ?? "scout");
  const root = await makeRepository({
    files: options.files ?? sourceFiles(12),
    origin: "acme/fixture",
  });
  if (options.draftHeading !== undefined) {
    await mkdir(join(root, ".devboard", "goal-proposals"), { recursive: true });
    writeFileSync(
      join(root, ".devboard", "goal-proposals", "one.md"),
      `# ${options.draftHeading}\n`,
    );
  }
  const stateDir = join(base, "state");
  await mkdir(stateDir, { recursive: true });
  if (options.limit !== undefined) {
    await mkdir(dirname(settingsPath(stateDir, root)), { recursive: true });
    writeFileSync(settingsPath(stateDir, root), `${JSON.stringify(options.limit)}\n`);
  }

  const peers: ControlledPeer[] = [];
  const github = options.github ?? new FakeGitHub();
  const filed: Fixture["filed"] = [];
  const clock = { now: options.now ?? new Date("2026-10-27T10:00:00.000Z") };

  const f = {
    root,
    stateDir,
    github,
    peers,
    filed,
    failingIssue: null as { message: string } | null,
    clock,
    state: () => worker.currentState,
    get worker(): ScoutWorker {
      return worker;
    },
  } satisfies Fixture;

  let worker!: ScoutWorker;
  worker = new ScoutWorker({
    repoDir: root,
    stateDir,
    syncMs: options.syncMs ?? 900_000,
    cadenceMs: options.cadenceMs ?? 0,
    ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    now: () => new Date(clock.now),
    github,
    connect: (peerOptions) => {
      const peer = new ControlledPeer(peerOptions);
      peers.push(peer);
      return peer;
    },
    fileIssue: options.fileIssue ?? fakeFiling(f),
  });
  workers.push(worker);
  expect(worker.start("acme/fixture")).toBe(true);
  return f;
}

const startClock = new Date("2026-10-27T10:00:00.000Z");

/** Runs one scan: waits for its peer, writes the document, and settles it. */
async function scan(
  f: Fixture,
  index: number,
  items: DraftRecommendation[],
  shortfall?: string,
): Promise<ControlledPeer> {
  const peer = await waitFor(() => f.peers[index], `scan peer ${index + 1}`);
  writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(items, shortfall));
  peer.succeed();
  await waitSettled(f.root, peer.prompts[0]!, `scan ${index + 1} to settle`);
  return peer;
}

function decide(f: Fixture, command: ScoutCommand): void {
  writeCommand(controlDirectory(f.stateDir, f.root), command);
}

describe("direct filing", () => {
  test("a scan files every significant item with no command", async () => {
    const f = await fixture({ label: "auto-file" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const request = readRequest(scanPath);
      expect(request.requested).toBe(Math.min(10, 5));
      writeRecommendations(scanPath, scanDocument(uniqueItems(1, 2)));
      peer.succeed();
      const settled = await waitFor(
        () => (f.filed.length === 2 ? f.state() : undefined),
        "the two filed issues",
      );
      expect(settled.issues).toHaveLength(2);
      expect(settled.issues.map((row) => row.state)).toEqual(["pending", "pending"]);
      expect(settled.issues[0]?.category).toBe("clarity");
      expect(settled.notice).toBe("Filed 2 issues in acme/fixture: #100, #101");
      expect(f.filed[0]?.repository).toBe("acme/fixture");
      expect(f.filed[0]?.body).toContain("## Significance");
      expect(f.filed[0]?.body).toContain("5/5");
      expect(f.filed[0]?.body).toContain("third nested branch");
      const scanFile = readScanFile(scanDirectory(f.root, basename(scanPath)));
      expect(scanFile?.status).toBe("succeeded");
      expect(scanFile?.filed).toBe(2);
      expect(activityOf(scanPath)).toContain("filed #100");
      expect(settled.lifecycle).toBe("idle");
    } finally {
      await f.worker.stop();
    }
  });

  test("items below significance 4 are dropped and recorded", async () => {
    const f = await fixture({ label: "significance-drop" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const low = { ...recommendation(2), significance: 3, significanceReason: "A latent cleanup." };
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument([recommendation(1), low]),
      );
      peer.succeed();
      await waitSettled(f.root, peer.prompts[0]!);
      const settled = f.state();
      expect(f.filed).toHaveLength(1);
      expect(f.filed[0]?.significance).toBe(5);
      expect(settled.issues).toHaveLength(1);
      expect(settled.notice).toBe("Filed #100 “Simplify module 1 control flow”");
      expect(settled.lastError).toBeNull();
      expect(activityOf(scanDirectoryOf(peer.prompts[0]!))).toContain(
        "significance 3/5 is below 4",
      );
    } finally {
      await f.worker.stop();
    }
  });

  test("a rejected answer gets one correction turn and the repaired file is filed", async () => {
    const f = await fixture({ label: "correction" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      peer.correctionEnabled = true;
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const document = scanDocument([recommendation(1)]);
      (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
        { path: "server/app.ts", lines: "1" },
      ];
      writeRecommendations(scanPath, document);
      peer.succeed();
      await waitFor(
        () => (peer.corrections.length === 1 ? true : undefined),
        "the correction prompt",
      );
      expect(peer.corrections[0]).toContain("server/app.ts does not exist");
      writeRecommendations(scanPath, scanDocument(uniqueItems(1, 1)));
      peer.resolveCorrection();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(f.filed.map((entry) => entry.title)).toEqual(["Simplify module 1 control flow"]);
      expect(f.state().lastError).toBeNull();
      expect(peer.corrections).toHaveLength(1);
      const activity = activityOf(scanPath);
      expect(activity).toContain("server/app.ts does not exist");
      expect(activity).toContain("asked the agent to correct the answer");
    } finally {
      await f.worker.stop();
    }
  });

  test("a still-rejected answer after the correction turn fails the scan once", async () => {
    const f = await fixture({ label: "correction-failed" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      peer.correctionEnabled = true;
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const document = scanDocument([recommendation(1)]);
      (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
        { path: "server/app.ts", lines: "1" },
      ];
      writeRecommendations(scanPath, document);
      peer.succeed();
      await waitFor(
        () => (peer.corrections.length === 1 ? true : undefined),
        "the correction prompt",
      );
      peer.resolveCorrection();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the refused scan",
      );
      expect(peer.corrections).toHaveLength(1);
      expect(f.filed).toEqual([]);
      expect(failed.lastError).toContain("server/app.ts does not exist");
      expect(readScanFile(scanDirectory(f.root, basename(scanPath)))?.status).toBe("failed");
    } finally {
      await f.worker.stop();
    }
  });

  test("a scan with no answer file gets a correction turn before it fails", async () => {
    const f = await fixture({ label: "correction-missing" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      peer.correctionEnabled = true;
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      peer.succeed();
      await waitFor(
        () => (peer.corrections.length === 1 ? true : undefined),
        "the correction prompt",
      );
      expect(peer.corrections[0]).toContain("wrote no recommendations.json");
      writeRecommendations(scanPath, scanDocument(uniqueItems(1, 1)));
      peer.resolveCorrection();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(f.filed).toHaveLength(1);
    } finally {
      await f.worker.stop();
    }
  });

  test("a missing score fails the whole scan atomically and files nothing", async () => {
    const f = await fixture({ label: "missing-score" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const document = scanDocument(uniqueItems(1, 3));
      delete (document.recommendations as Record<string, unknown>[])[1]!.significance;
      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), document);
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the refused scan",
      );
      expect(f.filed).toEqual([]);
      expect(failed.issues).toEqual([]);
      expect(failed.lastError).toContain("significance score from 1 to 5");
      expect(readScanFile(scanDirectory(f.root, basename(scanDirectoryOf(peer.prompts[0]!))))?.status).toBe(
        "failed",
      );
    } finally {
      await f.worker.stop();
    }
  });

  test("duplicate titles against closed issues, open issues, and drafts are dropped", async () => {
    const github = new FakeGitHub();
    github.add({
      number: 5,
      title: "Old closed finding",
      state: "closed",
      createdAt: "2026-10-01T00:00:00.000Z",
      body: "## Category\n\nclarity\n",
    });
    github.add({ number: 6, title: "Open finding", createdAt: "2026-10-01T00:00:00.000Z" });
    const f = await fixture({
      label: "duplicates",
      github,
      draftHeading: "Proposed goal: Draft finding",
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const request = readRequest(scanPath);
      expect(request.knownTitles).toContain("old closed finding");
      expect(request.knownTitles).toContain("open finding");
      expect(request.knownTitles).toContain("proposed goal: draft finding");
      writeRecommendations(
        scanPath,
        scanDocument([
          { ...recommendation(1), title: "Old closed finding" },
          { ...recommendation(2), title: "Open finding" },
          { ...recommendation(3), title: "Proposed goal: draft finding" },
          recommendation(4),
        ]),
      );
      peer.succeed();
      await waitSettled(f.root, peer.prompts[0]!);
      const settled = f.state();
      expect(f.filed.map((entry) => entry.title)).toEqual(["Simplify module 4 control flow"]);
      // The two seeded issues are Auto Scout issues too, so the table holds them.
      expect(settled.issues).toHaveLength(3);
      const activity = activityOf(scanPath);
      expect(activity).toContain("dropped duplicate “Old closed finding”");
      expect(activity).toContain("dropped duplicate “Open finding”");
      expect(activity).toContain("dropped duplicate “Proposed goal: draft finding”");
    } finally {
      await f.worker.stop();
    }
  });
});

describe("caps", () => {
  test("the effective batch is the smaller of the hourly and pending rooms", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "Open one", createdAt: "2026-10-27T09:50:00.000Z" });
    github.add({
      number: 2,
      title: "Closed two",
      state: "closed",
      createdAt: "2026-10-27T09:40:00.000Z",
    });
    github.add({
      number: 3,
      title: "Closed three",
      state: "closed",
      createdAt: "2026-10-27T09:30:00.000Z",
    });
    const f = await fixture({
      label: "batch",
      github,
      limit: { maxPerHour: 10, maxPending: 5 },
      now: startClock,
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const request = readRequest(scanDirectoryOf(peer.prompts[0]!));
      // window 3, open 1: min(10 - 3, 5 - 1) = 4
      expect(request.requested).toBe(4);
    } finally {
      await f.worker.stop();
    }
  });

  test("zero capacity starts no scan and schedules the earlier unblock", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "The only open one", createdAt: "2026-10-27T09:50:00.000Z" });
    const f = await fixture({
      label: "zero",
      github,
      limit: { maxPerHour: 10, maxPending: 1 },
      now: startClock,
    });
    try {
      await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first GitHub read",
      );
      expect(f.state().nextAttemptAt).not.toBeNull();
      expect(Date.parse(f.state().nextAttemptAt!)).toBe(900_000 + startClock.getTime());
      await f.worker.beginScan();
      expect(f.peers).toEqual([]);
    } finally {
      await f.worker.stop();
    }
  });

  test("the hourly cap survives a worker restart and expires on time", async () => {
    const f = await fixture({
      label: "hourly-restart",
      limit: { maxPerHour: 2, maxPending: 10 },
      now: startClock,
    });
    let resumed: ScoutWorker | undefined;
    try {
      await scan(f, 0, uniqueItems(1, 2));
      expect(f.filed).toHaveLength(2);
      await f.worker.beginScan();
      expect(f.peers).toHaveLength(1);

      await f.worker.stop();
      resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        syncMs: 900_000,
        now: () => new Date(f.clock.now),
        github: f.github,
        fileIssue: fakeFiling(f),
        connect: (peerOptions) => {
          const peer = new ControlledPeer(peerOptions);
          f.peers.push(peer);
          return peer;
        },
      });
      workers.push(resumed);
      expect(resumed.start("acme/fixture")).toBe(true);
      await waitFor(
        () => (resumed!.currentState.sync.state === "ok" ? true : undefined),
        "the restart's GitHub read",
      );
      await resumed.beginScan();
      expect(f.peers).toHaveLength(1);
      expect(f.filed).toHaveLength(2);

      f.clock.now = new Date(startClock.getTime() + 61 * 60_000);
      await resumed.refresh();
      await resumed.beginScan();
      await waitFor(() => f.peers[1], "the scan after the window opens", 4000);
      const request = readRequest(scanDirectoryOf(f.peers[1]!.prompts[0]!));
      expect(request.requested).toBe(2);
      writeRecommendations(
        scanDirectoryOf(f.peers[1]!.prompts[0]!),
        scanDocument(uniqueItems(3, 2)),
      );
      f.peers[1]!.succeed();
      await waitFor(() => (f.filed.length === 4 ? true : undefined), "the next two filings");
    } finally {
      await f.worker.stop();
      await resumed?.stop().catch(() => undefined);
    }
  });

  test("the pending cap frees a slot after the issue closes and the next sync scans", async () => {
    const f = await fixture({
      label: "pending-close",
      limit: { maxPerHour: 10, maxPending: 1 },
      now: startClock,
    });
    try {
      await scan(f, 0, uniqueItems(1, 1));
      expect(f.filed).toHaveLength(1);
      await f.worker.beginScan();
      expect(f.peers).toHaveLength(1);

      const filed = f.github.issues[0]!;
      filed.state = "closed";
      f.github.openTitles.length = 0;
      await f.worker.refresh();
      const peer = await waitFor(() => f.peers[1], "the scan after the close");
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument([recommendation(2)]),
      );
      peer.succeed();
      await waitFor(
        () => (f.filed.length === 2 ? f.state() : undefined),
        "the second filing",
      );
      expect(f.state().issues.filter((row) => row.state === "pending")).toHaveLength(1);
    } finally {
      await f.worker.stop();
    }
  });
});

describe("limits", () => {
  test("a limits command applies to a running worker and survives a restart", async () => {
    const f = await fixture({ label: "limits" });
    let resumed: ScoutWorker | undefined;
    try {
      decide(f, { type: "limits", maxPerHour: 1, maxPending: 1 });
      const limited = await waitFor(
        () =>
          f.state().limits.maxPerHour === 1 && f.state().limits.maxPending === 1
            ? f.state()
            : undefined,
        "the applied limits",
      );
      expect(limited.limits).toEqual({ maxPerHour: 1, maxPending: 1 });
      expect(readSettings(settingsPath(f.stateDir, f.root))).toEqual({
        maxPerHour: 1,
        maxPending: 1,
        intervalMinutes: 1,
      });
      expect(limited.notice).toContain("Limits saved");

      await f.worker.stop();
      resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        syncMs: 900_000,
        github: f.github,
        connect: (peerOptions) => new ControlledPeer(peerOptions),
      });
      workers.push(resumed);
      expect(resumed.start("acme/fixture")).toBe(true);
      expect(resumed.currentState.limits).toEqual({ maxPerHour: 1, maxPending: 1 });
      await resumed.stop();
    } finally {
      await f.worker.stop();
    }
  });

});

describe("periodic reads and state mapping", () => {
  test("open is pending, closed is implemented, and a reopen returns to pending", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "Open issue", createdAt: "2026-10-01T00:00:00.000Z" });
    github.add({
      number: 2,
      title: "Closed issue",
      state: "closed",
      createdAt: "2026-10-02T00:00:00.000Z",
      body: "## Category\n\nrobustness\n",
    });
    github.add({
      number: 3,
      title: "Closed not planned",
      state: "closed",
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const f = await fixture({
      label: "mapping",
      github,
      limit: { maxPerHour: 10, maxPending: 1 },
      now: startClock,
    });
    try {
      const synced = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      const byNumber = new Map(synced.issues.map((row) => [row.number, row]));
      expect(byNumber.get(1)?.state).toBe("pending");
      expect(byNumber.get(2)?.state).toBe("implemented");
      expect(byNumber.get(3)?.state).toBe("implemented");
      expect(byNumber.get(2)?.category).toBe("robustness");
      expect(byNumber.get(3)?.category).toBeNull();
      expect(synced.issues.map((row) => row.number)).toEqual([3, 2, 1]);

      github.issues[1]!.state = "open";
      github.openTitles.push("Closed issue");
      await f.worker.refresh();
      const reopened = await waitFor(
        () =>
          f.state().issues.find((row) => row.number === 2)?.state === "pending"
            ? f.state()
            : undefined,
        "the reopened issue",
      );
      expect(reopened.issues.find((row) => row.number === 2)?.state).toBe("pending");
    } finally {
      await f.worker.stop();
    }
  });

  test("a release published later fills a blank shipped version", async () => {
    const github = new FakeGitHub();
    github.add({
      number: 9,
      title: "Shipped later",
      state: "closed",
      createdAt: "2026-10-27T09:50:00.000Z",
    });
    const full = "a".repeat(40);
    github.closing.set(9, full);
    github.commits.set(full, full);
    const f = await fixture({
      label: "version",
      github,
      limit: { maxPerHour: 10, maxPending: 1 },
      now: startClock,
    });
    try {
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      expect(first.issues[0]?.state).toBe("implemented");
      expect(first.issues[0]?.version).toBeNull();

      github.releases.push({ tag: "v1.2.0", publishedAt: "2026-10-27T11:00:00.000Z" });
      github.containing.set(full, ["v1.2.0"]);
      await f.worker.refresh();
      const released = await waitFor(
        () => (f.state().issues[0]?.version === "v1.2.0" ? f.state() : undefined),
        "the shipped version",
      );
      expect(released.issues[0]?.version).toBe("v1.2.0");
    } finally {
      await f.worker.stop();
    }
  });

  test("a failed read keeps the rows, surfaces the reason, and blocks filing", async () => {
    const github = new FakeGitHub();
    github.failIssues = true;
    const f = await fixture({ label: "sync-failure", github });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed read",
      );
      expect(failed.sync.error).toContain("GitHub read failed");
      expect(failed.lastError).toContain("GitHub read failed");
      expect(failed.scan).toBeNull();
      await f.worker.beginScan();
      expect(f.peers).toEqual([]);

      github.failIssues = false;
      await f.worker.refresh();
      const peer = await waitFor(() => f.peers[0], "the scan after a good read");
      expect(f.state().sync.state).toBe("ok");
      expect(f.state().sync.at).not.toBeNull();
      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument([]));
      peer.succeed();
      await waitSettled(f.root, peer.prompts[0]!);
    } finally {
      await f.worker.stop();
    }
  });

  test("a rate-limited read stays in the sync reason and raises no error", async () => {
    const github = new FakeGitHub();
    github.failIssues = true;
    github.issuesError = RATE_LIMIT_ERROR;
    const f = await fixture({ label: "rate-limited", github });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the rate-limited read",
      );
      expect(failed.sync.error).toContain("API rate limit exceeded");
      // `lastError` is what the page raises as a global error notification.
      expect(failed.lastError).toBeNull();
      await f.worker.beginScan();
      expect(f.peers).toEqual([]);

      github.failIssues = false;
      await f.worker.refresh();
      expect(f.state().sync.state).toBe("ok");
    } finally {
      await f.worker.stop();
    }
  });

  test("a release read failure fails the sync", async () => {
    const github = new FakeGitHub();
    github.failReleases = true;
    const f = await fixture({ label: "release-failure", github });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed release read",
      );
      expect(failed.sync.error).toContain("release read failed");
      expect(failed.issues).toEqual([]);
    } finally {
      await f.worker.stop();
    }
  });

  test("the fresh read before filing files nothing when it fails", async () => {
    const f = await fixture({ label: "fresh-failure" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      f.github.failIssues = true;
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument(uniqueItems(1, 3)),
      );
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed pre-filing read",
      );
      expect(f.filed).toEqual([]);
      expect(failed.lastError).toContain("GitHub read failed");
      expect(failed.sync.error).toContain("GitHub read failed");
    } finally {
      await f.worker.stop();
    }
  });

  test("a rate-limited fresh read files nothing and raises no error", async () => {
    const f = await fixture({ label: "fresh-rate-limited" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      f.github.failIssues = true;
      f.github.issuesError = RATE_LIMIT_ERROR;
      writeRecommendations(
        scanDirectoryOf(peer.prompts[0]!),
        scanDocument(uniqueItems(1, 3)),
      );
      peer.succeed();
      // Wait for the scan to settle: `finishScan` runs after the sync failure.
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the rate-limited pre-filing read",
      );
      expect(f.filed).toEqual([]);
      expect(failed.sync.error).toContain("API rate limit exceeded");
      expect(failed.lastError).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });
});

describe("migration", () => {
  test("a version-1 board loads, discards its staged recommendations, and files none", async () => {
    const base = await temporaryDirectory("scout-migration");
    const root = await makeRepository({ files: sourceFiles(3), origin: "acme/fixture" });
    const stateDir = join(base, "state");
    const legacy = {
      version: 1,
      repo: "acme/fixture",
      root,
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: 7,
        startedAt: "2026-01-01T00:00:00.000Z",
        stateDir,
        harnessVersion: null,
        argv: [],
      },
      staged: [
        { ...recommendation(1), id: "one", stagedAt: "2026-01-01T00:00:00.000Z" },
        { ...recommendation(2), id: "two", stagedAt: "2026-01-01T00:00:00.000Z" },
      ],
      scan: null,
      newestScanId: "scan-old",
      shortfall: { staged: 2, missing: 7, reason: "Only two.", at: "2026-01-01T00:00:00.000Z" },
      nextAttemptAt: null,
      lastError: null,
      notice: null,
      decisions: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await mkdir(dirname(statePath(stateDir, root)), { recursive: true });
    writeFileSync(statePath(stateDir, root), `${JSON.stringify(legacy, null, 2)}\n`);

    const github = new FakeGitHub();
    const peers: ControlledPeer[] = [];
    const worker = new ScoutWorker({
      repoDir: root,
      stateDir,
      syncMs: 900_000,
      github,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      connect: (peerOptions) => {
        const peer = new ControlledPeer(peerOptions);
        peers.push(peer);
        return peer;
      },
      fileIssue: async () => {
        throw new Error("nothing may be filed from a migrated recommendation");
      },
    });
    workers.push(worker);
    try {
      expect(worker.start("acme/fixture")).toBe(true);
      expect(worker.currentState.issues).toEqual([]);
      expect(worker.currentState.limits).toEqual({ maxPerHour: 10, maxPending: 5 });
      expect(worker.currentState.newestScanId).toBe("scan-old");
      expect(worker.currentState.worker?.pid).toBe(process.pid);
      expect(worker.currentState.notice).toContain("Discarded 2 staged recommendations");
      const peer = await waitFor(() => peers[0], "the post-migration scan");
      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument([]));
      peer.succeed();
      await waitSettled(root, peer.prompts[0]!, "the post-migration scan to settle");
      expect(worker.currentState.issues).toEqual([]);
    } finally {
      await worker.stop();
    }
  });
});

describe("lifecycle", () => {
  test("Stop keeps the rows and the limits, releases the lock, and Start resumes", async () => {
    const f = await fixture({ label: "stop-start" });
    let resumed: ScoutWorker | undefined;
    try {
      await scan(f, 0, uniqueItems(1, 1));
      const before = f.state();
      const rows = before.issues.map((row) => row.number);
      await f.worker.stop();
      expect(f.state().lifecycle).toBe("stopped");
      expect(f.state().enabled).toBe(false);
      expect(f.state().issues.map((row) => row.number)).toEqual(rows);
      expect(f.state().limits).toEqual(before.limits);
      expect(existsSync(lockPath(f.root))).toBe(false);

      resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        syncMs: 900_000,
        github: f.github,
        now: () => new Date(f.clock.now),
        connect: (peerOptions) => new ControlledPeer(peerOptions),
      });
      workers.push(resumed);
      expect(resumed.start("acme/fixture")).toBe(true);
      expect(resumed.currentState.issues.map((row) => row.number)).toEqual(rows);
      expect(resumed.currentState.enabled).toBe(true);
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
        github: f.github,
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
        github: f.github,
        connect: (peerOptions) => new ControlledPeer(peerOptions),
      });
      workers.push(replacement);
      expect(replacement.start("acme/fixture")).toBe(true);
      expect(replacement.currentState.lastError).toContain("interrupted");
      expect(readScanFile(scanDirectory(f.root, scanId))?.status).toBe("failed");
      await replacement.stop();
    } finally {
      await f.worker.stop();
    }
  });

  test("stale scans are left under the checkout, never the state directory", async () => {
    const f = await fixture({ label: "scan-paths" });
    try {
      await scan(f, 0, uniqueItems(1, 1));
      const scans = readdirSync(scansDirectory(f.root));
      expect(scans).toHaveLength(1);
      expect(scanDirectory(f.root, scans[0]!).startsWith(f.root)).toBe(true);
    } finally {
      await f.worker.stop();
    }
  });
});

describe("dashboard bridge", () => {
  test("a reload replays the rows and limits without starting a worker", async () => {
    const f = await fixture({ label: "replay" });
    try {
      await scan(f, 0, uniqueItems(1, 1));
      let spawned = 0;
      const bridge = new ScoutBridge({
        descriptor: agentRegistry.require("scout"),
        repoDir: f.root,
        stateDir: f.stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
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
      expect(messages[0]?.type).toBe("agentState");
      const agent = messages[0]?.agent as Record<string, unknown> | undefined;
      expect((agent?.issues as unknown[] | undefined)?.length).toBe(1);
      expect(agent?.limits).toEqual({ maxPerHour: 10, maxPending: 5 });
      expect(messages[1]?.type).toBe("agentActivity");
      expect(spawned).toBe(0);
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });

  test("a connect-time replay reaches the clients that were already attached", async () => {
    const f = await fixture({ label: "replay-shared" });
    try {
      await scan(f, 0, uniqueItems(1, 1));
      const scanId = readdirSync(scansDirectory(f.root))[0]!;
      const activityFile = join(scanDirectory(f.root, scanId), "activity.json");
      writeFileSync(activityFile, JSON.stringify(["first"]));
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
      const bridge = new ScoutBridge({
        descriptor: agentRegistry.require("scout"),
        repoDir: f.root,
        stateDir: f.stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: (event, except) => {
          for (const [socket, messages] of attached) {
            if (socket !== except) messages.push(event as Record<string, unknown>);
          }
        },
        pollMs: 60_000,
        spawnWorker: () => undefined,
      });

      bridge.replay(firstSocket);
      const firstReplay = first.findLast((event) => event.type === "agentActivity");
      expect((firstReplay?.entries as Array<{ text: string }>).map((entry) => entry.text)).toEqual([
        "first",
      ]);

      // Activity grows after the first client's last poll; the second client's
      // replay now advances the shared baseline, so it must reach every client.
      writeFileSync(activityFile, JSON.stringify(["first", "second"]));
      bridge.replay(secondSocket);

      for (const client of [first, second]) {
        const replay = client.findLast(
          (event) => event.type === "agentActivity" && event.replay === true,
        );
        expect((replay?.entries as Array<{ text: string }>).map((entry) => entry.text)).toEqual([
          "first",
          "second",
        ]);
      }

      // The next refresh resumes from that baseline and appends only the new line.
      writeFileSync(activityFile, JSON.stringify(["first", "second", "third"]));
      bridge.refresh();
      expect(first.at(-1)).toMatchObject({
        type: "agentActivity",
        entries: [{ text: "third", append: false }],
      });
      expect(first.at(-1)?.replay).toBeUndefined();
      expect(second.at(-1)).toMatchObject({
        type: "agentActivity",
        entries: [{ text: "third", append: false }],
      });
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
        descriptor: agentRegistry.require("scout"),
        repoDir: f.root,
        stateDir: otherState,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
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
      const foreign = bridge.snapshot();
      expect(foreign.lifecycle).toBe("running");
      expect(foreign.owned).toBe(false);
      const started = await bridge.start();
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.notice).toContain(f.stateDir);
      expect(started.notice).toContain(otherState);
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
        descriptor: agentRegistry.require("scout"),
        repoDir: f.root,
        stateDir: f.stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
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

describe("filing actions", () => {
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
    };
  }

  test("filing one item creates the label when absent and returns its number", async () => {
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
    expect(result).toEqual({
      url: "https://github.com/acme/fixture/issues/42",
      number: 42,
    });
    expect(calls.map((argv) => argv.slice(0, 2).join(" "))).toEqual([
      "api repos/acme/fixture/labels/scout",
      "label create",
      "issue create",
    ]);
    const create = calls[2]!;
    expect(create[create.indexOf("--label") + 1]).toBe("scout");
    const body = readFileSync(create[create.indexOf("--body-file") + 1]!, "utf8");
    expect(body).toContain("## Category");
    expect(body).toContain("## Significance");
    expect(body).toContain("5/5");
    expect(body).toContain("third nested branch");
    expect(body).toContain("## Proposed change");
    expect(body).toContain("## Files");
    expect(body).toContain("## Acceptance criteria");
  });

  test("an existing scout label is not created again", async () => {
    const root = await makeRepository({ files: sourceFiles(2), origin: "acme/fixture" });
    const calls: string[][] = [];
    const run: GhRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return { code: 0, stdout: '{"name":"scout"}', stderr: "" };
      return { code: 0, stdout: "https://github.com/acme/fixture/issues/7", stderr: "" };
    };
    const result = await fileScoutIssue({
      repoDir: root,
      repository: "acme/fixture",
      recommendation: preparedItem(),
      environment: { HOME: root, PATH: process.env.PATH ?? "" },
      exec: authExec,
      run,
    });
    expect(result.number).toBe(7);
    expect(calls.some((argv) => argv[0] === "label")).toBe(false);
    expect(calls.filter((argv) => argv[0] === "issue")).toHaveLength(1);
  });

  test("the issue body names the significance score and reason", () => {
    const body = issueBody(preparedItem());
    expect(body).toContain("## Significance\n\n5/5\n\n");
    expect(body).toContain("third nested branch");
  });

  test("a failed filing leaves the rows unchanged and reports the reason", async () => {
    const f = await fixture({ label: "file-failure" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      f.failingIssue = { message: "the label does not exist" };
      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(uniqueItems(1, 2)));
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the filing failure",
      );
      expect(f.filed).toEqual([]);
      expect(failed.issues).toEqual([]);
      expect(failed.lastError).toContain("the label does not exist");
      expect(failed.notice).toContain("Scan failed");
    } finally {
      await f.worker.stop();
    }
  });
});

describe("bounded commands", () => {
  test("a periodic read that never resolves fails the sync and releases the worker", async () => {
    const github = new HangingGitHub();
    github.add({ number: 7, title: "Recovered finding", createdAt: "2026-10-27T09:00:00.000Z" });
    const started = Date.now();
    const f = await fixture({ label: "sync-deadline", github, readTimeoutMs: 1000 });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the timed out read",
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(failed.sync.error).toContain("the GitHub read did not finish within 1000 ms");
      expect(failed.lastError).toContain("the GitHub read did not finish within 1000 ms");

      // The failed read released `syncing`: a later refresh runs and succeeds.
      github.hanging = false;
      await f.worker.refresh();
      expect(f.state().sync.state).toBe("ok");
      expect(f.state().issues.map((row) => row.number)).toContain(7);
    } finally {
      await f.worker.stop();
    }
  });

  test("the default scout client bounds every periodic gh call", async () => {
    const directory = await temporaryDirectory("scout-gh-deadline");
    const script = join(directory, "gh");
    writeFileSync(script, `#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n`);
    await chmod(script, 0o755);
    const client = createScoutGitHub({
      repository: "acme/fixture",
      repoDir: directory,
      environment: { PATH: `${directory}:${process.env.PATH ?? ""}` },
      timeoutMs: 300,
    });

    const started = Date.now();
    const results = await Promise.allSettled([
      client.listIssues(),
      client.listReleases(),
      client.listOpenIssueTitles(),
    ]);
    expect(Date.now() - started).toBeLessThan(5000);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" ? String(result.reason) : "").toContain("deadline");
    }
  });

  test("a gh child that ignores SIGTERM is killed at the deadline", async () => {
    const directory = await temporaryDirectory("gh-deadline");
    const script = join(directory, "gh");
    const pidFile = join(directory, "pid");
    writeFileSync(
      script,
      `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$$" > ${JSON.stringify(pidFile)}\nwhile :; do :; done\n`,
    );
    await chmod(script, 0o755);

    const started = Date.now();
    const result = await ghCommand(
      ["version"],
      { PATH: `${directory}:${process.env.PATH ?? ""}` },
      { timeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.killed).toBe(true);
    expect(result.code).not.toBe(0);

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

  test("a filing that never resolves fails the scan at the deadline and clears it", async () => {
    const f = await fixture({
      label: "filing-deadline",
      timeoutMs: 1000,
      fileIssue: async () => await new Promise<never>(() => undefined),
    });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      writeRecommendations(scanPath, scanDocument(uniqueItems(1, 1)));
      const started = Date.now();
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!, "the filing deadline");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(settled.status).toBe("failed");
      expect(settled.error).toContain("timed out while reading and filing");
      const state = f.state();
      expect(state.lifecycle).toBe("failed");
      expect(state.scan).toBeNull();
      expect(state.lastError).toContain("timed out while reading and filing");
      expect(f.worker.scanning).toBe(false);
      expect(f.filed).toEqual([]);
    } finally {
      await f.worker.stop();
    }
  });

  test("agent activity keeps a scan alive past the scan deadline", async () => {
    const f = await fixture({ label: "scan-idle-reset", timeoutMs: 1000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      // The worker's deadline is a real timer; crossing it needs elapsed time.
      const started = Date.now();
      while (Date.now() - started < 1600) {
        peer.emit("still scanning\n");
        await Bun.sleep(200);
      }
      expect(f.state().lifecycle).toBe("scanning");

      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(uniqueItems(1, 1)));
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(settled.filed).toBe(1);
      expect(f.state().lastError).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });

  test("tool progress without an activity line keeps a scan alive", async () => {
    const f = await fixture({ label: "scan-progress-liveness", timeoutMs: 1000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      // A long tool emits only `tool_call_update` frames: protocol traffic that
      // the activity mapper drops. The scan must not be abandoned as silent.
      const started = Date.now();
      while (Date.now() - started < 1600) {
        peer.emitSessionUpdate();
        await Bun.sleep(200);
      }
      expect(f.state().lifecycle).toBe("scanning");

      writeRecommendations(scanDirectoryOf(peer.prompts[0]!), scanDocument(uniqueItems(1, 1)));
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(f.state().lastError).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });

  test("a silent agent is abandoned at the scan deadline", async () => {
    const f = await fixture({ label: "scan-idle-timeout", timeoutMs: 1000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the idle scan deadline",
        5000,
      );
      expect(failed.lastError).toContain("the scan timed out");
      expect(peer.closed).toBe(true);
      expect(readScanFile(scanDirectoryOf(peer.prompts[0]!))?.status).toBe("failed");
    } finally {
      await f.worker.stop();
    }
  });
});

describe("scan prompt", () => {
  test("the prompt states the significance rubric and the threshold", () => {
    const prompt = readFileSync(
      join(import.meta.dir, "..", "prompts", "scout-recommendations.md"),
      "utf8",
    );
    expect(prompt).toContain("`significance` from 1 to 5");
    expect(prompt).toContain("4 or 5 requires a named, observable impact");
    expect(prompt).toContain("polishing code that is already correct");
    expect(prompt).toContain("significanceThreshold");
  });
});

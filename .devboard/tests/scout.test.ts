import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import { ScoutBridge } from "../server/scout";
import { agentRegistry } from "../server/agents/registry";
import { callTool, type ToolResult } from "../mcp/tools";
import type { McpContext } from "../mcp/context";
import type {
  CreateForgeIssueInput,
  ForgeIssueDocument,
  ForgeIssueSummary,
  ForgeIssues,
} from "../lib/forge-issues";
import { writeCommand, type ScoutCommand } from "../issues/scout/control";
import { liveScanClaim } from "../issues/scout/claims";
import { versionLockPath } from "../issues/lock";
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
  versionedControlDirectory,
} from "../issues/scout/paths";
import { ghCommand } from "../issues/scout/preflight";
import { readScanFile, readSettings, type ScoutState } from "../issues/scout/state";
import { RESOLUTION_RETRY_MS, ScoutWorker } from "../issues/scout/worker";
import type { AcpPeer, IssuesPeerOptions } from "../issues/worker";
import {
  createdDirectories,
  makeRepository,
  sourceFiles,
  temporaryDirectory,
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
  readonly landed = new Map<number, string[]>();
  landedCalls = 0;
  failIssues = false;
  /** Replaces the generic issue-read failure when set. */
  issuesError: string | null = null;
  /** One queued issue-read failure per read attempt, consumed in order. */
  issueFailures: string[] = [];
  /** Every `listIssues` call, so a test can count read attempts. */
  readCalls = 0;
  failReleases = false;
  /** Replaces the generic release-read failure when set. */
  releasesError: string | null = null;
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
    this.readCalls += 1;
    const queued = this.issueFailures.shift();
    if (queued !== undefined) throw new Error(queued);
    if (this.failIssues) throw new Error(this.issuesError ?? "the GitHub read failed");
    return this.issues.map((issue) => ({ ...issue }));
  }

  async listOpenIssueTitles(): Promise<string[]> {
    if (this.failIssues) throw new Error(this.issuesError ?? "the GitHub read failed");
    return [...this.openTitles];
  }

  async listReleases(): Promise<ScoutRelease[]> {
    if (this.releasesError !== null) throw new Error(this.releasesError);
    if (this.failReleases) throw new Error("the release read failed");
    return this.releases.map((release) => ({ ...release }));
  }

  async closingCommit(issueNumber: number): Promise<string | null> {
    return this.closing.get(issueNumber) ?? null;
  }

  landedCommits(issueNumber: number): string[] {
    this.landedCalls += 1;
    return this.landed.get(issueNumber) ?? [];
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
    this.readCalls += 1;
    if (this.hanging) return await new Promise<ScoutGitHubIssue[]>(() => undefined);
    return await super.listIssues();
  }
}

/** Counts every release resolution; an unknown closing commit stays null. */
class UnresolvableGitHub extends FakeGitHub {
  closingCalls = 0;

  override async closingCommit(issueNumber: number): Promise<string | null> {
    this.closingCalls += 1;
    return await super.closingCommit(issueNumber);
  }
}

/** Counts every release resolution, and never completes one. */
class StalledResolutionGitHub extends FakeGitHub {
  closingCalls = 0;

  override async closingCommit(_issueNumber: number): Promise<string | null> {
    this.closingCalls += 1;
    return await new Promise<never>(() => undefined);
  }
}

/**
 * The forge the `issue_create` tool writes through in these tests. It mirrors
 * every created issue into the same `FakeGitHub` the worker reads, so the scan
 * reconciles exactly what the tool filed.
 */
class FakeForge implements ForgeIssues {
  readonly forge = "github" as const;
  readonly repository = "acme/fixture";
  readonly created: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
  }> = [];
  readonly labels = new Set<string>();
  readonly comments: Array<{ target: number | string; body: string }> = [];
  readonly closed: Array<{ number: number; reason: string }> = [];
  /** Replaces the generic creation failure when set. */
  createError: string | null = null;
  private readonly labelsByNumber = new Map<number, string[]>();

  constructor(
    private readonly github: FakeGitHub,
    private readonly now: () => Date,
  ) {}

  private issue(number: number): ScoutGitHubIssue {
    const issue = this.github.issues.find((row) => row.number === number);
    if (issue === undefined) throw new Error(`no forge issue #${number}`);
    return issue;
  }

  private document(issue: ScoutGitHubIssue): ForgeIssueDocument {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: this.labelsByNumber.get(issue.number) ?? [],
      url: issue.url,
      createdAt: issue.createdAt,
    };
  }

  private summary(issue: ScoutGitHubIssue): ForgeIssueSummary {
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: this.labelsByNumber.get(issue.number) ?? [],
      url: issue.url,
      createdAt: issue.createdAt,
    };
  }

  async list(state: "open" | "closed" | "all", limit = 100): Promise<ForgeIssueSummary[]> {
    return this.github.issues
      .filter((issue) => state === "all" || issue.state === state)
      .map((issue) => this.summary(issue))
      .slice(0, limit);
  }

  async get(number: number): Promise<ForgeIssueDocument> {
    return this.document(this.issue(number));
  }

  async ensureLabel(name: string): Promise<void> {
    this.labels.add(name);
  }

  async create(input: CreateForgeIssueInput): Promise<ForgeIssueDocument> {
    if (this.createError !== null) throw new Error(this.createError);
    const number = this.github.nextNumber++;
    const issue: ScoutGitHubIssue = {
      number,
      title: input.title,
      url: `https://github.com/acme/fixture/issues/${number}`,
      state: "open",
      createdAt: this.now().toISOString(),
      body: input.body,
    };
    this.github.issues.push(issue);
    this.github.openTitles.push(issue.title);
    const labels = [...(input.labels ?? [])];
    this.labelsByNumber.set(number, labels);
    this.created.push({ number, title: input.title, body: input.body, labels });
    return this.document(issue);
  }

  async comment(target: number | string, body: string): Promise<void> {
    this.comments.push({ target, body });
  }

  async close(number: number, reason: "completed" | "not planned"): Promise<ForgeIssueDocument> {
    const issue = this.issue(number);
    issue.state = "closed";
    const index = this.github.openTitles.indexOf(issue.title);
    if (index >= 0) this.github.openTitles.splice(index, 1);
    this.closed.push({ number, reason });
    return this.document(issue);
  }
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

/** One finding a scan files through the MCP issue tool. */
interface FiledItem {
  title: string;
  body?: string;
}

function bodyFor(title: string): string {
  return `## Summary\n\n${title} names a real failure mode.\n\n## Significance\n\n5/5\n\nA named defect.\n`;
}

function items(from: number, count: number): FiledItem[] {
  return Array.from({ length: count }, (_value, index) => ({
    title: `Improve module ${from + index} behavior`,
  }));
}

interface Fixture {
  root: string;
  stateDir: string;
  github: FakeGitHub;
  forge: FakeForge;
  peers: ControlledPeer[];
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
  tickMs?: number;
  readTimeoutMs?: number;
  timeoutMs?: number;
  limit?: { maxPerHour: number; maxPending: number };
  harnessVersion?: string;
  now?: Date;
  draftHeading?: string;
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
  const clock = { now: options.now ?? new Date("2026-10-27T10:00:00.000Z") };
  const forge = new FakeForge(github, () => clock.now);

  const f = {
    root,
    stateDir,
    github,
    forge,
    peers,
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
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
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
  });
  workers.push(worker);
  expect(worker.start("acme/fixture")).toBe(true);
  return f;
}

const startClock = new Date("2026-10-27T10:00:00.000Z");

/** The MCP context a scan's peer would use: the log sits in its scan dir. */
function toolContext(f: Fixture, scanPath: string): McpContext {
  return {
    repoDir: f.root,
    harnessDir: join(f.root, ".devboard"),
    stateDir: f.stateDir,
    environment: {
      DEVBOARD_TOOL_LOG: join(scanPath, "tool-log.jsonl"),
      REPO_DIR: f.root,
      STATE_DIR: f.stateDir,
    },
    forgeIssues: f.forge,
  };
}

/** Files one finding through the real tool, exactly as the prompt asks. */
async function fileItem(f: Fixture, scanPath: string, item: FiledItem): Promise<ToolResult> {
  return await callTool(toolContext(f, scanPath), "issue_create", {
    title: item.title,
    body: item.body ?? bodyFor(item.title),
    labels: ["scout"],
  });
}

/** Runs one scan: waits for its peer, files through the tool, and settles it. */
async function scan(f: Fixture, index: number, findings: FiledItem[]): Promise<ControlledPeer> {
  const peer = await waitFor(() => f.peers[index], `scan peer ${index + 1}`);
  const scanPath = scanDirectoryOf(peer.prompts[0]!);
  for (const item of findings) await fileItem(f, scanPath, item);
  peer.succeed();
  await waitSettled(f.root, peer.prompts[0]!, `scan ${index + 1} to settle`);
  return peer;
}

function decide(f: Fixture, command: ScoutCommand): void {
  writeCommand(controlDirectory(f.stateDir, f.root), command);
}

/** Moves the injected clock and runs one worker tick. */
async function tickAt(f: Fixture, instant: number): Promise<void> {
  f.clock.now = new Date(instant);
  await f.worker.tickNow();
}

describe("tool-driven filing", () => {
  test("a scan files through issue_create with the scout label and records it", async () => {
    const f = await fixture({ label: "auto-file" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      const request = readRequest(scanPath);
      expect(request.version).toBe(3);
      expect(request.requested).toBe(Math.min(10, 5));
      const result = await fileItem(f, scanPath, {
        title: "Improve module 1 behavior",
        body: "## Summary\n\nA named defect.\n\n## Significance\n\n5/5\n\nA named defect.\n",
      });
      expect(result).toEqual({ value: expect.objectContaining({ number: 100 }) });
      expect(f.forge.labels.has("scout")).toBe(true);
      expect(f.forge.created[0]?.labels).toEqual(["scout"]);
      peer.succeed();
      const settled = await waitFor(
        () => (f.state().issues.length === 1 ? f.state() : undefined),
        "the filed issue",
      );
      expect(settled.issues).toHaveLength(1);
      expect(settled.issues[0]?.state).toBe("pending");
      expect(settled.notice).toBe("Filed #100 “Improve module 1 behavior”");
      const scanFile = readScanFile(scanDirectory(f.root, basename(scanPath)));
      expect(scanFile?.status).toBe("succeeded");
      expect(scanFile?.filed).toBe(1);
      expect(scanFile?.shortfall).toBe("filed 1 of the 5 requested");
      expect(activityOf(scanPath)).toContain("filed #100");
      expect(settled.lifecycle).toBe("idle");
    } finally {
      await f.worker.stop();
    }
  });

  test("a failed tool call leaves the scan failed and sends no rewrite request", async () => {
    const f = await fixture({ label: "tool-error" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      f.forge.createError = "the forge refused the issue";
      const result = await fileItem(f, scanPath, { title: "Improve module 1 behavior" });
      expect(result.error).toContain("the forge refused the issue");
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the failed scan",
      );
      expect(f.forge.created).toEqual([]);
      expect(failed.issues).toEqual([]);
      expect(failed.lastError).toContain("the forge refused the issue");
      expect(failed.notice).toContain("Scan failed");
      const scanFile = readScanFile(scanDirectory(f.root, basename(scanPath)));
      expect(scanFile?.status).toBe("failed");
      expect(scanFile?.filed).toBe(0);
      expect(scanFile?.error).toContain("the forge refused the issue");
      // One peer turn only: a tool error never buys a correction turn.
      expect(peer.prompts).toHaveLength(1);
      expect(activityOf(scanPath)).toContain("failed: the forge refused the issue");
    } finally {
      await f.worker.stop();
    }
  });

  test("a scan that files nothing records zero filed and the shortfall", async () => {
    const f = await fixture({ label: "no-findings" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(settled.filed).toBe(0);
      expect(settled.requested).toBe(5);
      expect(settled.shortfall).toContain("filed 0 of the 5 requested");
      expect(f.state().issues).toEqual([]);
      expect(f.state().lastError).toBeNull();
      expect(activityOf(scanPath)).toContain("shortfall: filed 0 of the 5 requested");
    } finally {
      await f.worker.stop();
    }
  });

  test("a filed issue appears in state.issues after the scan reconciles the forge", async () => {
    const f = await fixture({ label: "state-reconcile" });
    try {
      await scan(f, 0, [
        { title: "Improve module 1 behavior" },
        { title: "Improve module 2 behavior" },
      ]);
      const settled = f.state();
      expect(settled.issues.map((row) => row.title)).toEqual([
        "Improve module 2 behavior",
        "Improve module 1 behavior",
      ]);
      expect(settled.issues.every((row) => row.state === "pending")).toBe(true);
      expect(settled.issues.map((row) => row.number)).toEqual([101, 100]);
      expect(settled.notice).toBe("Filed 2 issues in acme/fixture: #100, #101");
      expect(settled.lifecycle).toBe("idle");
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
      expect(request.version).toBe(3);
      // window 3, open 1: min(10 - 3, 5 - 1) = 4
      expect(request.requested).toBe(4);
      expect(request.maxPerHour).toBe(10);
      expect(request.maxPending).toBe(5);
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
      await scan(f, 0, items(1, 2));
      expect(f.forge.created).toHaveLength(2);
      await f.worker.beginScan();
      expect(f.peers).toHaveLength(1);

      await f.worker.stop();
      resumed = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        syncMs: 900_000,
        now: () => new Date(f.clock.now),
        github: f.github,
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
      expect(f.forge.created).toHaveLength(2);

      f.clock.now = new Date(startClock.getTime() + 61 * 60_000);
      await resumed.refresh();
      await resumed.beginScan();
      const peer = await waitFor(() => f.peers[1], "the scan after the window opens", 4000);
      const request = readRequest(scanDirectoryOf(peer.prompts[0]!));
      expect(request.requested).toBe(2);
      for (const item of items(3, 2)) await fileItem(f, scanDirectoryOf(peer.prompts[0]!), item);
      peer.succeed();
      await waitFor(
        () => (f.forge.created.length === 4 ? true : undefined),
        "the next two filings",
      );
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
      await scan(f, 0, items(1, 1));
      expect(f.forge.created).toHaveLength(1);
      await f.worker.beginScan();
      expect(f.peers).toHaveLength(1);

      const filed = f.github.issues[0]!;
      filed.state = "closed";
      f.github.openTitles.length = 0;
      await f.worker.refresh();
      const peer = await waitFor(() => f.peers[1], "the scan after the close");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      await fileItem(f, scanPath, { title: "Improve module 2 behavior" });
      peer.succeed();
      await waitSettled(f.root, peer.prompts[0]!, "the second filing");
      expect(f.forge.created).toHaveLength(2);
      expect(f.state().issues.filter((row) => row.state === "pending")).toHaveLength(1);
    } finally {
      await f.worker.stop();
    }
  });
});

describe("settings", () => {
  test("one settings command applies cadence and limits and survives a restart", async () => {
    const f = await fixture({ label: "settings" });
    let resumed: ScoutWorker | undefined;
    try {
      decide(f, { type: "settings", intervalMinutes: 30, maxPerHour: 1, maxPending: 1 });
      const saved = await waitFor(
        () =>
          f.state().intervalMinutes === 30 &&
          f.state().limits.maxPerHour === 1 &&
          f.state().limits.maxPending === 1
            ? f.state()
            : undefined,
        "the applied settings",
      );
      expect(saved.limits).toEqual({ maxPerHour: 1, maxPending: 1 });
      expect(readSettings(settingsPath(f.stateDir, f.root))).toEqual({
        maxPerHour: 1,
        maxPending: 1,
        intervalMinutes: 30,
      });
      expect(saved.notice).toContain("Settings saved");

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
      expect(resumed.currentState.intervalMinutes).toBe(30);
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

  test("an unresolved closed issue waits out its backoff before another attempt", async () => {
    const github = new UnresolvableGitHub();
    github.add({
      number: 12,
      title: "Closed without a commit",
      state: "closed",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const f = await fixture({ label: "version-backoff", github, now: startClock });
    try {
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      expect(github.closingCalls).toBe(1);
      expect(first.issues[0]?.version).toBeNull();
      expect(first.issues[0]?.versionAttemptAt).toBe(startClock.toISOString());
      expect(first.issues[0]?.versionError).toBe("no closing commit was found");

      await f.worker.refresh();
      expect(github.closingCalls).toBe(1);

      f.clock.now = new Date(startClock.getTime() + RESOLUTION_RETRY_MS);
      await f.worker.refresh();
      await waitFor(
        () => (github.closingCalls === 2 ? true : undefined),
        "the retry after the backoff",
      );
      expect(f.state().issues[0]?.versionAttemptAt).toBe(f.clock.now.toISOString());
    } finally {
      await f.worker.stop();
    }
  });

  test("a landed commit is re-resolved on every read without waiting out the backoff", async () => {
    const github = new FakeGitHub();
    github.add({
      number: 12,
      title: "Landed after the close",
      state: "closed",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const f = await fixture({ label: "landed-every-read", github, now: startClock });
    try {
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      expect(first.issues[0]?.versionError).toBe("no closing commit was found");

      const commit = "e".repeat(40);
      github.landed.set(12, [commit]);
      github.commits.set(commit, commit);
      github.containing.set(commit, []);
      await f.worker.refresh();

      const second = await waitFor(
        () =>
          f.state().issues[0]?.versionError === `no published release contains ${commit}`
            ? f.state()
            : undefined,
        "the landed retry",
      );
      expect(second.issues[0]?.version).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });

  test("a second sync resolves no already-attempted closed issue and still scans", async () => {
    const github = new UnresolvableGitHub();
    for (let index = 1; index <= 20; index += 1) {
      github.add({
        number: index,
        title: `Closed ${index}`,
        state: "closed",
        createdAt: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    const f = await fixture({ label: "resolution-backoff-many", github, now: startClock });
    try {
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      expect(github.closingCalls).toBe(20);
      expect(first.issues.every((row) => row.versionAttemptAt !== null)).toBe(true);

      await f.worker.refresh();
      expect(github.closingCalls).toBe(20);
      expect(f.state().sync.state).toBe("ok");
      await waitFor(() => (f.peers.length > 0 ? true : undefined), "the scan after the read");
    } finally {
      await f.worker.stop();
    }
  });

  test("a stalled resolution cannot hold syncing past the read deadline", async () => {
    const github = new StalledResolutionGitHub();
    for (let index = 1; index <= 20; index += 1) {
      github.add({
        number: index,
        title: `Closed ${index}`,
        state: "closed",
        createdAt: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    const f = await fixture({
      label: "resolution-deadline",
      github,
      readTimeoutMs: 400,
      now: startClock,
    });
    try {
      const started = Date.now();
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      expect(Date.now() - started).toBeLessThan(3000);
      expect(github.closingCalls).toBe(1);
      expect(first.issues).toHaveLength(20);
      const stalled = first.issues.filter((row) => row.versionAttemptAt !== null);
      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.versionError).toContain("release resolution did not finish");

      // `syncing` was released: the next sync runs, bounded by its own
      // deadline, and the tick that follows starts a scan.
      await f.worker.refresh();
      expect(github.closingCalls).toBe(2);
      expect(f.state().sync.state).toBe("ok");
      await waitFor(() => (f.peers.length > 0 ? true : undefined), "the scan after the read");
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

  test("a permanently failed read keeps the rows, surfaces the reason, and blocks filing", async () => {
    const github = new FakeGitHub();
    github.failIssues = true;
    github.issuesError = "gh: HTTP 401: Bad credentials";
    const f = await fixture({ label: "sync-failure", github });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed read",
      );
      expect(failed.sync.error).toContain("Bad credentials");
      expect(failed.lastError).toContain("Bad credentials");
      expect(failed.scan).toBeNull();
      await f.worker.beginScan();
      expect(f.peers).toEqual([]);

      github.failIssues = false;
      await f.worker.refresh();
      const peer = await waitFor(() => f.peers[0], "the scan after a good read");
      expect(f.state().sync.state).toBe("ok");
      expect(f.state().sync.at).not.toBeNull();
      peer.succeed();
      await waitSettled(f.root, peer.prompts[0]!);
    } finally {
      await f.worker.stop();
    }
  });

  test("a rate-limited read stays in the sync reason, raises no error, and waits a cadence", async () => {
    const github = new FakeGitHub();
    github.failIssues = true;
    github.issuesError = RATE_LIMIT_ERROR;
    const f = await fixture({
      label: "rate-limited",
      github,
      syncMs: 60_000,
      tickMs: 10 * 60_000,
    });
    try {
      await tickAt(f, f.clock.now.getTime());
      const failed = f.state();
      expect(failed.sync.state).toBe("error");
      expect(failed.sync.error).toContain("API rate limit exceeded");
      // `lastError` is what the page raises as a global error notification.
      expect(failed.lastError).toBeNull();
      await f.worker.beginScan();
      expect(f.peers).toEqual([]);

      // A rate limit is not a transport fault: the next attempt waits the
      // normal cadence, never the one-second retry schedule.
      const failedAt = f.clock.now.getTime();
      const reads = github.readCalls;
      await tickAt(f, failedAt + 1_000);
      expect(github.readCalls).toBe(reads);
      expect(f.state().sync.state).toBe("error");

      github.failIssues = false;
      await tickAt(f, failedAt + 60_000);
      expect(github.readCalls).toBe(reads + 1);
      expect(f.state().sync.state).toBe("ok");
    } finally {
      await f.worker.stop();
    }
  });

  test("a transient read failure is retried without a sync error and keeps the rows", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "First finding", createdAt: "2026-10-27T09:00:00.000Z" });
    const f = await fixture({
      label: "transient-retry",
      github,
      syncMs: 60_000,
      tickMs: 10 * 60_000,
      limit: { maxPerHour: 10, maxPending: 1 },
    });
    try {
      const start = f.clock.now.getTime();
      await tickAt(f, start);
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      const previousAt = first.sync.at!;
      const reads = github.readCalls;
      github.issueFailures.push("gh: HTTP 503: Service Unavailable");
      await f.worker.refresh();
      const retrying = f.state();
      expect(retrying.sync).toEqual({ state: "stale", at: previousAt, error: null });
      expect(retrying.issues.map((row) => row.number)).toEqual([1]);
      expect(retrying.lastError).toBeNull();
      expect(retrying.lifecycle).toBe("idle");

      await tickAt(f, Date.parse(previousAt) + 999);
      expect(github.readCalls).toBe(reads + 1);

      github.add({ number: 2, title: "Second finding", createdAt: "2026-10-27T09:05:00.000Z" });
      await tickAt(f, Date.parse(previousAt) + 1_000);
      const recovered = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the retried read",
      );
      expect(github.readCalls).toBe(reads + 2);
      expect(recovered.sync.error).toBeNull();
      expect(Date.parse(recovered.sync.at!)).toBeGreaterThan(Date.parse(previousAt));
      expect(recovered.issues.map((row) => row.number)).toEqual([2, 1]);
    } finally {
      await f.worker.stop();
    }
  });

  test("a transient read gets four retries and only the fifth failure is an error", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "First finding", createdAt: "2026-10-27T09:00:00.000Z" });
    const f = await fixture({
      label: "retry-schedule",
      github,
      syncMs: 60_000,
      tickMs: 10 * 60_000,
      limit: { maxPerHour: 10, maxPending: 1 },
    });
    try {
      const start = f.clock.now.getTime();
      await tickAt(f, start);
      const first = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the first read",
      );
      const previousAt = first.sync.at!;
      const reads = github.readCalls;
      github.failIssues = true;
      github.issuesError = "gh: HTTP 503: Service Unavailable";
      await f.worker.refresh();
      expect(f.state().sync).toEqual({ state: "stale", at: previousAt, error: null });

      let now = Date.parse(previousAt);
      let attempts = reads + 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        await tickAt(f, now + delay - 1);
        expect(f.state().sync.state).toBe("stale");
        expect(f.state().sync.error).toBeNull();
        expect(github.readCalls).toBe(attempts);

        await tickAt(f, now + delay);
        now += delay;
        attempts += 1;
        expect(github.readCalls).toBe(attempts);
        if (delay !== 8_000) {
          expect(f.state().sync).toEqual({ state: "stale", at: previousAt, error: null });
        }
      }
      expect(attempts).toBe(reads + 5);
      const failed = f.state();
      expect(failed.sync.state).toBe("error");
      expect(failed.sync.error).toContain("Service Unavailable");
      expect(failed.lastError).toContain("Service Unavailable");
      expect(failed.issues.map((row) => row.number)).toEqual([1]);

      // The next attempt is one cadence away, not another immediate retry.
      await tickAt(f, now + 1_000);
      expect(github.readCalls).toBe(attempts);
      expect(f.state().sync.state).toBe("error");
      await tickAt(f, now + 60_000);
      expect(github.readCalls).toBe(attempts + 1);
      expect(f.state().sync.state).toBe("error");
    } finally {
      await f.worker.stop();
    }
  });

  test("a success during the retry schedule clears everything", async () => {
    const github = new FakeGitHub();
    github.add({ number: 1, title: "First finding", createdAt: "2026-10-27T09:00:00.000Z" });
    github.issueFailures.push("gh: HTTP 502: Bad Gateway", "gh: HTTP 502: Bad Gateway");
    const f = await fixture({
      label: "retry-success",
      github,
      syncMs: 60_000,
      tickMs: 10 * 60_000,
      limit: { maxPerHour: 10, maxPending: 1 },
    });
    try {
      const failedAt = f.clock.now.getTime();
      await tickAt(f, failedAt);
      expect(github.readCalls).toBe(1);
      expect(f.state().sync.state).toBe("stale");
      expect(f.state().sync.error).toBeNull();
      await tickAt(f, failedAt + 1_000);
      expect(f.state().sync.state).toBe("stale");
      expect(f.state().sync.error).toBeNull();
      await tickAt(f, failedAt + 3_000);
      const recovered = await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the third read",
      );
      expect(github.readCalls).toBe(3);
      expect(recovered.sync.error).toBeNull();
      expect(recovered.issues.map((row) => row.number)).toEqual([1]);
    } finally {
      await f.worker.stop();
    }
  });

  for (const [label, message] of [
    ["credentials", "gh: HTTP 401: Bad credentials"],
    ["a missing repository", "gh: HTTP 404: Not Found"],
    ["a malformed answer", "gh issue list did not print a JSON array"],
    ["missing configuration", "the agent needs DEVBOARD_GITEA_URL for a Gitea origin"],
  ] as const) {
    test(`a permanent read failure (${label}) is attempted once and surfaces at once`, async () => {
      const github = new FakeGitHub();
      github.add({ number: 1, title: "First finding", createdAt: "2026-10-27T09:00:00.000Z" });
      const f = await fixture({
        label: `permanent-${label.replaceAll(" ", "-")}`,
        github,
        syncMs: 60_000,
        tickMs: 10 * 60_000,
        limit: { maxPerHour: 10, maxPending: 1 },
      });
      try {
        const start = f.clock.now.getTime();
        await tickAt(f, start);
        const first = await waitFor(
          () => (f.state().sync.state === "ok" ? f.state() : undefined),
          "the first read",
        );
        const reads = github.readCalls;
        github.failIssues = true;
        github.issuesError = message;
        await f.worker.refresh();
        const failed = f.state();
        expect(failed.sync).toEqual({ state: "error", at: first.sync.at, error: message });
        expect(failed.lastError).toBe(message);
        expect(github.readCalls).toBe(reads + 1);
        await tickAt(f, f.clock.now.getTime() + 1_000);
        expect(github.readCalls).toBe(reads + 1);
      } finally {
        await f.worker.stop();
      }
    });
  }

  test("a release read failure fails the sync", async () => {
    const github = new FakeGitHub();
    github.releasesError = "gh: HTTP 404: Not Found";
    const f = await fixture({ label: "release-failure", github });
    try {
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed release read",
      );
      expect(failed.sync.error).toContain("Not Found");
      expect(failed.issues).toEqual([]);
    } finally {
      await f.worker.stop();
    }
  });

  test("a failed reconcile after the turn leaves no rows and fails the scan", async () => {
    const f = await fixture({ label: "fresh-failure" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      await fileItem(f, scanPath, { title: "Improve module 1 behavior" });
      f.github.failIssues = true;
      f.github.issuesError = "gh: HTTP 401: Bad credentials";
      peer.succeed();
      const failed = await waitFor(
        () => (f.state().sync.state === "error" ? f.state() : undefined),
        "the failed post-turn read",
      );
      expect(f.state().issues).toEqual([]);
      expect(failed.lastError).toContain("Bad credentials");
      expect(failed.sync.error).toContain("Bad credentials");
      const scanFile = readScanFile(scanDirectory(f.root, basename(scanPath)));
      expect(scanFile?.status).toBe("failed");
      expect(scanFile?.filed).toBe(0);
    } finally {
      await f.worker.stop();
    }
  });

  test("a rate-limited reconcile files nothing into state and raises no error", async () => {
    const f = await fixture({ label: "fresh-rate-limited" });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      const scanPath = scanDirectoryOf(peer.prompts[0]!);
      await fileItem(f, scanPath, { title: "Improve module 1 behavior" });
      f.github.failIssues = true;
      f.github.issuesError = RATE_LIMIT_ERROR;
      peer.succeed();
      // Wait for the scan to settle: `finishScan` runs after the sync failure.
      const failed = await waitFor(
        () => (f.state().lifecycle === "failed" ? f.state() : undefined),
        "the rate-limited post-turn read",
      );
      expect(f.state().issues).toEqual([]);
      expect(failed.sync.error).toContain("API rate limit exceeded");
      expect(failed.lastError).toBeNull();
    } finally {
      await f.worker.stop();
    }
  });

  test("a page-open refresh reads without waiting for the sync interval", async () => {
    const github = new FakeGitHub();
    github.add({ number: 7, title: "Already filed", createdAt: "2026-10-01T00:00:00.000Z" });
    const f = await fixture({ label: "page-open-refresh", github, syncMs: 900_000 });
    try {
      await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the Start read",
      );
      expect(f.state().issues.map((row) => row.number)).toEqual([7]);

      // Without a command the next read is 15 minutes away; the page-open
      // command must surface the new issue immediately.
      github.add({ number: 8, title: "Filed later", createdAt: "2026-10-02T00:00:00.000Z" });
      writeCommand(controlDirectory(f.stateDir, f.root), { type: "refresh" });
      const refreshed = await waitFor(
        () => {
          const state = f.state();
          return state.issues.some((row) => row.number === 8) ? state : undefined;
        },
        "the page-open read",
      );
      expect(refreshed.sync.state).toBe("ok");
      expect(refreshed.sync.at).not.toBeNull();
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
      staged: [{ id: "one" }, { id: "two" }],
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
      await scan(f, 0, items(1, 1));
      const before = f.state();
      const rows = before.issues.map((row) => row.number);
      const lock = versionLockPath(lockPath(f.root), before.worker?.harnessVersion ?? null);
      expect(existsSync(lock)).toBe(true);
      await f.worker.stop();
      expect(f.state().lifecycle).toBe("stopped");
      expect(f.state().enabled).toBe(false);
      expect(f.state().issues.map((row) => row.number)).toEqual(rows);
      expect(f.state().limits).toEqual(before.limits);
      expect(existsSync(lock)).toBe(false);

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

  test("a live lock of the same version attaches without a second worker", async () => {
    const f = await fixture({ label: "live-lock", harnessVersion: "0.1.0" });
    try {
      const second = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        github: f.github,
        harnessVersion: "0.1.0",
      });
      workers.push(second);
      expect(second.start("acme/fixture")).toBe(false);
      expect(readFileSync(versionLockPath(lockPath(f.root), "0.1.0"), "utf8")).toContain(
        String(process.pid),
      );
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
      await scan(f, 0, items(1, 1));
      const scans = readdirSync(scansDirectory(f.root));
      expect(scans).toHaveLength(1);
      expect(scanDirectory(f.root, scans[0]!).startsWith(f.root)).toBe(true);
    } finally {
      await f.worker.stop();
    }
  });
});

describe("version takeover", () => {
  test("the older worker drains its in-flight scan and the newer worker claims the next one", async () => {
    const f = await fixture({ label: "takeover", harnessVersion: "0.0.9", syncMs: 60_000 });
    const newerPeers: ControlledPeer[] = [];
    let newer: ScoutWorker | undefined;
    try {
      const oldPeer = await waitFor(() => f.peers[0], "the old worker's scan");
      const oldScanId = basename(scanDirectoryOf(oldPeer.prompts[0]!));

      newer = new ScoutWorker({
        repoDir: f.root,
        stateDir: f.stateDir,
        syncMs: 60_000,
        cadenceMs: 0,
        harnessVersion: "0.1.0",
        now: () => new Date(f.clock.now),
        github: f.github,
        connect: (peerOptions) => {
          const peer = new ControlledPeer(peerOptions);
          newerPeers.push(peer);
          return peer;
        },
      });
      workers.push(newer);
      expect(newer.start("acme/fixture")).toBe(true);

      // The newer worker reads GitHub but cannot take the running scan slot.
      await waitFor(
        () => (newer!.currentState.sync.state === "ok" ? true : undefined),
        "the newer worker's first read",
      );
      await newer.beginScan();
      expect(newerPeers).toHaveLength(0);
      expect(readScanFile(scanDirectory(f.root, oldScanId))?.status).toBe("running");

      writeCommand(versionedControlDirectory(f.stateDir, f.root, "0.0.9"), { type: "drain" });
      await waitFor(
        () => (f.state().notice?.startsWith("Draining") ? true : undefined),
        "the old worker to publish its drain",
      );
      expect(f.state().enabled).toBe(false);
      expect(newerPeers).toHaveLength(0);

      // The old worker's in-flight scan finishes after the drain, then it
      // exits on its own and releases its versioned lock.
      await fileItem(f, scanDirectoryOf(oldPeer.prompts[0]!), {
        title: "Older worker takeover finding",
        body: "## Summary\n\nA finding.\n",
      });
      oldPeer.succeed();
      await waitSettled(f.root, oldPeer.prompts[0]!, "the old worker's in-flight scan");
      await waitFor(
        () => (f.state().lifecycle === "stopped" ? true : undefined),
        "the drained worker to exit",
      );
      expect(existsSync(versionLockPath(lockPath(f.root), "0.0.9"))).toBe(false);
      expect(existsSync(lockPath(f.root))).toBe(false);

      // The next scan belongs to the newer version, and its claim records it.
      const nextPeer = await waitFor(() => newerPeers[0], "the newer worker's scan");
      const claim = liveScanClaim(f.root);
      expect(claim?.harnessVersion).toBe("0.1.0");
      expect(claim?.scanId).not.toBe(oldScanId);
      await fileItem(f, scanDirectoryOf(nextPeer.prompts[0]!), {
        title: "Newer worker takeover finding",
        body: "## Summary\n\nA finding.\n",
      });
      nextPeer.succeed();
      await waitSettled(f.root, nextPeer.prompts[0]!, "the newer worker's scan");
    } finally {
      await newer?.stop();
      await f.worker.stop();
    }
  }, 20_000);
});

describe("dashboard bridge", () => {
  test("a page open asks the attached worker for one fresh read", async () => {
    const github = new FakeGitHub();
    github.add({ number: 7, title: "First", createdAt: "2026-10-01T00:00:00.000Z" });
    const f = await fixture({ label: "page-open-bridge", github, syncMs: 900_000 });
    try {
      await waitFor(
        () => (f.state().sync.state === "ok" ? f.state() : undefined),
        "the Start read",
      );
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
      github.add({ number: 8, title: "Second", createdAt: "2026-10-02T00:00:00.000Z" });
      bridge.requestSync();
      const refreshed = await waitFor(
        () => {
          const state = f.state();
          return state.issues.some((row) => row.number === 8) ? state : undefined;
        },
        "the page-open read",
      );
      expect(refreshed.sync.state).toBe("ok");
      expect(spawned).toBe(0);
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });

  test("a page open with no attached worker writes no command", async () => {
    const root = await temporaryDirectory("page-open-detached");
    const stateDir = join(root, "state");
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
    });
    bridge.requestSync();
    expect(existsSync(controlDirectory(stateDir, root))).toBe(false);
    bridge.dispose();
  });

  test("a reload replays the rows and limits without starting a worker", async () => {
    const f = await fixture({ label: "replay" });
    try {
      await scan(f, 0, items(1, 1));
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
      await scan(f, 0, items(1, 1));
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

  test("a worker of another harness version is listed with no mismatch notice", async () => {
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
      expect(snapshot.notice).toBeNull();
      expect(snapshot.workers).toEqual([
        {
          pid: process.pid,
          version: "0.0.9",
          stateDir: f.stateDir,
          lifecycle: "running",
        },
      ]);
      bridge.dispose();
    } finally {
      await f.worker.stop();
    }
  });
});



describe("bounded commands", () => {
  test("a periodic read that never resolves releases the worker and is retried", async () => {
    const github = new HangingGitHub();
    github.add({ number: 7, title: "Recovered finding", createdAt: "2026-10-27T09:00:00.000Z" });
    const started = Date.now();
    const f = await fixture({ label: "sync-deadline", github, readTimeoutMs: 1000 });
    try {
      const retrying = await waitFor(
        () => (f.state().sync.state === "stale" && github.readCalls > 0 ? f.state() : undefined),
        "the timed out read",
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(retrying.sync.error).toBeNull();
      expect(retrying.lastError).toBeNull();

      // The timed-out read released `syncing`: a later refresh runs and succeeds.
      await waitFor(
        () => (f.worker.readInFlight ? undefined : true),
        "the timed-out read to release the worker",
      );
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

  test("a post-turn forge read that stalls fails the scan at the deadline", async () => {
    const github = new HangingGitHub();
    github.hanging = false;
    const f = await fixture({ label: "settle-deadline", github, timeoutMs: 1000 });
    try {
      const peer = await waitFor(() => f.peers[0], "the first scan peer");
      github.hanging = true;
      const started = Date.now();
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!, "the settle deadline");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(settled.status).toBe("failed");
      expect(settled.error).toContain("timed out while reading and filing");
      const state = f.state();
      expect(state.lifecycle).toBe("failed");
      expect(state.scan).toBeNull();
      expect(state.lastError).toContain("timed out while reading and filing");
      expect(f.worker.scanning).toBe(false);
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

      await fileItem(f, scanDirectoryOf(peer.prompts[0]!), {
        title: "Improve module 1 behavior",
      });
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

      await fileItem(f, scanDirectoryOf(peer.prompts[0]!), {
        title: "Improve module 1 behavior",
      });
      peer.succeed();
      const settled = await waitSettled(f.root, peer.prompts[0]!);
      expect(settled.status).toBe("succeeded");
      expect(settled.filed).toBe(1);
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
  test("the prompt states the significance rubric, threshold, and caps", () => {
    const prompt = readFileSync(
      join(import.meta.dir, "..", "prompts", "scout-recommendations.md"),
      "utf8",
    );
    expect(prompt).toContain("an integer significance from 1 to 5");
    expect(prompt).toContain("4 or 5 requires a named, observable impact");
    expect(prompt).toContain("polishing code that is already correct");
    expect(prompt).toContain("significanceThreshold");
    expect(prompt).toContain("File at most `requested` issues");
    expect(prompt).toContain("`maxPerHour` and `maxPending`");
    expect(prompt).toContain("`labels`: exactly `[\"scout\"]`");
    expect(prompt).toContain("`issue_create`");
    expect(prompt).toContain("never rewrite an answer");
  });
});

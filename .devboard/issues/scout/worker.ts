import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../../server/acp";
import { recordedChildAlive } from "../../server/state";
import { readHarnessVersion } from "../../server/version";
import { acquireLock, liveLockOwner } from "../lock";
import { originRepository } from "../repository";
import { appendActivityLine, writeActivity } from "../state";
import { pollOpenIssues } from "../tracker";
import { fileScoutIssue, writeScoutDraft } from "./actions";
import { takeCommands, type ScoutCommand } from "./control";
import {
  DECISION_LIMIT,
  MAX_STAGED,
  RETRY_MS,
  SCAN_TIMEOUT_MS,
  controlDirectory,
  lockPath,
  recommendationsPath,
  scanDirectory,
  statePath,
} from "./paths";
import { normalizeTitle, parseScanResult, type ValidatedRecommendation } from "./recommendation";
import {
  buildRequest,
  createScanDirectory,
  promptFor,
  readDraftGoalHeadings,
  writeRequest,
} from "./scan";
import {
  emptyState,
  loadState,
  readScanFile,
  writeScanFile,
  writeState,
  type ScoutDecision,
  type ScoutScanFile,
  type ScoutState,
} from "./state";
import type { AcpPeer, IssuesPeerOptions } from "../worker";

/**
 * The detached worker for exactly one repository's Auto Scout board. It owns
 * the scan loop, the ACP peer, the repository lock, the decisions, and the
 * activity, so it outlives any dashboard process. A dashboard may start it,
 * read its state, and send it commands; nothing else can create a second scout
 * for the checkout.
 */

const TICK_MS = 100;
const DEFAULT_AGENT_COMMAND = "omp acp";
const FIRST_LINE_MAX = 400;
const MAX_ACTIVITY_LINE = 2000;

export interface ScoutWorkerOptions {
  repoDir: string;
  stateDir: string;
  agentCommand?: string;
  environment?: Record<string, string | undefined>;
  /** Wait before a shortfall or a failure schedules another scan. */
  retryMs?: number;
  /** A scan that exceeds this is closed as failed. */
  timeoutMs?: number;
  now?: () => Date;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: IssuesPeerOptions) => AcpPeer;
  /** The origin's open issue titles, read before every scan. */
  listIssues?: () => Promise<string[]>;
  fileIssue?: typeof fileScoutIssue;
  draftGoal?: typeof writeScoutDraft;
  harnessVersion?: string | null;
  log?: (line: string) => void;
  /** Runs after Stop has written its state and released the lock. */
  onStopped?: () => void;
}

interface ActiveScan {
  scanId: string;
  directory: string;
  requested: number;
  prompt: string;
  activity: string[];
  peer: AcpPeer;
  openIssueTitles: string[];
  draftGoalHeadings: string[];
  startedAt: string;
  finished: boolean;
  timer: Timer | undefined;
  firstLine: string | null;
}

/** Bounded one-line diagnostic from the peer's stderr. */
function boundedLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? "";
  return line.length <= FIRST_LINE_MAX ? line : `${line.slice(0, FIRST_LINE_MAX - 1)}…`;
}

export class ScoutWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly retryMs: number;
  readonly timeoutMs: number;
  private readonly agentCommand: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly connect: NonNullable<ScoutWorkerOptions["connect"]>;
  private readonly listIssues: NonNullable<ScoutWorkerOptions["listIssues"]> | undefined;
  private readonly fileIssue: typeof fileScoutIssue;
  private readonly draftGoal: typeof writeScoutDraft;
  private readonly harnessVersion: string | null;
  private readonly log: (line: string) => void;
  private readonly onStopped: (() => void) | undefined;

  private state: ScoutState;
  private active: ActiveScan | undefined;
  private starting = false;
  private stopping = false;
  /** One consumer at a time, so two ticks never apply the same decision. */
  private consuming = false;
  /** Decisions in flight, so one staged id can never be filed twice. */
  private readonly deciding = new Set<string>();
  private ticker: Timer | undefined;
  private lock: { release: () => void } | undefined;
  private lastSaved = "";

  constructor(options: ScoutWorkerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.retryMs = Math.max(0, options.retryMs ?? RETRY_MS);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? SCAN_TIMEOUT_MS);
    this.agentCommand =
      options.agentCommand ??
      options.environment?.AGENT_COMMAND ??
      process.env.AGENT_COMMAND ??
      DEFAULT_AGENT_COMMAND;
    this.environment = options.environment ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.connect =
      options.connect ?? ((peerOptions) => new AcpConnection(peerOptions) as unknown as AcpPeer);
    this.listIssues = options.listIssues;
    this.fileIssue = options.fileIssue ?? fileScoutIssue;
    this.draftGoal = options.draftGoal ?? writeScoutDraft;
    this.harnessVersion =
      options.harnessVersion ?? readHarnessVersion(resolve(import.meta.dir, "..", ".."));
    this.log = options.log ?? (() => undefined);
    this.onStopped = options.onStopped;
    this.state = emptyState({ repo: "", root: this.repoDir, now: this.clock() });
  }

  get currentState(): ScoutState {
    return this.state;
  }

  get scanning(): boolean {
    return this.active !== undefined;
  }

  /** Takes the repository lock and publishes a fresh `idle` cycle. */
  start(repository: string): boolean {
    const lockResult = acquireLock(lockPath(this.repoDir), {
      repo: this.repoDir,
      stateDir: this.stateDir,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
    });
    if (!lockResult.acquired) {
      this.log(`already running for ${this.repoDir}`);
      return false;
    }
    this.lock = lockResult;

    const previous = loadState(statePath(this.stateDir, this.repoDir));
    let lastError: string | null = null;
    if (previous?.scan != null) {
      this.closeInterruptedScan(previous.scan.scanId);
      lastError = "the previous scan was interrupted; it is recorded as failed";
    }

    const now = this.clock();
    this.state = {
      ...emptyState({ repo: repository, root: this.repoDir, now }),
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: process.pid,
        startedAt: now.toISOString(),
        stateDir: this.stateDir,
        harnessVersion: this.harnessVersion,
        argv: [...process.argv],
      },
      staged: previous?.staged ?? [],
      decisions: previous?.decisions ?? [],
      newestScanId: previous?.newestScanId ?? null,
      shortfall: previous?.shortfall ?? null,
      lastError,
      updatedAt: now.toISOString(),
    };
    this.publish();
    this.startTicker();
    return true;
  }

  /** A scan interrupted by a dead worker is closed, never left `running`. */
  private closeInterruptedScan(scanId: string): void {
    const directory = scanDirectory(this.repoDir, scanId);
    const scan = readScanFile(directory);
    if (scan === undefined || scan.status !== "running") return;
    if (scan.acp !== null && recordedChildAlive(scan.acp)) {
      try {
        process.kill(scan.acp.pid, "SIGKILL");
        this.log(`terminated orphaned ACP child ${scan.acp.pid}`);
      } catch {
        // It exited between the proof and the signal.
      }
    }
    try {
      writeScanFile(directory, {
        ...scan,
        status: "failed",
        finishedAt: this.clock().toISOString(),
        error: "the worker that owned this scan exited",
      });
    } catch {
      // The record is diagnostic; the new scan writes its own.
    }
  }

  private publish(): void {
    this.state.updatedAt = this.clock().toISOString();
    const text = JSON.stringify(this.state);
    if (text === this.lastSaved) return;
    try {
      writeState(statePath(this.stateDir, this.repoDir), this.state);
      this.lastSaved = text;
    } catch (error) {
      this.log(`could not write state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startTicker(): void {
    if (this.ticker !== undefined) return;
    this.ticker = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    await this.consumeCommands();
    if (this.stopping) return;
    if (!this.state.enabled) return;
    if (this.active !== undefined || this.starting) return;
    if (this.state.staged.length >= MAX_STAGED) return;
    if (this.cooldownRemaining()) return;
    await this.beginScan();
  }

  private cooldownRemaining(): boolean {
    const until = this.state.nextAttemptAt;
    if (until === null) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && this.clock().getTime() < at;
  }

  private async consumeCommands(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;
    try {
      const commands = takeCommands(controlDirectory(this.stateDir, this.repoDir));
      for (const command of commands) {
        if (this.stopping) return;
        await this.apply(command);
      }
    } finally {
      this.consuming = false;
    }
  }

  private async apply(command: ScoutCommand): Promise<void> {
    switch (command.type) {
      case "stop": {
        await this.stop();
        return;
      }
      case "scan": {
        if (this.active !== undefined || this.starting) {
          this.state.notice = "A scan is already running.";
          this.state.lastError = null;
          this.publish();
          return;
        }
        if (this.state.staged.length >= MAX_STAGED) {
          this.state.notice = "The board already holds nine recommendations.";
          this.state.lastError = null;
          this.publish();
          return;
        }
        this.state.nextAttemptAt = null;
        this.state.notice = null;
        this.publish();
        await this.beginScan();
        return;
      }
      case "approve":
      case "draft":
      case "reject": {
        await this.decide(command.type, command.id);
        return;
      }
    }
  }

  private removeStaged(id: string): void {
    this.state.staged = this.state.staged.filter((item) => item.id !== id);
    if (this.state.staged.length === 0) this.state.shortfall = null;
  }

  private recordDecision(decision: ScoutDecision): void {
    this.state.decisions = [...this.state.decisions, decision].slice(-DECISION_LIMIT);
  }

  /** One click, one outcome: a decision applies to exactly one staged item. */
  private async decide(kind: "approve" | "draft" | "reject", id: string): Promise<void> {
    if (this.deciding.has(id)) {
      this.state.notice = "That decision is already in progress.";
      this.state.lastError = null;
      this.publish();
      return;
    }
    const recommendation = this.state.staged.find((item) => item.id === id);
    if (recommendation === undefined) {
      this.state.notice = "That recommendation is no longer staged.";
      this.state.lastError = null;
      this.publish();
      return;
    }
    if (kind === "reject") {
      this.removeStaged(id);
      this.state.shortfall = null;
      this.state.lastError = null;
      this.state.notice = `Rejected “${recommendation.title}”.`;
      this.recordDecision({
        id,
        kind,
        title: recommendation.title,
        at: this.clock().toISOString(),
        url: null,
        path: null,
      });
      this.publish();
      this.refill();
      return;
    }

    this.deciding.add(id);
    try {
      if (kind === "approve") {
        const result = await this.fileIssue({
          repoDir: this.repoDir,
          repository: this.state.repo,
          recommendation,
          environment: this.environment,
        });
        this.removeStaged(id);
        this.state.shortfall = null;
        this.state.lastError = null;
        this.state.notice = `Filed ${result.url}`;
        this.recordDecision({
          id,
          kind,
          title: recommendation.title,
          at: this.clock().toISOString(),
          url: result.url,
          path: null,
        });
      } else {
        const result = await this.draftGoal(recommendation, { repoDir: this.repoDir });
        this.removeStaged(id);
        this.state.shortfall = null;
        this.state.lastError = null;
        this.state.notice = `Drafted ${result.path}`;
        this.recordDecision({
          id,
          kind,
          title: recommendation.title,
          at: this.clock().toISOString(),
          url: null,
          path: result.path,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.state.lastError = detail;
      this.state.notice =
        kind === "approve"
          ? `Could not file the issue: ${detail}`
          : `Could not draft the goal: ${detail}`;
      this.publish();
      return;
    } finally {
      this.deciding.delete(id);
    }
    this.publish();
    this.refill();
  }

  /** Clear the retry and start the scan that fills the freed slot. */
  private refill(): void {
    if (this.stopping || !this.state.enabled) return;
    if (this.state.staged.length >= MAX_STAGED) return;
    this.state.nextAttemptAt = null;
    this.publish();
    if (this.active === undefined && !this.starting) void this.beginScan();
  }

  private async openIssueTitles(): Promise<string[]> {
    if (this.listIssues !== undefined) return await this.listIssues();
    const result = await pollOpenIssues({
      repository: this.state.repo,
      environment: this.environment,
    });
    if (result.kind === "issues") return result.issues.map((issue) => issue.title);
    if (result.kind === "not-modified") return [];
    throw new Error(`could not read the open issues: ${result.detail}`);
  }

  /** One scan: one request file, one prompt, one validated answer. */
  async beginScan(): Promise<void> {
    if (this.stopping || this.active !== undefined || this.starting) return;
    if (!this.state.enabled || this.state.staged.length >= MAX_STAGED) return;
    this.starting = true;
    try {
      const missing = MAX_STAGED - this.state.staged.length;
      const openIssueTitles = await this.openIssueTitles();
      if (this.stopping) return;
      const scan = createScanDirectory(this.repoDir, this.clock());
      const draftGoalHeadings = readDraftGoalHeadings(this.repoDir);
      const request = buildRequest({
        scan,
        repository: this.state.repo,
        repoDir: this.repoDir,
        missing,
        staged: this.state.staged,
        openIssueTitles,
        draftGoalHeadings,
      });
      writeRequest(scan.directory, request);
      const prompt = promptFor(scan.directory);
      writeActivity(scan.directory, []);

      let peer: AcpPeer;
      try {
        peer = this.connect({
          command: this.agentCommand,
          cwd: this.repoDir,
          onActivity: (entry) => this.recordActivity(entry),
          onQuestion: (question) => this.answerQuestion(question),
          onStderr: (text) => this.recordStderr(text),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failed = { scanId: scan.scanId, directory: scan.directory, prompt, startedAt: scan.startedAt };
        this.writeScan(failed, "failed", { requested: missing, staged: 0, error: detail });
        this.state.newestScanId = scan.scanId;
        this.state.lastError = detail;
        this.state.notice = `Scan failed: ${detail}`;
        this.state.lifecycle = "failed";
        this.state.nextAttemptAt = new Date(
          this.clock().getTime() + this.retryMs,
        ).toISOString();
        this.publish();
        return;
      }

      const active: ActiveScan = {
        scanId: scan.scanId,
        directory: scan.directory,
        requested: missing,
        prompt,
        activity: [],
        peer,
        openIssueTitles,
        draftGoalHeadings,
        startedAt: scan.startedAt,
        finished: false,
        timer: undefined,
        firstLine: null,
      };
      this.active = active;
      this.state.scan = { scanId: scan.scanId, startedAt: scan.startedAt, requested: missing };
      this.state.newestScanId = scan.scanId;
      this.state.lifecycle = "scanning";
      this.state.nextAttemptAt = null;
      this.state.lastError = null;
      this.publish();
      this.writeScan(active, "running", { requested: missing, staged: 0 });

      active.timer = setTimeout(() => {
        this.abandonScan(active, "the scan timed out");
      }, this.timeoutMs);
      active.timer.unref?.();

      void peer
        .run(prompt)
        .then(() => this.completeScan(active))
        .catch((error: unknown) => {
          const detail =
            error instanceof Error && error.message.length > 0
              ? error.message
              : "the agent ended its turn with an error";
          this.abandonScan(active, detail);
        });
    } finally {
      this.starting = false;
    }
  }

  private recordActivity(entry: AcpActivity): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    appendActivityLine(active.activity, entry.text, entry.append);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // A write failure must not end the scan; the next update retries.
    }
  }

  private recordScanLine(active: ActiveScan, text: string): void {
    if (this.active !== active) return;
    appendActivityLine(active.activity, text.slice(0, MAX_ACTIVITY_LINE), false);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // Activity is diagnostic; a failed write never fails the scan.
    }
  }

  private recordStderr(text: string): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    if (active.firstLine !== null) return;
    const line = boundedLine(text);
    if (line.length > 0) active.firstLine = line;
  }

  /**
   * A question never blocks a scan: the recommended option is chosen, or the
   * first one when none is recommended, and both sides are recorded.
   */
  private answerQuestion(question: AcpQuestion): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    this.recordScanLine(active, `question: ${question.message}`);
    const option = question.options.find((entry) => entry.recommended) ?? question.options[0];
    const value = option?.label ?? "";
    const answered = active.peer.answer(question.id, value);
    this.recordScanLine(
      active,
      answered ? `answer: ${value.length === 0 ? "(no options offered)" : value}` : "answer: failed",
    );
    this.publish();
  }

  private writeScan(
    target: {
      scanId: string;
      directory: string;
      prompt: string;
      startedAt: string;
      peer?: AcpPeer;
    },
    status: ScoutScanFile["status"],
    extra: { requested: number; staged: number; error?: string; shortfall?: string },
  ): void {
    const acp = target.peer === undefined ? null : this.observedChild(target.peer);
    const scan: ScoutScanFile = {
      version: 1,
      scanId: target.scanId,
      repo: this.state.repo,
      root: this.repoDir,
      status,
      startedAt: target.startedAt,
      finishedAt: status === "running" ? null : this.clock().toISOString(),
      requested: extra.requested,
      staged: extra.staged,
      prompt: target.prompt,
      acp,
      error: extra.error ?? null,
      shortfall: extra.shortfall ?? null,
      workerPid: process.pid,
      harnessVersion: this.harnessVersion,
    };
    try {
      writeScanFile(target.directory, scan);
    } catch {
      // The published state is the contract; the scan file is diagnostic.
    }
  }

  /** The peer child as the process table sees it, for a later proof. */
  private observedChild(peer: AcpPeer): ScoutScanFile["acp"] {
    const pid = peer.pid;
    if (pid === undefined) return null;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
      return argv.length === 0 ? null : { pid, argv, cwd: this.repoDir };
    } catch {
      return { pid, argv: [...peer.argv], cwd: this.repoDir };
    }
  }

  private closePeer(active: ActiveScan): void {
    try {
      active.peer.close();
    } catch {
      // The peer already exited.
    }
  }

  /** A scan that timed out or whose peer failed: nothing is staged. */
  private abandonScan(active: ActiveScan, detail: string): void {
    if (active.finished) return;
    this.recordScanLine(active, `failed: ${detail}`);
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.closePeer(active);
    const error = active.firstLine ?? detail;
    this.writeScan(active, "failed", {
      requested: active.requested,
      staged: 0,
      error,
    });
    this.finishScan(active, error);
  }

  private finishScan(active: ActiveScan, error: string | null): void {
    this.active = undefined;
    this.state.scan = null;
    this.state.newestScanId = active.scanId;
    this.state.lastError = error;
    this.state.notice = error === null ? this.state.notice : `Scan failed: ${error}`;
    const now = this.clock();
    if (!this.stopping && this.state.enabled && this.state.staged.length < MAX_STAGED) {
      this.state.nextAttemptAt = new Date(now.getTime() + this.retryMs).toISOString();
    } else {
      this.state.nextAttemptAt = null;
    }
    this.state.lifecycle = error === null ? "idle" : "failed";
    this.publish();
  }

  /** Reads and validates the answer, then stages every novel item. */
  private async completeScan(active: ActiveScan): Promise<void> {
    if (active.finished) return;
    // Claim the terminal path before touching the answer, so the timeout can
    // no longer close a scan that is already settling.
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.closePeer(active);

    let text: string;
    try {
      text = readFileSync(recommendationsPath(active.directory), "utf8");
    } catch {
      this.writeScan(active, "failed", {
        requested: active.requested,
        staged: 0,
        error: "the agent wrote no recommendations.json",
      });
      this.finishScan(active, "the agent wrote no recommendations.json");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.writeScan(active, "failed", {
        requested: active.requested,
        staged: 0,
        error: "recommendations.json is not valid JSON",
      });
      this.finishScan(active, "recommendations.json is not valid JSON");
      return;
    }
    const result = parseScanResult(parsed, {
      missing: active.requested,
      repoDir: this.repoDir,
    });
    if (!result.ok) {
      this.recordScanLine(active, `rejected: ${result.error}`);
      this.writeScan(active, "failed", {
        requested: active.requested,
        staged: 0,
        error: result.error,
      });
      this.finishScan(active, result.error);
      return;
    }

    const now = this.clock();
    const known = new Set<string>([
      ...this.state.staged.map((item) => normalizeTitle(item.title)),
      ...active.openIssueTitles.map(normalizeTitle),
      ...active.draftGoalHeadings.map(normalizeTitle),
    ]);
    let accepted = 0;
    for (const item of result.items) {
      if (this.state.staged.length >= MAX_STAGED) break;
      const key = normalizeTitle(item.title);
      if (known.has(key)) {
        this.recordScanLine(active, `dropped duplicate “${item.title}”`);
        continue;
      }
      known.add(key);
      this.state.staged.push({ ...(item as ValidatedRecommendation), stagedAt: now.toISOString() });
      accepted += 1;
    }

    const staged = this.state.staged.length;
    if (staged >= MAX_STAGED) {
      this.state.shortfall = null;
    } else {
      const reason =
        result.shortfall ??
        (accepted < active.requested
          ? `the agent returned ${accepted} of the ${active.requested} requested recommendations`
          : "a decision freed a slot while the scan ran");
      this.state.shortfall = {
        staged,
        missing: MAX_STAGED - staged,
        reason,
        at: now.toISOString(),
      };
      this.recordScanLine(active, `shortfall: ${reason}`);
    }
    this.writeScan(active, "succeeded", {
      requested: active.requested,
      staged: accepted,
      shortfall: this.state.shortfall?.reason ?? "",
    });
    this.finishScan(active, null);
  }

  /** Stop: end the peer, keep the board, record `stopped`, release the lock. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const active = this.active;
    if (active !== undefined && !active.finished) {
      active.finished = true;
      if (active.timer !== undefined) clearTimeout(active.timer);
      active.timer = undefined;
      this.closePeer(active);
      this.writeScan(active, "stopped", { requested: active.requested, staged: 0 });
      this.active = undefined;
    }
    this.state.enabled = false;
    this.state.scan = null;
    this.state.nextAttemptAt = null;
    this.state.notice = null;
    this.state.lifecycle = "stopped";
    this.publish();
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.lock?.release();
    this.lock = undefined;
    this.onStopped?.();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}

function parseArguments(
  args: string[],
): { repoDir: string; stateDir: string; retryMs?: number } | undefined {
  let repoDir: string | undefined;
  let stateDir: string | undefined;
  let retryMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "--state-dir" || argument === "--retry") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) return undefined;
      if (argument === "--repo") repoDir = value;
      else if (argument === "--state-dir") stateDir = value;
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) retryMs = parsed;
      }
    }
  }
  if (repoDir === undefined || stateDir === undefined) return undefined;
  return { repoDir, stateDir, ...(retryMs === undefined ? {} : { retryMs }) };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    console.error("usage: worker.ts --repo <checkout> --state-dir <dir> [--retry <ms>]");
    process.exit(2);
  }
  const repoDir = resolve(parsed.repoDir);
  const stateDir = resolve(parsed.stateDir);
  const repository = originRepository(repoDir) ?? "";
  if (repository.length === 0) {
    console.error("scout worker: the checkout's origin does not name a repository");
    process.exit(2);
  }
  if (liveLockOwner(lockPath(repoDir)) !== undefined) {
    console.error("scout worker: this checkout already has a live scout");
    process.exit(0);
  }

  const worker = new ScoutWorker({
    repoDir,
    stateDir,
    ...(parsed.retryMs === undefined ? {} : { retryMs: parsed.retryMs }),
    log: (line) => console.error(`scout: ${line}`),
    onStopped: () => process.exit(0),
  });
  if (!worker.start(repository)) process.exit(0);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`scout: received ${signal}`);
    void worker.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  await main();
}

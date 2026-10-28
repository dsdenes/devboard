import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../../server/acp";
import { recordedChildAlive } from "../../server/state";
import { readHarnessVersion } from "../../server/version";
import { acquireLock, liveLockOwner } from "../lock";
import { originRepository } from "../repository";
import { appendActivityLine, writeActivity } from "../state";
import { fileScoutIssue } from "./actions";
import { takeCommands, type ScoutCommand } from "./control";
import {
  createScoutGitHub,
  isGitHubRateLimited,
  shippedVersion,
  type ScoutGitHubClient,
  type ScoutGitHubIssue,
  type ScoutRelease,
} from "./github";
import { ghCommand } from "./preflight";
import { originForge } from "../repository";
import { giteaBaseUrl } from "../../lib/forge";
import {
  HOUR_MS,
  SCAN_TIMEOUT_MS,
  SIGNIFICANCE_THRESHOLD,
  SYNC_INTERVAL_MS,
  controlDirectory,
  lockPath,
  recommendationsPath,
  scanDirectory,
  settingsPath,
  statePath,
} from "./paths";
import {
  categoryFromBody,
  normalizeTitle,
  parseScanResult,
  type ScanResult,
  type ScoutRecommendation,
} from "./recommendation";
import {
  buildRequest,
  createScanDirectory,
  promptFor,
  readDraftGoalHeadings,
  repairPrompt,
  writeRequest,
} from "./scan";
import {
  DEFAULT_LIMITS,
  emptyState,
  isValidLimit,
  loadState,
  readScanFile,
  readSettings,
  writeScanFile,
  writeSettings,
  writeState,
  type ScoutIssueRow,
  type ScoutLimits,
  type ScoutScanFile,
  type ScoutState,
} from "./state";
import type { AcpPeer, IssuesPeerOptions } from "../worker";

/**
 * The detached worker for exactly one repository's Auto Scout. It owns the
 * periodic GitHub read, the scan loop, the ACP peer, the repository lock, and
 * the activity, so it outlives any dashboard process. A scan files significant
 * recommendations directly as `scout` issues; nothing waits for an operator.
 */

const TICK_MS = 100;
const DEFAULT_AGENT_COMMAND = "omp acp";
const FIRST_LINE_MAX = 400;
const MAX_ACTIVITY_LINE = 2000;
/** One periodic read, including its default `gh` calls, may not outlive this. */
const READ_TIMEOUT_MS = 30_000;

export interface ScoutWorkerOptions {
  repoDir: string;
  stateDir: string;
  agentCommand?: string;
  environment?: Record<string, string | undefined>;
  /** The periodic GitHub read; 60 seconds in production. */
  syncMs?: number;
  /**
   * One periodic GitHub read is abandoned after this many milliseconds; the
   * sync records a failure and the next tick may read again. The default
   * client applies the same deadline to each `gh` child.
   */
  readTimeoutMs?: number;
  /**
   * A scan whose agent produces no activity for this many milliseconds is
   * closed as failed; the settle-and-file phase is bounded by the same value.
   */
  timeoutMs?: number;
  now?: () => Date;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: IssuesPeerOptions) => AcpPeer;
  /**
   * Injected for tests; defaults to the checkout's `gh` reads. An injected
   * client owns its own bound: `refresh` races the whole read against
   * `readTimeoutMs`, but a call that never settles still leaks its pending
   * work, so production clients must bound every command they start.
   */
  github?: ScoutGitHubClient;
  fileIssue?: typeof fileScoutIssue;
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
  draftGoalHeadings: string[];
  startedAt: string;
  finished: boolean;
  timer: Timer | undefined;
  firstLine: string | null;
  /** Issues filed so far, so a failed settle records the real count. */
  filed: number;
  /** Numbers this scan filed, in filing order, so the notice names them. */
  filedNumbers: number[];
  /** Correction turns already requested for a rejected answer; at most one. */
  repairs: number;
  /** Present while reading and filing, where the scan timer no longer guards. */
  settle?: {
    controller: AbortController;
    /** Epoch milliseconds shared by every read, probe, and filing. */
    deadline: number;
    timer: Timer;
    finished: boolean;
  };
}

/** The settle-and-file phase was aborted by its deadline or by Stop. */
class SettleAborted extends Error {
  constructor() {
    super("the scan stopped reading and filing");
  }
}

interface GitHubRead {
  issues: ScoutGitHubIssue[];
  releases: ScoutRelease[];
  openTitles: string[];
}

interface Capacity {
  /** How many issues this cycle may create. */
  batch: number;
  windowCount: number;
  openCount: number;
  hourlyRoom: number;
  pendingRoom: number;
  /** When zero capacity may become positive again. */
  blockedUntil: string | null;
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

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Newest creation first; the number breaks a same-instant tie. */
function newestFirst(rows: ScoutIssueRow[]): ScoutIssueRow[] {
  return [...rows].sort((left, right) => {
    const leftAt = Date.parse(left.createdAt);
    const rightAt = Date.parse(right.createdAt);
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
      return rightAt - leftAt;
    }
    return right.number - left.number;
  });
}

export class ScoutWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly syncMs: number;
  readonly readTimeoutMs: number;
  readonly timeoutMs: number;
  private readonly agentCommand: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly connect: NonNullable<ScoutWorkerOptions["connect"]>;
  private readonly injectedGithub: ScoutGitHubClient | undefined;
  private readonly fileIssue: typeof fileScoutIssue;
  private readonly harnessVersion: string | null;
  private readonly log: (line: string) => void;
  private readonly onStopped: (() => void) | undefined;

  private state: ScoutState;
  private github: ScoutGitHubClient | undefined;
  private active: ActiveScan | undefined;
  private starting = false;
  private stopping = false;
  /** One consumer at a time, so two ticks never apply the same command. */
  private consuming = false;
  /** One GitHub read at a time. */
  private syncing = false;
  /** A scan is reading and filing; the periodic read waits for it. */
  private filing = false;
  /** The open titles from the last successful read, for deduplication. */
  private openTitles: string[] = [];
  private ticker: Timer | undefined;
  private lock: { release: () => void } | undefined;
  private lastSaved = "";
  private nextSyncAt = 0;

  constructor(options: ScoutWorkerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.syncMs = Math.max(1000, options.syncMs ?? SYNC_INTERVAL_MS);
    this.readTimeoutMs = Math.max(1, options.readTimeoutMs ?? READ_TIMEOUT_MS);
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
    this.injectedGithub = options.github;
    this.fileIssue = options.fileIssue ?? fileScoutIssue;
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
    const limits = readSettings(settingsPath(this.stateDir, this.repoDir)) ?? previous?.limits;
    this.state = {
      ...emptyState({ repo: repository, root: this.repoDir, limit: limits, now }),
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: process.pid,
        startedAt: now.toISOString(),
        stateDir: this.stateDir,
        harnessVersion: this.harnessVersion,
        argv: [...process.argv],
      },
      limits: limits ?? { ...DEFAULT_LIMITS },
      issues: previous?.issues ?? [],
      sync: previous?.sync ?? { state: "stale", at: null, error: null },
      newestScanId: previous?.newestScanId ?? null,
      lastError,
      notice: previous?.notice ?? null,
      updatedAt: now.toISOString(),
    };
    this.github =
      this.injectedGithub ??
      createScoutGitHub({
        repository,
        repoDir: this.repoDir,
        environment: this.environment,
        timeoutMs: this.readTimeoutMs,
        ...this.forgeOptions(),
      });
    this.nextSyncAt = 0;
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
      this.log(`could not write state: ${detailOf(error)}`);
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
    if (this.stopping || !this.state.enabled) return;
    this.markStale();
    if (this.syncing || this.filing) return;
    if (this.clock().getTime() >= this.nextSyncAt) {
      await this.refresh();
      if (this.stopping || !this.state.enabled) return;
    }
    if (this.active !== undefined || this.starting) return;
    if (this.state.sync.state !== "ok") return;
    if (this.cooldownRemaining()) return;
    const capacity = this.capacity();
    if (capacity.batch === 0) {
      this.block(capacity.blockedUntil);
      return;
    }
    await this.beginScan();
  }

  /** A read that has not succeeded for two intervals is no longer trusted. */
  private markStale(): void {
    if (this.state.sync.state !== "ok") return;
    const at = this.state.sync.at;
    if (at === null) return;
    const last = Date.parse(at);
    if (!Number.isFinite(last)) return;
    if (this.clock().getTime() - last <= 2 * this.syncMs) return;
    this.state.sync = {
      state: "stale",
      at,
      error: `no GitHub read has succeeded for more than ${Math.round((2 * this.syncMs) / 1000)} seconds`,
    };
    this.publish();
  }

  private cooldownRemaining(): boolean {
    const until = this.state.nextAttemptAt;
    if (until === null) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && this.clock().getTime() < at;
  }

  private block(until: string | null): void {
    if (this.state.nextAttemptAt === until) return;
    this.state.nextAttemptAt = until;
    this.publish();
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
      case "limits": {
        if (!isValidLimit(command.maxPerHour) || !isValidLimit(command.maxPending)) {
          this.state.lastError = "Auto Scout limits must be integers from 1 through 100.";
          this.publish();
          return;
        }
        this.state.limits = {
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        try {
          writeSettings(settingsPath(this.stateDir, this.repoDir), this.state.limits);
        } catch (error) {
          this.log(`could not persist limits: ${detailOf(error)}`);
        }
        this.state.lastError = null;
        this.state.notice =
          `Limits saved: ${this.state.limits.maxPerHour} per hour, ` +
          `${this.state.limits.maxPending} open.`;
        this.state.nextAttemptAt = null;
        this.publish();
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Capacity                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The effective batch: how many issues this cycle may create. The hourly
   * window counts every Auto Scout issue created inside it, in any state, so a
   * restart never forgets a filing.
   */
  private capacity(now: Date = this.clock()): Capacity {
    const windowStart = now.getTime() - HOUR_MS;
    let windowCount = 0;
    let oldest = Number.POSITIVE_INFINITY;
    let openCount = 0;
    for (const issue of this.state.issues) {
      const createdAt = Date.parse(issue.createdAt);
      if (Number.isFinite(createdAt) && createdAt > windowStart) {
        windowCount += 1;
        if (createdAt < oldest) oldest = createdAt;
      }
      if (issue.state === "pending") openCount += 1;
    }
    const hourlyRoom = Math.max(0, this.state.limits.maxPerHour - windowCount);
    const pendingRoom = Math.max(0, this.state.limits.maxPending - openCount);
    const batch = Math.min(hourlyRoom, pendingRoom);
    let blockedUntil: string | null = null;
    if (batch === 0) {
      const candidates: number[] = [];
      if (pendingRoom === 0) candidates.push(now.getTime() + this.syncMs);
      if (hourlyRoom === 0 && Number.isFinite(oldest)) candidates.push(oldest + HOUR_MS);
      if (candidates.length === 0) candidates.push(now.getTime() + this.syncMs);
      blockedUntil = new Date(Math.min(...candidates)).toISOString();
    }
    return { batch, windowCount, openCount, hourlyRoom, pendingRoom, blockedUntil };
  }

  /* ------------------------------------------------------------------ */
  /* GitHub reads                                                        */
  /* ------------------------------------------------------------------ */

  private async readGitHub(active?: ActiveScan): Promise<GitHubRead> {
    const github = active === undefined ? this.github : this.githubFor(active);
    if (github === undefined) throw new Error("no GitHub client is configured");
    const [issues, releases, openTitles] = await Promise.all([
      github.listIssues(),
      github.listReleases(),
      github.listOpenIssueTitles(),
    ]);
    return { issues, releases, openTitles };
  }

  /**
   * One periodic read, raced against its deadline. The default client bounds
   * each `gh` child itself; this race also releases the worker from an
   * injected client that never settles, so a stall can never leave `syncing`
   * set forever.
   */
  private async readGitHubWithinDeadline(): Promise<GitHubRead> {
    const timedOut = Promise.withResolvers<never>();
    let timer: Timer | undefined;
    timer = setTimeout(() => {
      timedOut.reject(new Error(`the GitHub read did not finish within ${this.readTimeoutMs} ms`));
    }, this.readTimeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([this.readGitHub(), timedOut.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The periodic check: every `scout` issue, every published release, and the
   * open titles the next scan must not restate. A failed read keeps the last
   * known rows, records the reason, and blocks filing until a read succeeds.
   */
  async refresh(): Promise<void> {
    if (this.stopping || !this.state.enabled || this.syncing || this.filing) return;
    this.syncing = true;
    try {
      let read: GitHubRead;
      try {
        read = await this.readGitHubWithinDeadline();
      } catch (error) {
        this.recordSyncFailure(detailOf(error));
        return;
      }
      try {
        await this.applyRead(read);
      } catch (error) {
        this.recordSyncFailure(detailOf(error));
        return;
      }
      this.nextSyncAt = this.clock().getTime() + this.syncMs;
      this.publish();
      if (this.state.sync.state === "ok" && this.capacity().batch > 0) {
        this.state.nextAttemptAt = null;
      }
    } finally {
      this.syncing = false;
    }
  }

  private recordSyncFailure(detail: string): void {
    this.state.sync = { state: "error", at: this.state.sync.at, error: detail };
    // A spent GitHub request budget is environmental and clears itself. The
    // reason stays in the sync banner, but a rate limit never raises the
    // global error notification the operator can file as a harness issue.
    this.state.lastError = isGitHubRateLimited(detail) ? null : detail;
    this.state.notice = `Could not read GitHub: ${detail}`;
    this.state.nextAttemptAt = null;
    this.nextSyncAt = this.clock().getTime() + this.syncMs;
    this.publish();
  }

  private async applyRead(read: GitHubRead, active?: ActiveScan): Promise<void> {
    const github = active === undefined ? this.github : this.githubFor(active);
    const previous = new Map(this.state.issues.map((row) => [row.number, row]));
    const rows: ScoutIssueRow[] = [];
    for (const issue of read.issues) {
      const before = previous.get(issue.number);
      const state = issue.state === "closed" ? "implemented" : "pending";
      const category = before?.category ?? categoryFromBody(issue.body);
      let version: string | null = state === "implemented" ? (before?.version ?? null) : null;
      if (state === "implemented" && version === null && github !== undefined) {
        version = await shippedVersion(issue, github, read.releases);
      }
      rows.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        state,
        category,
        version,
      });
    }
    this.state.issues = newestFirst(rows);
    this.openTitles = read.openTitles;
    this.state.sync = { state: "ok", at: this.clock().toISOString(), error: null };
    this.state.lastError = null;
  }

  /* ------------------------------------------------------------------ */
  /* Scanning                                                            */
  /* ------------------------------------------------------------------ */

  /** One scan: one request file, one prompt, one validated answer. */
  async beginScan(): Promise<void> {
    if (this.stopping || this.active !== undefined || this.starting) return;
    if (!this.state.enabled || this.state.sync.state !== "ok") return;
    if (this.cooldownRemaining()) return;
    const capacity = this.capacity();
    if (capacity.batch === 0) {
      this.block(capacity.blockedUntil);
      return;
    }
    this.starting = true;
    try {
      const now = this.clock();
      const draftGoalHeadings = readDraftGoalHeadings(this.repoDir);
      const scan = createScanDirectory(this.repoDir, now);
      const request = buildRequest({
        scan,
        repository: this.state.repo,
        repoDir: this.repoDir,
        requested: capacity.batch,
        knownTitles: this.knownTitles(draftGoalHeadings),
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
        const detail = detailOf(error);
        const failed = {
          scanId: scan.scanId,
          directory: scan.directory,
          prompt,
          startedAt: scan.startedAt,
        };
        this.writeScan(failed, "failed", { requested: capacity.batch, filed: 0, error: detail });
        this.state.newestScanId = scan.scanId;
        this.state.lastError = detail;
        this.state.notice = `Scan failed: ${detail}`;
        this.state.lifecycle = "failed";
        this.state.nextAttemptAt = new Date(this.clock().getTime() + this.syncMs).toISOString();
        this.publish();
        return;
      }

      const active: ActiveScan = {
        scanId: scan.scanId,
        directory: scan.directory,
        requested: capacity.batch,
        prompt,
        activity: [],
        peer,
        draftGoalHeadings,
        startedAt: scan.startedAt,
        finished: false,
        timer: undefined,
        firstLine: null,
        filed: 0,
        filedNumbers: [],
        repairs: 0,
      };
      this.active = active;
      this.state.scan = { scanId: scan.scanId, startedAt: scan.startedAt, requested: capacity.batch };
      this.state.newestScanId = scan.scanId;
      this.state.lifecycle = "scanning";
      this.state.nextAttemptAt = null;
      this.state.lastError = null;
      this.publish();
      this.writeScan(active, "running", { requested: capacity.batch, filed: 0 });

      this.armScanTimer(active);

      void peer
        .run(prompt)
        .then(() => this.completeScan(active))
        .catch((error: unknown) => {
          const detail =
            detailOf(error).length > 0
              ? detailOf(error)
              : "the agent ended its turn with an error";
          this.abandonScan(active, detail);
        });
    } finally {
      this.starting = false;
    }
  }

  /** Normalized titles the scan must not restate: issues in any state, open ones, drafts. */
  private knownTitles(draftGoalHeadings: string[]): string[] {
    const titles = new Set<string>();
    for (const issue of this.state.issues) titles.add(normalizeTitle(issue.title));
    for (const title of this.openTitles) titles.add(normalizeTitle(title));
    for (const heading of draftGoalHeadings) titles.add(normalizeTitle(heading));
    return [...titles].sort();
  }

  private recordActivity(entry: AcpActivity): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    appendActivityLine(active.activity, entry.text, entry.append);
    this.armScanTimer(active);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // A write failure must not end the scan; the next update retries.
    }
  }

  /**
   * Arms the agent-phase deadline. Every activity entry restarts it, so only
   * an agent that has gone silent is abandoned; the settle-and-file phase
   * keeps its own fixed timer.
   */
  private armScanTimer(active: ActiveScan): void {
    clearTimeout(active.timer);
    active.timer = undefined;
    if (active.finished || this.active !== active) return;
    active.timer = setTimeout(() => {
      this.abandonScan(active, "the scan timed out");
    }, this.timeoutMs);
    active.timer.unref?.();
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
    extra: { requested: number; filed: number; error?: string; shortfall?: string },
  ): void {
    const acp = target.peer === undefined ? null : this.observedChild(target.peer);
    const scan: ScoutScanFile = {
      version: 2,
      scanId: target.scanId,
      repo: this.state.repo,
      root: this.repoDir,
      status,
      startedAt: target.startedAt,
      finishedAt: status === "running" ? null : this.clock().toISOString(),
      requested: extra.requested,
      filed: extra.filed,
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

  /** A scan that timed out or whose peer failed: nothing is filed. */
  private abandonScan(active: ActiveScan, detail: string): void {
    if (active.finished) return;
    this.recordScanLine(active, `failed: ${detail}`);
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.endSettle(active);
    this.closePeer(active);
    const error = active.firstLine ?? detail;
    this.writeScan(active, "failed", {
      requested: active.requested,
      filed: 0,
      error,
    });
    this.finishScan(active, error);
  }

  /** Starts the one deadline shared by every read, probe, and filing. */
  private beginSettle(active: ActiveScan): void {
    const timer = setTimeout(() => {
      this.failSettle(active, "the scan timed out while reading and filing");
    }, this.timeoutMs);
    timer.unref?.();
    active.settle = {
      controller: new AbortController(),
      deadline: Date.now() + this.timeoutMs,
      timer,
      finished: false,
    };
  }

  /** The phase ended normally; its timer must never fire. */
  private endSettle(active: ActiveScan): void {
    if (active.settle === undefined || active.settle.finished) return;
    active.settle.finished = true;
    clearTimeout(active.settle.timer);
  }

  /**
   * The deadline expired or Stop arrived: record one failure and abort every
   * child and pending step. A Stop has already written its own state, so the
   * failure is not recorded over it.
   */
  private failSettle(active: ActiveScan, detail: string): void {
    const settle = active.settle;
    if (settle === undefined || settle.finished) return;
    settle.finished = true;
    clearTimeout(settle.timer);
    settle.controller.abort();
    if (this.active !== active || this.stopping) return;
    this.recordScanLine(active, `failed: ${detail}`);
    this.writeScan(active, "failed", {
      requested: active.requested,
      filed: active.filed,
      error: detail,
    });
    this.finishScan(active, detail);
  }

  /** True once no further step may touch this scan. */
  private settled(active: ActiveScan): boolean {
    return active.settle?.finished === true || this.active !== active;
  }

  /**
   * Waits for one step but never past the phase deadline or Stop. The step
   * itself is abandoned on abort; its `gh` child is killed by the deadline or
   * the abort signal, so nothing outlives the phase.
   */
  private async within<T>(active: ActiveScan, work: Promise<T>): Promise<T> {
    const settle = active.settle;
    if (settle === undefined) return await work;
    if (settle.controller.signal.aborted) throw new SettleAborted();
    const aborted = Promise.withResolvers<never>();
    settle.controller.signal.addEventListener(
      "abort",
      () => aborted.reject(new SettleAborted()),
      { once: true },
    );
    return await Promise.race([work, aborted.promise]);
  }

  /** The origin forge and Gitea address, so the client never assumes GitHub. */
  private forgeOptions(): {
    forge?: "github" | "gitlab" | "gitea";
    baseUrl?: string;
  } {
    const remote = originForge(this.repoDir, this.environment);
    if (remote === undefined) return {};
    return {
      forge: remote.forge,
      ...(remote.forge === "gitea"
        ? { baseUrl: giteaBaseUrl(remote, this.environment) }
        : {}),
    };
  }

  /**
   * The GitHub client for a settle step. The periodic client is shared with
   * `refresh`, so only the settle path builds a bounded one.
   */
  private githubFor(active: ActiveScan): ScoutGitHubClient {
    if (this.injectedGithub !== undefined) return this.injectedGithub;
    const settle = active.settle;
    return createScoutGitHub({
      repository: this.state.repo,
      repoDir: this.repoDir,
      environment: this.environment,
      ...this.forgeOptions(),
      run: (argv, env) =>
        ghCommand(argv, env, {
          ...(settle === undefined
            ? {}
            : {
                timeoutMs: Math.max(1, settle.deadline - Date.now()),
                signal: settle.controller.signal,
              }),
        }),
    });
  }

  private finishScan(active: ActiveScan, error: string | null): void {
    this.endSettle(active);
    this.filing = false;
    this.active = undefined;
    this.state.scan = null;
    this.state.newestScanId = active.scanId;
    // The scan still failed, but a throttled GitHub read or write is
    // environmental: it must not raise the global error notification.
    this.state.lastError = error !== null && isGitHubRateLimited(error) ? null : error;
    this.state.notice = error === null ? this.state.notice : `Scan failed: ${error}`;
    this.state.lifecycle = error === null ? "idle" : "failed";
    const now = this.clock();
    const capacity = this.capacity(now);
    this.state.nextAttemptAt =
      capacity.batch > 0
        ? new Date(now.getTime() + this.syncMs).toISOString()
        : capacity.blockedUntil;
    this.publish();
  }

  /**
   * Reads and validates the answer file. A missing file, invalid JSON, and a
   * rejected document are all the same kind of failure: the correction turn
   * gets the message, and an uncorrected scan files nothing.
   */
  private readAnswer(
    active: ActiveScan,
  ): { ok: true; result: Extract<ScanResult, { ok: true }> } | { ok: false; error: string } {
    let text: string;
    try {
      text = readFileSync(recommendationsPath(active.directory), "utf8");
    } catch {
      return { ok: false, error: "the agent wrote no recommendations.json" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "recommendations.json is not valid JSON" };
    }
    const result = parseScanResult(parsed, {
      requested: active.requested,
      repoDir: this.repoDir,
    });
    return result.ok ? { ok: true, result } : { ok: false, error: result.error };
  }

  /**
   * Reads and validates the answer, asks the agent for one correction when the
   * answer is rejected while the scan timer still guards the phase, re-reads
   * GitHub immediately before filing, then files every significant, novel item
   * the caps allow. A malformed or insignificant item never reaches `gh`; a
   * failed read files nothing.
   */
  private async completeScan(active: ActiveScan): Promise<void> {
    if (active.finished) return;

    let answer = this.readAnswer(active);
    if (!answer.ok) {
      this.recordScanLine(active, `rejected: ${answer.error}`);
      if (active.repairs === 0) {
        active.repairs = 1;
        this.recordScanLine(active, "asked the agent to correct the answer");
        try {
          await active.peer.prompt(repairPrompt(active.directory, answer.error));
        } catch (error) {
          if (active.finished || this.active !== active) return;
          this.recordScanLine(active, `correction failed: ${detailOf(error)}`);
        }
        if (active.finished || this.active !== active) return;
        answer = this.readAnswer(active);
        if (!answer.ok) this.recordScanLine(active, `rejected: ${answer.error}`);
      }
    }
    if (!answer.ok) {
      this.writeScan(active, "failed", {
        requested: active.requested,
        filed: 0,
        error: answer.error,
      });
      this.finishScan(active, answer.error);
      return;
    }

    // The answer is final: claim the terminal path before touching the
    // tracker, so the scan timer can no longer close a scan that is settling.
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.closePeer(active);
    const result = answer.result;

    // Immediately before filing, read every scout issue again. The periodic
    // read stands aside until this scan has finished filing, so a stale apply
    // can never drop a row that was just created. A failed read files nothing
    // and surfaces the reason; the next read retries. Every wait and command
    // shares one deadline, because the scan timer no longer guards this phase.
    this.filing = true;
    this.beginSettle(active);
    try {
      while (this.syncing) await this.within(active, Bun.sleep(5));
      let read: GitHubRead;
      try {
        read = await this.within(active, this.readGitHub(active));
      } catch (error) {
        if (error instanceof SettleAborted) return;
        const detail = detailOf(error);
        this.recordScanLine(active, `failed: ${detail}`);
        this.recordSyncFailure(detail);
        this.writeScan(active, "failed", {
          requested: active.requested,
          filed: active.filed,
          error: detail,
        });
        this.finishScan(active, detail);
        return;
      }
      try {
        await this.within(active, this.applyRead(read, active));
      } catch (error) {
        if (error instanceof SettleAborted) return;
        const detail = detailOf(error);
        this.recordScanLine(active, `failed: ${detail}`);
        this.recordSyncFailure(detail);
        this.writeScan(active, "failed", {
          requested: active.requested,
          filed: active.filed,
          error: detail,
        });
        this.finishScan(active, detail);
        return;
      }
      if (this.settled(active)) return;
      this.publish();

      const known = new Set(this.knownTitles(active.draftGoalHeadings));
      const capacity = this.capacity();
      const limit = Math.min(active.requested, capacity.batch);
      let filingError: string | null = null;
      let lastFiled: { number: number; title: string } | null = null;
      for (const item of result.items) {
        if (this.settled(active) || this.stopping) break;
        if (item.significance < SIGNIFICANCE_THRESHOLD) {
          this.recordScanLine(
            active,
            `dropped “${item.title}” — significance ${item.significance}/5 is below ` +
              `${SIGNIFICANCE_THRESHOLD}`,
          );
          continue;
        }
        const key = normalizeTitle(item.title);
        if (known.has(key)) {
          this.recordScanLine(active, `dropped duplicate “${item.title}”`);
          continue;
        }
        if (active.filed >= limit) break;
        const settle = active.settle;
        let created: { url: string; number: number };
        try {
          created = await this.within(
            active,
            this.fileIssue({
              repoDir: this.repoDir,
              repository: this.state.repo,
              recommendation: item,
              environment: this.environment,
              ...(settle === undefined
                ? {}
                : { deadline: settle.deadline, signal: settle.controller.signal }),
            }),
          );
        } catch (error) {
          if (error instanceof SettleAborted) return;
          filingError = detailOf(error);
          this.recordScanLine(active, `failed to file “${item.title}”: ${filingError}`);
          break;
        }
        known.add(key);
        active.filed += 1;
        active.filedNumbers.push(created.number);
        lastFiled = { number: created.number, title: item.title };
        const createdAt = this.clock().toISOString();
        this.state.issues = newestFirst([
          ...this.state.issues.filter((row) => row.number !== created.number),
          {
            number: created.number,
            title: item.title,
            url: created.url,
            createdAt,
            state: "pending",
            category: item.category,
            version: null,
          },
        ]);
        this.recordScanLine(active, `filed #${created.number} “${item.title}”`);
        this.publish();
      }

      if (this.settled(active)) return;
      if (this.stopping) {
        this.filing = false;
        this.active = undefined;
        this.endSettle(active);
        this.writeScan(active, "stopped", { requested: active.requested, filed: active.filed });
        return;
      }

      if (lastFiled !== null) {
        this.state.notice =
          active.filed === 1
            ? `Filed #${lastFiled.number} “${lastFiled.title}”`
            : `Filed ${active.filed} issues in ${this.state.repo}: ` +
              active.filedNumbers.map((number) => `#${number}`).join(", ");
      }

      const shortfall =
        active.filed < active.requested
          ? (filingError ??
            result.shortfall ??
            `filed ${active.filed} of the ${active.requested} requested`)
          : null;
      if (shortfall !== null) this.recordScanLine(active, `shortfall: ${shortfall}`);
      this.writeScan(active, filingError === null ? "succeeded" : "failed", {
        requested: active.requested,
        filed: active.filed,
        ...(filingError === null ? {} : { error: filingError }),
        ...(shortfall === null ? {} : { shortfall }),
      });
      this.finishScan(active, filingError);
    } catch (error) {
      if (error instanceof SettleAborted) return;
      throw error;
    }
  }

  /** Stop: end the peer, keep the rows and limits, release the lock. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const active = this.active;
    if (active !== undefined) {
      if (active.settle !== undefined && !active.settle.finished) {
        // The scan timer no longer guards the filing phase; Stop aborts it
        // instead of waiting for a stalled read or filing to finish.
        active.settle.finished = true;
        clearTimeout(active.settle.timer);
        active.settle.controller.abort();
        this.filing = false;
        this.writeScan(active, "stopped", { requested: active.requested, filed: active.filed });
      } else if (!active.finished) {
        active.finished = true;
        clearTimeout(active.timer);
        active.timer = undefined;
        this.closePeer(active);
        this.writeScan(active, "stopped", { requested: active.requested, filed: 0 });
      }
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
): { repoDir: string; stateDir: string; syncMs?: number } | undefined {
  let repoDir: string | undefined;
  let stateDir: string | undefined;
  let syncMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "--state-dir" || argument === "--sync") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) return undefined;
      if (argument === "--repo") repoDir = value;
      else if (argument === "--state-dir") stateDir = value;
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 1000) syncMs = parsed;
      }
    }
  }
  if (repoDir === undefined || stateDir === undefined) return undefined;
  return { repoDir, stateDir, ...(syncMs === undefined ? {} : { syncMs }) };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    console.error("usage: worker.ts --repo <checkout> --state-dir <dir> [--sync <ms>]");
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

  const environmentSync = Number(process.env.SCOUT_SYNC_MS);
  const syncMs =
    parsed.syncMs ??
    (Number.isFinite(environmentSync) && environmentSync >= 1000 ? environmentSync : undefined);

  const worker = new ScoutWorker({
    repoDir,
    stateDir,
    ...(syncMs === undefined ? {} : { syncMs }),
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

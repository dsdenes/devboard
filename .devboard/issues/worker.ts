import { mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../server/acp";
import {
  createWorkerProviderEnvironment,
  type WorkerProviderEnvironment,
} from "../server/providers/worker-environment";
import { recordedChildAlive } from "../server/state";
import { readHarnessVersion } from "../server/version";
import { takeCommands, type IssuesCommand } from "./control";
import {
  emptyLedger,
  loadLedger,
  pruneLedger,
  recordHandled,
  writeLedger,
  type Ledger,
} from "./ledger";
import { migrateLegacyLedger } from "./legacy";
import { acquireLock, liveLockOwner } from "./lock";
import { originForge, originRepository } from "./repository";
import { giteaBaseUrl } from "../lib/forge";
import { controlDirectory, lockPath, runsDirectory, statePath } from "./paths";
import { clearClosedByRun, closedByRun } from "./self-close";
import {
  fetchIssueState,
  pollOpenIssues,
  TrackerTimeoutError,
  TRACKER_TIMEOUT_MS,
  type IssueStateResult,
  type PollResult,
} from "./tracker";
import {
  appendActivityLine,
  emptyState,
  listRunDirectories,
  loadStateWithText,
  parseRunFile,
  readActivity,
  runFilePath,
  runSummary,
  writeActivity,
  writeRunFile,
  writeState,
  type IssuesAcpChild,
  type IssuesAgent,
  type IssuesIssue,
  type IssuesQuestion,
  type IssuesRunStatus,
  type IssuesRunSummary,
  type IssuesState,
  type QueuedIssue,
  type RunFile,
} from "./state";

/**
 * The detached worker for exactly one repository. It owns the poll loop, the
 * ACP peers, the ledger, the repository lock, and the activity, so it outlives
 * any dashboard process. Every open, unhandled issue gets its own peer, up to
 * `MAX_CONCURRENT_PEERS`; the rest wait in the queue for a free slot.
 */

export const MAX_CONCURRENT_PEERS = 30;

/**
 * Follow-up turns one issue may get after a turn ended with its issue still
 * open. The ACP client owns the turn boundary: the agent runtime injects a
 * finished background job as a message, but nothing prompts the session again,
 * so a peer that yielded to a long job — `bun run publish` waits up to 1800
 * seconds — would otherwise leave its issue open with the work landed.
 */
export const MAX_FOLLOW_UP_TURNS = 4;

const DEFAULT_INTERVAL_MS = 10_000;
const COOLDOWN_MS = 5 * 60_000;
/** How long an abandon keeps its issue out of the queue. */
const DISMISS_MS = 2 * 60_000;
const TICK_MS = 100;
const IMPLEMENT_ISSUE_COMMAND = "/implement-issue";
const IMPLEMENT_GOAL_COMMAND = "/implement-goal-issue";
const GOAL_LABEL = "goal";
const DEFAULT_AGENT_COMMAND = "omp acp";
const FIRST_LINE_MAX = 400;
const RUN_HISTORY_LIMIT = 50;

export interface WorkerOptions {
  repoDir: string;
  stateDir: string;
  agentCommand?: string;
  environment?: Record<string, string | undefined>;
  intervalMs?: number;
  now?: () => Date;
  /** Injected for tests; defaults to the conditional `gh` tracker. */
  listIssues?: (options: { etag: string | null }) => Promise<PollResult>;
  /** Bounds one tracker read; defaults to `TRACKER_TIMEOUT_MS`. */
  pollTimeoutMs?: number;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: IssuesPeerOptions) => AcpPeer;
  /** Resolves each agent's provider environment; re-reads the store per run. */
  providerEnvironment?: WorkerProviderEnvironment;
  /** Injected for tests; defaults to the origin tracker's state for one issue. */
  issueState?: (number: number) => Promise<IssueStateResult>;
  harnessVersion?: string | null;
  log?: (line: string) => void;
  /** Runs after Stop has written its state and released the lock. */
  onStopped?: () => void;
}

export interface AcpPeer {
  readonly pid: number | undefined;
  readonly argv: string[];
  run(prompt: string): Promise<unknown>;
  /** Sends another prompt on the session `run` opened. */
  prompt(prompt: string): Promise<unknown>;
  answer(id: number | string, value: string): boolean;
  close(): void;
}

export interface IssuesPeerOptions {
  command: string;
  cwd: string;
  /** The selected provider environment for this one peer. */
  env?: Record<string, string | undefined>;
  onActivity: (activity: AcpActivity) => void;
  /** Every session update, including progress that maps to no activity line. */
  onSessionUpdate?: () => void;
  onQuestion: (question: AcpQuestion) => void;
  onStderr: (text: string) => void;
}

class FirstLine {
  private buffer = "";
  private found = false;
  value: string | null = null;

  push(chunk: string): void {
    if (this.found) return;
    this.buffer += chunk;
    const line = this.buffer
      .split("\n")
      .map((entry) => entry.replace(/\s+$/, ""))
      .find((entry) => entry.trim().length > 0);
    if (line !== undefined) {
      this.found = true;
      const trimmed = line.trim();
      this.value =
        trimmed.length <= FIRST_LINE_MAX ? trimmed : `${trimmed.slice(0, FIRST_LINE_MAX - 1)}…`;
      return;
    }
    if (this.buffer.length > FIRST_LINE_MAX * 8) this.buffer = this.buffer.slice(-FIRST_LINE_MAX);
  }

  finish(): void {
    if (this.found) return;
    const trimmed = this.buffer.trim();
    if (trimmed.length === 0) return;
    this.value =
      trimmed.length <= FIRST_LINE_MAX ? trimmed : `${trimmed.slice(0, FIRST_LINE_MAX - 1)}…`;
  }
}

interface ActiveRun {
  runId: string;
  directory: string;
  startedAt: string;
  issue: IssuesIssue;
  captured: IssuesIssue[];
  activity: string[];
  peer: AcpPeer;
  firstLine: FirstLine;
  /** Turns started on this peer, including the first prompt. */
  turns: number;
  /** True once the peer settled and the issue state is being verified. */
  settling: boolean;
  finished: boolean;
}

/** The child as the process table sees it, for a later proven termination. */
function observedChild(
  pid: number | undefined,
  cwd: string,
): { pid: number; argv: string[]; cwd: string } | null {
  if (pid === undefined) return null;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
    const actual = readlinkSync(`/proc/${pid}/cwd`);
    return argv.length === 0 ? null : { pid, argv, cwd: actual === cwd ? cwd : actual };
  } catch {
    return null;
  }
}

function uniqueRunDirectory(base: string, runId: string): { directory: string; runId: string } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? runId : `${runId}-${attempt}`;
    try {
      mkdirSync(join(base, candidate));
      return { directory: join(base, candidate), runId: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not create a run directory under ${base}`);
}

export function runIdentifier(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Loads every run record, newest first: every running run plus the newest
 * `limit` finished ones. A running agent never loses its directory.
 */
export function loadRuns(
  stateDir: string,
  repoDir: string,
  limit = RUN_HISTORY_LIMIT,
): Array<{ run: RunFile; directory: string; activity: number }> {
  const found: Array<{ run: RunFile; directory: string; activity: number }> = [];
  let finished = 0;
  for (const name of listRunDirectories(stateDir, repoDir)) {
    const directory = join(runsDirectory(stateDir, repoDir), name);
    try {
      const run = parseRunFile(readFileSync(runFilePath(directory), "utf8"));
      if (run === undefined) continue;
      if (run.status === "running") {
        found.push({ run, directory, activity: readActivity(directory).length });
      } else if (finished < limit) {
        found.push({ run, directory, activity: readActivity(directory).length });
        finished += 1;
      }
    } catch {
      // A run file that vanished mid-scan is already gone.
    }
  }
  return found;
}

export function isGoalIssue(issue: IssuesIssue): boolean {
  return (issue.labels ?? []).includes(GOAL_LABEL);
}

/** The exact prompt for one issue: `/implement-issue` or `/implement-goal-issue`. */
export function promptFor(issue: IssuesIssue): string {
  const command = isGoalIssue(issue) ? IMPLEMENT_GOAL_COMMAND : IMPLEMENT_ISSUE_COMMAND;
  return `${command} ${issue.number}`;
}

/**
 * The follow-up prompt for an issue whose turn ended while the issue was still
 * open. It names the exact gap — the runtime never wakes an ACP session — so
 * the peer reads its finished background job and closes the issue instead of
 * yielding a second time.
 */
export function continuationPrompt(
  issue: IssuesIssue,
  turn: number,
  limit: number,
): string {
  return [
    `Continue issue #${issue.number} in this session. Your previous turn ended while the issue was still open.`,
    "Nothing prompts this session again, so ending a turn before the issue is closed leaves it unhandled.",
    "If you started a background job, wait for it (`wait`) and read its result before you finish.",
    "Do not repeat work that already landed: check the pushed revision and the issue state first.",
    `Finish the task and close the issue, or stop with the one concrete blocker. Follow-up turn ${turn} of ${limit}.`,
  ].join(" ");
}

/**
 * Collects the previous state document's recorded ACP children and run ids
 * verbatim. It reads the bytes a load already read, so an unparseable file
 * that load quarantined still yields its records.
 */
function previousRecords(text: string | undefined): {
  children: IssuesAcpChild[];
  runIds: string[];
} {
  if (text === undefined) return { children: [], runIds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { children: [], runIds: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { children: [], runIds: [] };
  const record = parsed as Record<string, unknown>;
  const children: IssuesAcpChild[] = [];
  const runIds: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.pid === "number" &&
      Number.isInteger(candidate.pid) &&
      candidate.pid > 0 &&
      Array.isArray(candidate.argv) &&
      candidate.argv.every((entry) => typeof entry === "string") &&
      typeof candidate.cwd === "string"
    ) {
      children.push({
        pid: candidate.pid,
        argv: candidate.argv as string[],
        cwd: candidate.cwd,
      });
    }
  };
  const agents = Array.isArray(record.agents) ? record.agents : [];
  for (const agent of agents) {
    if (typeof agent !== "object" || agent === null) continue;
    const entry = agent as Record<string, unknown>;
    if (typeof entry.runId === "string") runIds.push(entry.runId);
    collect(entry.acp);
  }
  collect(record.acp);
  if (typeof record.activeRun === "object" && record.activeRun !== null) {
    const active = record.activeRun as Record<string, unknown>;
    if (typeof active.runId === "string") runIds.push(active.runId);
  }
  return { children, runIds };
}

export class IssuesWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly intervalMs: number;
  private readonly agentCommand: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly listIssues: NonNullable<WorkerOptions["listIssues"]>;
  private readonly pollTimeoutMs: number;
  private readonly connect: NonNullable<WorkerOptions["connect"]>;
  private readonly providerEnvironment: WorkerProviderEnvironment;
  private readonly issueState: NonNullable<WorkerOptions["issueState"]>;
  private readonly harnessVersion: string | null;
  private readonly log: (line: string) => void;

  private state: IssuesState;
  private ledger: Ledger;
  private readonly active = new Map<number, ActiveRun>();
  /**
   * Issues a dashboard reported closed, with the time their dismissal ends.
   * Skipped until this worker's own read drops them or the window passes, so
   * a stale queue cannot restart a run the operator has already closed.
   */
  private readonly dismissed = new Map<number, number>();
  private runs: Array<{ run: RunFile; directory: string }> = [];
  private stopping = false;
  private polling = false;
  private nextPollDue = 0;
  private ticker: Timer | undefined;
  private lock: { release: () => void } | undefined;
  private lastSaved = "";
  private readonly onStopped: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.agentCommand =
      options.agentCommand ??
      options.environment?.AGENT_COMMAND ??
      process.env.AGENT_COMMAND ??
      DEFAULT_AGENT_COMMAND;
    this.environment = options.environment ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.pollTimeoutMs = Math.max(1, options.pollTimeoutMs ?? TRACKER_TIMEOUT_MS);
    this.listIssues =
      options.listIssues ??
      ((request) => {
        const remote = originForge(this.repoDir, this.environment);
        return pollOpenIssues({
          repository: this.state.repo,
          etag: request.etag,
          environment: this.environment,
          timeoutMs: this.pollTimeoutMs,
          ...(remote === undefined ? {} : { forge: remote.forge }),
          ...(remote?.forge === "gitea"
            ? { baseUrl: giteaBaseUrl(remote, this.environment) }
            : {}),
        });
      });
    this.connect =
      options.connect ?? ((peerOptions) => new AcpConnection(peerOptions) as unknown as AcpPeer);
    this.providerEnvironment =
      options.providerEnvironment ??
      createWorkerProviderEnvironment(this.stateDir, this.environment);
    this.issueState =
      options.issueState ??
      ((number) => {
        const remote = originForge(this.repoDir, this.environment);
        return fetchIssueState(
          {
            repository: this.state.repo,
            environment: this.environment,
            ...(remote === undefined ? {} : { forge: remote.forge }),
            ...(remote?.forge === "gitea"
              ? { baseUrl: giteaBaseUrl(remote, this.environment) }
              : {}),
          },
          number,
        );
      });
    this.harnessVersion = options.harnessVersion ?? readHarnessVersion(resolve(import.meta.dir, ".."));
    this.log = options.log ?? (() => undefined);
    this.onStopped = options.onStopped;
    this.state = emptyState({
      repo: "",
      root: this.repoDir,
      intervalMs: this.intervalMs,
      now: this.clock(),
    });
    this.ledger = emptyLedger();
  }

  get currentState(): IssuesState {
    return this.state;
  }

  get running(): boolean {
    return this.active.size > 0;
  }

  /** Takes the repository lock and publishes the fresh `idle` cycle. */
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

    const path = statePath(this.stateDir, this.repoDir);
    const loaded = loadStateWithText(path);
    const records = previousRecords(loaded.text);
    this.ledger = loadLedger(this.stateDir, this.repoDir);
    let migrationError: string | null = null;
    const migrated = migrateLegacyLedger({
      stateDir: this.stateDir,
      repoDir: this.repoDir,
      now: this.clock(),
    });
    if (migrated !== undefined && migrated.length > 0) {
      const handled = { ...this.ledger.handled };
      for (const entry of migrated) {
        handled[String(entry.number)] = entry;
      }
      this.ledger = { version: 1, handled };
      migrationError = this.persistLedger();
      this.log(`migrated ${migrated.length} handled issue(s) from the legacy orchestrator`);
    }

    this.runs = loadRuns(this.stateDir, this.repoDir).map((entry) => ({
      run: entry.run,
      directory: entry.directory,
    }));
    // A worker that died mid-run leaves recorded children and `running`
    // records. Only a process the table proves is that child is signalled.
    for (const orphan of records.children) {
      if (!recordedChildAlive(orphan)) continue;
      try {
        process.kill(orphan.pid, "SIGKILL");
        this.log(`terminated orphaned ACP child ${orphan.pid}`);
      } catch {
        // It exited between the proof and the signal.
      }
    }
    const interrupted = new Set([
      ...records.runIds,
      ...this.runs.filter((entry) => entry.run.status === "running").map((entry) => entry.run.runId),
    ]);
    for (const runId of interrupted) this.closeInterruptedRun(runId);
    this.active.clear();

    const now = this.clock();
    this.state = {
      ...emptyState({
        repo: repository,
        root: this.repoDir,
        intervalMs: this.intervalMs,
        now,
      }),
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: process.pid,
        startedAt: now.toISOString(),
        stateDir: this.stateDir,
        harnessVersion: this.harnessVersion,
        argv: [...process.argv],
      },
      runs: this.summaries(),
      updatedAt: now.toISOString(),
    };
    if (migrationError !== null) this.state.lastError = migrationError;
    this.nextPollDue = now.getTime();
    this.publish();
    this.startTicker();
    return true;
  }

  private closeInterruptedRun(runId: string): void {
    const entry = this.runs.find((candidate) => candidate.run.runId === runId);
    if (entry === undefined) return;
    const run: RunFile = {
      ...entry.run,
      status: "stopped",
      finishedAt: this.clock().toISOString(),
      exitCode: null,
    };
    try {
      writeRunFile(entry.directory, run);
      entry.run = run;
    } catch {
      // The record stays as it was; the next successful run rewrites history.
    }
  }

  private summaries(): IssuesRunSummary[] {
    return this.runs.map((entry) => runSummary(entry.run, readActivity(entry.directory).length));
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
    await this.guarded("consume control commands", () => this.consumeCommands());
    if (this.stopping) return;
    if (!this.state.enabled) return;
    if (this.polling) return;
    if (this.clock().getTime() < this.nextPollDue) return;
    await this.guarded("poll the tracker", () => this.poll());
  }

  /**
   * One tick stage. A thrown stage is recorded and never rejects the ticker:
   * the interval keeps running and the next tick retries.
   */
  private async guarded(stage: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.recordFailure(stage, error);
    }
  }

  private recordFailure(stage: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.state.lastError = `the issues worker could not ${stage}: ${detail}`;
    this.log(this.state.lastError);
    this.publish();
  }

  /** Persists the ledger; an I/O failure is recorded, never thrown. */
  private persistLedger(): string | null {
    try {
      writeLedger(this.stateDir, this.repoDir, this.ledger);
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`could not write the ledger: ${detail}`);
      return `could not write the ledger: ${detail}`;
    }
  }

  private async consumeCommands(): Promise<void> {
    const commands = takeCommands(controlDirectory(this.stateDir, this.repoDir));
    for (const command of commands) {
      if (this.stopping) return;
      await this.apply(command);
    }
  }

  private findActive(runId: string): ActiveRun | undefined {
    for (const run of this.active.values()) {
      if (run.runId === runId) return run;
    }
    return undefined;
  }

  private async apply(command: IssuesCommand): Promise<void> {
    switch (command.type) {
      case "pause": {
        this.state.paused = true;
        this.state.notice = null;
        this.state.lifecycle = this.running ? "pausing" : "paused";
        this.publish();
        return;
      }
      case "resume": {
        this.state.paused = false;
        this.state.notice = null;
        this.state.lifecycle = this.settledLifecycle();
        this.nextPollDue = this.clock().getTime();
        this.publish();
        return;
      }
      case "check": {
        if (this.state.paused) {
          this.state.notice = "Check now is unavailable while paused.";
          this.publish();
          return;
        }
        if (!this.state.enabled) {
          this.state.notice = "Start the issues worker before checking now.";
          this.publish();
          return;
        }
        this.state.cooldowns = {};
        this.state.notice = null;
        if (this.state.lifecycle === "failed") this.state.lifecycle = "idle";
        this.nextPollDue = this.clock().getTime();
        this.publish();
        return;
      }
      case "answer": {
        const runId = command.runId;
        if (typeof runId !== "string" || runId.length === 0) {
          this.state.notice = "An answer needs its run id.";
          this.publish();
          return;
        }
        const run = this.findActive(runId);
        const question = run === undefined ? null : this.questionFor(run);
        if (run === undefined || question === null || String(question.id) !== String(command.id)) {
          this.state.notice = "That question is no longer waiting for an answer.";
          this.publish();
          return;
        }
        const answered = run.peer.answer(command.id, command.value);
        if (!answered) {
          this.state.notice = "That question is no longer waiting for an answer.";
          this.publish();
          return;
        }
        this.state.agents = this.state.agents.map((agent) =>
          agent.runId === run.runId ? { ...agent, question: null } : agent,
        );
        this.state.notice = null;
        this.publish();
        return;
      }
      case "abandon": {
        // The run may have ended between the dashboard's read and this command;
        // that is not an error, so a missing run is ignored.
        const active = this.active.get(command.number);
        if (active === undefined) return;
        this.abandonRun(
          active,
          `Issue #${command.number} was closed on the tracker; its run was stopped.`,
        );
        return;
      }
      case "stop": {
        await this.stop();
        return;
      }
    }
  }

  private questionFor(run: ActiveRun): IssuesQuestion | null {
    return this.state.agents.find((agent) => agent.runId === run.runId)?.question ?? null;
  }

  private cooldownRemaining(number: number): boolean {
    const until = this.state.cooldowns[String(number)];
    if (until === undefined) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && this.clock().getTime() < at;
  }

  private anyCooldownRemaining(): boolean {
    return Object.values(this.state.cooldowns).some((until) => {
      const at = Date.parse(until);
      return Number.isFinite(at) && this.clock().getTime() < at;
    });
  }

  private settledLifecycle(): IssuesState["lifecycle"] {
    if (this.stopping) return "stopped";
    if (this.state.paused) return this.running ? "pausing" : "paused";
    if (this.running) return "running";
    if (!this.state.enabled) return "stopped";
    const unhandled = this.state.queue.filter(
      (issue) => !issue.handled && !this.dismissed.has(issue.number),
    );
    if (unhandled.length === 0) return "idle";
    return "failed";
  }

  /** One conditional poll, then the trigger decision. */
  async poll(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    const startedAt = this.clock();
    try {
      let result: PollResult;
      try {
        result = await this.readIssues(this.state.poll.etag);
      } catch (error) {
        if (this.stopping) return;
        const detail = error instanceof Error ? error.message : String(error);
        this.state.poll.lastPollAt = startedAt.toISOString();
        this.state.poll.error = detail;
        this.state.poll.nextPollAt = new Date(startedAt.getTime() + this.intervalMs).toISOString();
        this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
        this.state.lastError = detail;
        this.publish();
        return;
      }
      if (this.stopping) return;
      this.state.poll.lastPollAt = startedAt.toISOString();
      switch (result.kind) {
        case "not-modified": {
          this.state.poll.etag = result.etag;
          this.state.poll.notModified = true;
          this.state.poll.error = null;
          this.state.poll.rateLimitedUntil = null;
          this.state.poll.nextPollAt = new Date(startedAt.getTime() + this.intervalMs).toISOString();
          this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
          this.refreshQueue();
          break;
        }
        case "issues": {
          this.state.poll.etag = result.etag;
          this.state.poll.notModified = false;
          this.state.poll.error = null;
          this.state.poll.rateLimitedUntil = null;
          this.state.poll.nextPollAt = new Date(startedAt.getTime() + this.intervalMs).toISOString();
          this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
          this.applyIssues(result.issues);
          break;
        }
        case "rate-limited": {
          this.state.poll.error = result.detail;
          this.state.poll.rateLimitedUntil = result.until;
          this.state.poll.nextPollAt = result.until;
          this.nextPollDue = Date.parse(result.until);
          break;
        }
        case "error":
        case "unsupported": {
          this.state.poll.error = result.detail;
          this.state.poll.nextPollAt = new Date(startedAt.getTime() + this.intervalMs).toISOString();
          this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
          this.state.lastError = result.detail;
          break;
        }
      }
      this.publish();
      await this.maybeTrigger();
    } finally {
      this.polling = false;
    }
  }

  /**
   * One tracker read bounded by `pollTimeoutMs`. A reader that never settles
   * loses the race, so `poll` can release the flag and retry on a later tick.
   */
  private async readIssues(etag: string | null): Promise<PollResult> {
    const read = Promise.resolve(this.listIssues({ etag }));
    void read.catch(() => undefined);
    const expired = Promise.withResolvers<never>();
    void expired.promise.catch(() => undefined);
    const timer = setTimeout(
      () => expired.reject(new TrackerTimeoutError(this.pollTimeoutMs)),
      this.pollTimeoutMs,
    );
    try {
      return await Promise.race([read, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private applyIssues(issues: IssuesIssue[]): void {
    const open = new Set(issues.map((issue) => issue.number));
    // A dismissal lasts until this worker's own read drops the issue or its
    // window passes; a later reopen is then eligible again.
    const now = this.clock().getTime();
    for (const [number, until] of [...this.dismissed]) {
      if (!open.has(number) || until <= now) this.dismissed.delete(number);
    }
    const pruned = pruneLedger(this.ledger, open);
    if (pruned !== this.ledger) {
      this.ledger = pruned;
      const ledgerError = this.persistLedger();
      if (ledgerError !== null) this.state.lastError = ledgerError;
    }
    const cooldowns = Object.fromEntries(
      Object.entries(this.state.cooldowns).filter(([key]) => open.has(Number(key))),
    );
    if (Object.keys(cooldowns).length !== Object.keys(this.state.cooldowns).length) {
      this.state.cooldowns = cooldowns;
    }
    this.state.queue = issues.map((issue) => this.queued(issue));
    this.clearResolvedError(open);
    this.stopClosedRuns(open);
  }

  /** The issue a verification error names, when the worker wrote the message. */
  private errorIssue(message: string): number | null {
    const match =
      /^the agent finished but issue #(\d+) is still open(?:;|$)/.exec(message) ??
      /^could not verify issue #(\d+):/.exec(message);
    if (match === null) return null;
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  /**
   * A verification error names its issue. A later poll that drops that issue
   * proves the line false, so it must not stay the worker's current error: the
   * Overview would keep claiming an issue is open after it closed.
   */
  private clearResolvedError(open: Set<number>): void {
    const message = this.state.lastError;
    if (message === null) return;
    const number = this.errorIssue(message);
    if (number === null || open.has(number)) return;
    this.state.lastError = null;
  }

  private queued(issue: IssuesIssue): QueuedIssue {
    const handled = this.ledger.handled[String(issue.number)];
    return {
      ...issue,
      handled: handled !== undefined,
      runId: handled?.runId ?? null,
      agentRunId: this.active.get(issue.number)?.runId ?? null,
    };
  }

  private refreshQueue(): void {
    this.state.queue = this.state.queue.map((issue) => this.queued(issue));
  }

  private async maybeTrigger(): Promise<void> {
    if (this.stopping || this.state.paused || !this.state.enabled) return;
    for (const issue of this.state.queue) {
      if (this.active.size >= MAX_CONCURRENT_PEERS) break;
      if (issue.handled) continue;
      const until = this.dismissed.get(issue.number);
      if (until !== undefined && until > this.clock().getTime()) continue;
      if (this.active.has(issue.number)) continue;
      if (this.cooldownRemaining(issue.number)) continue;
      await this.begin(issue);
      // A pause or stop consumed while `begin` was awaiting must end the pass
      // without closing the run it just started; the next issue stays queued.
      if (this.stopping || this.state.paused || !this.state.enabled) break;
    }
    this.state.lifecycle = this.settledLifecycle();
    this.publish();
  }

  private acpChild(active: ActiveRun): IssuesAcpChild | null {
    const observed = observedChild(active.peer.pid, this.repoDir);
    if (observed !== null) return observed;
    if (active.peer.pid === undefined || active.peer.pid <= 0) return null;
    return { pid: active.peer.pid, argv: [...active.peer.argv], cwd: this.repoDir };
  }

  private async openRun(
    issue: IssuesIssue,
  ): Promise<{ active: ActiveRun } | { runId: string; directory: string; error: string }> {
    const now = this.clock();
    const base = runsDirectory(this.stateDir, this.repoDir);
    mkdirSync(base, { recursive: true });
    const created = uniqueRunDirectory(base, runIdentifier(now));
    const activity: string[] = [];
    writeActivity(created.directory, activity);
    const run: RunFile = {
      version: 1,
      runId: created.runId,
      repo: this.state.repo,
      status: "running",
      argv: this.agentCommand.trim().split(/\s+/).filter(Boolean),
      cwd: this.repoDir,
      startedAt: now.toISOString(),
      finishedAt: null,
      exitCode: null,
      issues: [issue],
      firstStderrLine: null,
      workerPid: process.pid,
      harnessVersion: this.harnessVersion,
    };
    writeRunFile(created.directory, run);
    this.runs.unshift({ run, directory: created.directory });
    this.pruneHistory();

    const firstLine = new FirstLine();
    const active: ActiveRun = {
      runId: created.runId,
      directory: created.directory,
      startedAt: run.startedAt,
      issue,
      captured: [issue],
      activity,
      peer: undefined as unknown as AcpPeer,
      firstLine,
      turns: 1,
      settling: false,
      finished: false,
    };
    let peer: AcpPeer;
    try {
      const environment = await this.providerEnvironment();
      peer = this.connect({
        command: this.agentCommand,
        cwd: this.repoDir,
        // The run's own MCP close names this run, so a poll that drops the
        // issue can tell the run's completion from an operator's cancellation.
        env: {
          ...environment,
          DEVBOARD_ISSUES_RUN_ID: active.runId,
          DEVBOARD_ISSUES_ISSUE_NUMBER: String(issue.number),
        },
        onActivity: (entry) => this.recordActivity(active, entry),
        onQuestion: (question) => this.recordQuestion(active, question),
        onStderr: (text) => firstLine.push(text),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { runId: created.runId, directory: created.directory, error: detail };
    }
    active.peer = peer;
    return { active };
  }

  /** Starts one peer for one issue and records its run and agent entry. */
  private async begin(issue: IssuesIssue): Promise<void> {
    const opened = await this.openRun(issue);
    if ("error" in opened) {
      this.failWithoutPeer(issue, opened.runId, opened.directory, opened.error);
      return;
    }
    if (this.stopping) {
      this.closePeer(opened.active);
      return;
    }
    const active = opened.active;
    this.active.set(issue.number, active);
    const agent: IssuesAgent = {
      runId: active.runId,
      issueNumber: issue.number,
      startedAt: active.startedAt,
      question: null,
      acp: this.acpChild(active),
    };
    this.state.agents = [...this.state.agents, agent];
    this.refreshQueue();
    this.state.lifecycle = "running";
    this.state.runs = this.summaries();
    this.publish();

    void active.peer
      .run(promptFor(issue))
      .then(() => this.finishTurn(active))
      .catch((error: unknown) => {
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "the agent ended its turn with an error";
        this.finishFailed(active, detail);
      });
  }

  private recordActivity(active: ActiveRun, entry: AcpActivity): void {
    if (active.finished) return;
    appendActivityLine(active.activity, entry.text, entry.append);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // A write failure must not end the run; the next update retries.
    }
    const summary = this.state.runs.find((candidate) => candidate.runId === active.runId);
    if (summary !== undefined) summary.activity = active.activity.length;
    this.publish();
  }

  private recordQuestion(active: ActiveRun, question: AcpQuestion): void {
    if (active.finished) return;
    const stored: IssuesQuestion = {
      id: question.id,
      message: question.message,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        recommended: option.recommended,
      })),
    };
    this.state.agents = this.state.agents.map((agent) =>
      agent.runId === active.runId ? { ...agent, question: stored } : agent,
    );
    this.publish();
  }

  private updateRun(
    runId: string,
    directory: string,
    status: IssuesRunStatus,
    finishedAt: string,
    exitCode: number | null,
    firstStderrLine: string | null,
  ): void {
    const entry = this.runs.find((candidate) => candidate.run.runId === runId);
    if (entry === undefined) return;
    const run: RunFile = {
      ...entry.run,
      status,
      finishedAt,
      exitCode,
      firstStderrLine,
      issues: entry.run.issues,
    };
    entry.run = run;
    try {
      writeRunFile(directory, run);
    } catch {
      // In-memory history still reflects the outcome.
    }
  }

  private forget(active: ActiveRun): void {
    this.active.delete(active.issue.number);
    this.state.agents = this.state.agents.filter((agent) => agent.runId !== active.runId);
    clearClosedByRun(this.stateDir, this.repoDir, active.issue.number, active.runId);
  }

  private settle(exitCode: number | null, error: string | null, finishedAt: string): void {
    this.state.runs = this.summaries();
    this.state.lastExitCode = exitCode;
    if (error !== null) this.state.lastError = error;
    this.state.finishedAt = finishedAt;
    const lifecycle = this.settledLifecycle();
    this.state.lifecycle = lifecycle;
    if (lifecycle === "idle") {
      this.state.lastError = null;
      this.state.lastExitCode = null;
      this.state.finishedAt = null;
    }
    this.publish();
    if (!this.stopping && this.state.enabled && !this.state.paused) {
      this.nextPollDue = Math.min(this.nextPollDue, this.clock().getTime());
    }
  }

  private failWithoutPeer(
    issue: IssuesIssue,
    runId: string,
    directory: string,
    detail: string,
  ): void {
    const finishedAt = this.clock().toISOString();
    this.updateRun(runId, directory, "failed", finishedAt, 1, detail);
    this.state.cooldowns[String(issue.number)] = new Date(
      this.clock().getTime() + COOLDOWN_MS,
    ).toISOString();
    this.settle(1, detail, finishedAt);
  }

  /**
   * One turn ended. The peer stays open until the issue state is verified, so
   * an open issue can earn a follow-up turn instead of a failed run.
   */
  private finishTurn(active: ActiveRun): void {
    if (active.finished || active.settling || this.stopping) return;
    active.settling = true;
    void this.verifyAndSettle(active);
  }

  /**
   * A clean ACP turn is not proof of work: a refused slash command still ends
   * the turn normally, and an agent that yields to a long background job ends
   * its turn before the issue is closed. Only an issue the tracker now reports
   * closed is handled; an open one gets a bounded follow-up turn, then fails
   * and cools down, so it can be retried.
   */
  private async verifyAndSettle(active: ActiveRun): Promise<void> {
    let result: IssueStateResult;
    try {
      result = await this.issueState(active.issue.number);
    } catch (error) {
      result = {
        kind: "error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.stopping) return;
    if (result.kind === "state" && result.state === "closed") {
      this.closePeer(active);
      this.recordSucceeded(active);
      return;
    }
    if (result.kind === "state" && active.turns <= MAX_FOLLOW_UP_TURNS) {
      this.continueRun(active);
      return;
    }
    active.firstLine.finish();
    const detail =
      result.kind === "error"
        ? `could not verify issue #${active.issue.number}: ${result.detail}`
        : `the agent finished but issue #${active.issue.number} is still open`;
    this.closePeer(active);
    this.recordFailed(
      active,
      active.firstLine.value === null ? detail : `${detail}; agent stderr: ${active.firstLine.value}`,
    );
  }

  /** Sends the follow-up turn that lets a peer finish work it yielded to. */
  private continueRun(active: ActiveRun): void {
    if (active.finished || this.stopping) return;
    active.turns += 1;
    active.settling = false;
    this.log(
      `issue #${active.issue.number} is still open after turn ${active.turns - 1}; asking the peer to continue`,
    );
    void active.peer
      .prompt(continuationPrompt(active.issue, active.turns, MAX_FOLLOW_UP_TURNS + 1))
      .then(() => this.finishTurn(active))
      .catch((error: unknown) => {
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "the agent ended its follow-up turn with an error";
        this.finishFailed(active, detail);
      });
  }

  private recordSucceeded(active: ActiveRun): void {
    if (active.finished || this.stopping) return;
    active.finished = true;
    const finishedAt = this.clock().toISOString();
    this.updateRun(active.runId, active.directory, "succeeded", finishedAt, 0, null);
    this.ledger = recordHandled(this.ledger, active.captured, active.runId, this.clock());
    // Settle before persisting: a ledger I/O error must never strand the run.
    this.forget(active);
    this.refreshQueue();
    this.settle(0, null, finishedAt);
    const ledgerError = this.persistLedger();
    if (ledgerError !== null) {
      this.state.lastError = ledgerError;
      this.publish();
    }
  }

  private recordFailed(active: ActiveRun, detail: string): void {
    if (active.finished || this.stopping) return;
    active.finished = true;
    const finishedAt = this.clock().toISOString();
    this.updateRun(active.runId, active.directory, "failed", finishedAt, 1, detail);
    this.state.cooldowns[String(active.issue.number)] = new Date(
      this.clock().getTime() + COOLDOWN_MS,
    ).toISOString();
    this.forget(active);
    this.refreshQueue();
    this.settle(1, detail, finishedAt);
  }

  private finishFailed(active: ActiveRun, detail: string): void {
    if (active.finished || active.settling || this.stopping) return;
    active.settling = true;
    this.closePeer(active);
    active.firstLine.finish();
    this.recordFailed(active, active.firstLine.value ?? detail);
  }

  /**
   * A poll that no longer lists a running issue stops that run, unless the run
   * closed the issue itself: its recorded close lets its own turn end settle it
   * as succeeded. A stopped run is recorded `stopped`; the issue stays
   * unhandled and gets no cooldown, so a reopened issue is eligible on a later
   * poll.
   */
  private stopClosedRuns(open: Set<number>): void {
    for (const active of [...this.active.values()]) {
      if (open.has(active.issue.number)) continue;
      this.abandonRun(
        active,
        `Issue #${active.issue.number} was closed on the tracker; its run was stopped.`,
      );
    }
  }

  /** Ends one run without a verdict: no succeeded ledger entry, no cooldown. */
  private abandonRun(active: ActiveRun, notice: string): void {
    if (active.finished) return;
    // A closed issue is not a cancellation when this run closed it: its turn
    // end verifies the closure and settles it as succeeded. A settling run has
    // already stopped working and owns that verification.
    if (active.settling) return;
    if (closedByRun(this.stateDir, this.repoDir, active.issue.number) === active.runId) return;
    this.dismissed.set(active.issue.number, this.clock().getTime() + DISMISS_MS);
    const finishedAt = this.clock().toISOString();
    active.finished = true;
    this.closePeer(active);
    this.updateRun(active.runId, active.directory, "stopped", finishedAt, null, null);
    this.forget(active);
    this.refreshQueue();
    this.state.notice = notice;
    this.settle(null, null, finishedAt);
  }

  private closePeer(active: ActiveRun): void {
    try {
      active.peer.close();
    } catch {
      // The peer already exited.
    }
  }

  /** Keeps every running run and the newest 50 finished ones. */
  private pruneHistory(): void {
    const base = runsDirectory(this.stateDir, this.repoDir);
    const kept = new Set<string>();
    let finished = 0;
    for (const entry of this.runs) {
      if (entry.run.status === "running") {
        kept.add(entry.directory);
        continue;
      }
      if (finished < RUN_HISTORY_LIMIT) {
        kept.add(entry.directory);
        finished += 1;
      }
    }
    for (const entry of this.runs) {
      if (kept.has(entry.directory)) continue;
      try {
        rmSync(entry.directory, { recursive: true, force: true });
      } catch {
        // A stale directory is left for the watchdog.
      }
    }
    this.runs = this.runs.filter((entry) => kept.has(entry.directory));
    void base;
  }

  /** Stop: end every peer, record `stopped`, leave captured issues unhandled. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.state.enabled = false;
    this.state.paused = false;
    this.state.cooldowns = {};
    for (const active of this.active.values()) {
      if (active.finished) continue;
      active.finished = true;
      this.closePeer(active);
      this.updateRun(active.runId, active.directory, "stopped", this.clock().toISOString(), null, null);
    }
    this.active.clear();
    this.state.agents = [];
    for (const issue of this.state.queue) issue.agentRunId = null;
    this.state.runs = this.summaries();
    this.state.lastExitCode = null;
    this.state.lastError = null;
    this.state.lifecycle = "stopped";
    this.state.notice = null;
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
): { repoDir: string; stateDir: string; intervalMs?: number } | undefined {
  let repoDir: string | undefined;
  let stateDir: string | undefined;
  let intervalMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "--state-dir" || argument === "--interval") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) return undefined;
      if (argument === "--repo") repoDir = value;
      else if (argument === "--state-dir") stateDir = value;
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) intervalMs = parsed;
      }
    }
  }
  if (repoDir === undefined || stateDir === undefined) return undefined;
  return { repoDir, stateDir, ...(intervalMs === undefined ? {} : { intervalMs }) };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    console.error("usage: worker.ts --repo <checkout> --state-dir <dir> [--interval <ms>]");
    process.exit(2);
  }
  const repoDir = resolve(parsed.repoDir);
  const stateDir = resolve(parsed.stateDir);
  const repository = originRepository(repoDir) ?? "";
  if (repository.length === 0) {
    console.error("issues worker: the checkout's origin does not name a repository");
    process.exit(2);
  }
  if (liveLockOwner(lockPath(repoDir)) !== undefined) {
    console.error("issues worker: this checkout already has a live worker");
    process.exit(0);
  }

  const worker = new IssuesWorker({
    repoDir,
    stateDir,
    ...(parsed.intervalMs === undefined ? {} : { intervalMs: parsed.intervalMs }),
    log: (line) => console.error(`issues: ${line}`),
    onStopped: () => process.exit(0),
  });
  if (!worker.start(repository)) {
    process.exit(0);
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`issues: received ${signal}`);
    void worker.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  await main();
}

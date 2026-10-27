import { mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../server/acp";
import { recordedChildAlive } from "../server/state";
import { takeCommands, type IssuesCommand } from "./control";
import {
  emptyLedger,
  handledNumbers,
  loadLedger,
  pruneLedger,
  recordHandled,
  writeLedger,
  type Ledger,
} from "./ledger";
import { migrateLegacyLedger } from "./legacy";
import { acquireLock, liveLockOwner } from "./lock";
import { originRepository } from "./repository";
import { controlDirectory, lockPath, runsDirectory, statePath } from "./paths";
import { pollOpenIssues } from "./tracker";
import {
  appendActivityLine,
  emptyState,
  listRunDirectories,
  loadState,
  parseRunFile,
  readActivity,
  runFilePath,
  runSummary,
  writeActivity,
  writeRunFile,
  writeState,
  type IssuesIssue,
  type IssuesLifecycle,
  type IssuesQuestion,
  type IssuesRunStatus,
  type IssuesRunSummary,
  type IssuesState,
  type RunFile,
} from "./state";

/**
 * The detached worker for exactly one repository. It owns the poll loop, the
 * ACP peer, the ledger, the repository lock, and the activity, so it outlives
 * any dashboard process. A dashboard may start it, read its state, and send
 * it commands; nothing else can create a second worker for the checkout.
 */

const DEFAULT_INTERVAL_MS = 2000;
const COOLDOWN_MS = 5 * 60_000;
const TICK_MS = 100;
const IMPLEMENT_ALL_PROMPT = "/implement-all-issues";
const DEFAULT_AGENT_COMMAND = "omp acp";
const FIRST_LINE_MAX = 400;

export interface WorkerOptions {
  repoDir: string;
  stateDir: string;
  agentCommand?: string;
  environment?: Record<string, string | undefined>;
  intervalMs?: number;
  now?: () => Date;
  /** Injected for tests; defaults to the conditional `gh` tracker. */
  listIssues?: (options: { etag: string | null }) => Promise<
    | { kind: "issues"; issues: IssuesIssue[]; etag: string | null }
    | { kind: "not-modified"; etag: string | null }
    | { kind: "rate-limited"; until: string; detail: string }
    | { kind: "error"; detail: string }
  >;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: IssuesPeerOptions) => AcpPeer;
  harnessVersion?: string | null;
  log?: (line: string) => void;
  /** Runs after Stop has written its state and released the lock. */
  onStopped?: () => void;
}

export interface AcpPeer {
  readonly pid: number | undefined;
  readonly argv: string[];
  run(prompt: string): Promise<unknown>;
  answer(id: number | string, value: string): boolean;
  close(): void;
}

export interface IssuesPeerOptions {
  command: string;
  cwd: string;
  onActivity: (activity: AcpActivity) => void;
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
  captured: IssuesIssue[];
  activity: string[];
  peer: AcpPeer;
  firstLine: FirstLine;
  finished: boolean;
}

function readHarnessVersion(harnessDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(harnessDir, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The child as the process table sees it, for a later proven termination. */
function observedChild(pid: number | undefined, cwd: string): { pid: number; argv: string[]; cwd: string } | null {
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

/** Loads the newest run records, newest first, at most `RUN_HISTORY_LIMIT`. */
export function loadRuns(
  stateDir: string,
  repoDir: string,
  limit = 50,
): Array<{ run: RunFile; directory: string; activity: number }> {
  const found: Array<{ run: RunFile; directory: string; activity: number }> = [];
  for (const name of listRunDirectories(stateDir, repoDir)) {
    const directory = join(runsDirectory(stateDir, repoDir), name);
    try {
      const run = parseRunFile(readFileSync(runFilePath(directory), "utf8"));
      if (run === undefined) continue;
      found.push({ run, directory, activity: readActivity(directory).length });
    } catch {
      // A run file that vanished mid-scan is already gone.
    }
    if (found.length >= limit) break;
  }
  return found;
}


export class IssuesWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly intervalMs: number;
  private readonly agentCommand: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly listIssues: NonNullable<WorkerOptions["listIssues"]>;
  private readonly connect: NonNullable<WorkerOptions["connect"]>;
  private readonly harnessVersion: string | null;
  private readonly log: (line: string) => void;

  private state: IssuesState;
  private ledger: Ledger;
  private active: ActiveRun | undefined;
  private runs: Array<{ run: RunFile; directory: string }> = [];
  private followUp = false;
  private finishing = false;
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
      options.agentCommand ?? options.environment?.AGENT_COMMAND ?? process.env.AGENT_COMMAND ?? DEFAULT_AGENT_COMMAND;
    this.environment = options.environment ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.listIssues =
      options.listIssues ??
      ((request) =>
        pollOpenIssues({
          repository: this.state.repo,
          etag: request.etag,
          environment: this.environment,
        }));
    this.connect =
      options.connect ??
      ((peerOptions) => new AcpConnection(peerOptions) as unknown as AcpPeer);
    this.harnessVersion =
      options.harnessVersion ??
      readHarnessVersion(resolve(import.meta.dir, ".."));
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
    return this.active !== undefined;
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

    const previous = loadState(statePath(this.stateDir, this.repoDir));
    this.ledger = loadLedger(this.stateDir, this.repoDir);
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
      writeLedger(this.stateDir, this.repoDir, this.ledger);
      this.log(`migrated ${migrated.length} handled issue(s) from the legacy orchestrator`);
    }

    this.runs = loadRuns(this.stateDir, this.repoDir).map((entry) => ({
      run: entry.run,
      directory: entry.directory,
    }));
    // A worker that died mid-run leaves a recorded child and a `running`
    // record. Only a process the table proves is that child is signalled.
    const orphan = previous?.acp ?? null;
    if (orphan !== null && recordedChildAlive(orphan)) {
      try {
        process.kill(orphan.pid, "SIGKILL");
        this.log(`terminated orphaned ACP child ${orphan.pid}`);
      } catch {
        // It exited between the proof and the signal.
      }
    }
    if (previous?.activeRun != null) {
      this.closeInterruptedRun(previous.activeRun.runId);
    }

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
    await this.consumeCommands();
    if (this.stopping) return;
    if (!this.state.enabled || this.state.paused) return;
    if (this.polling) return;
    if (this.clock().getTime() < this.nextPollDue) return;
    await this.poll();
  }

  private async consumeCommands(): Promise<void> {
    const commands = takeCommands(controlDirectory(this.stateDir, this.repoDir));
    for (const command of commands) {
      if (this.stopping) return;
      await this.apply(command);
    }
  }

  private async apply(command: IssuesCommand): Promise<void> {
    switch (command.type) {
      case "pause": {
        this.state.paused = true;
        this.state.notice = null;
        this.state.lifecycle = this.active === undefined ? "paused" : "pausing";
        this.publish();
        return;
      }
      case "resume": {
        this.state.paused = false;
        this.state.notice = null;
        this.state.lifecycle =
          this.active !== undefined ? "running" : this.cooldownRemaining() ? "failed" : "idle";
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
        this.state.nextAttemptAt = null;
        this.state.notice = null;
        if (this.state.lifecycle === "failed") this.state.lifecycle = "idle";
        this.nextPollDue = this.clock().getTime();
        this.publish();
        return;
      }
      case "answer": {
        const question = this.state.question;
        if (question === null || String(question.id) !== String(command.id) || this.active === undefined) {
          this.state.notice = "That question is no longer waiting for an answer.";
          this.publish();
          return;
        }
        const answered = this.active.peer.answer(command.id, command.value);
        if (!answered) {
          this.state.notice = "That question is no longer waiting for an answer.";
          this.publish();
          return;
        }
        this.state.question = null;
        this.state.notice = null;
        this.publish();
        return;
      }
      case "stop": {
        await this.stop();
        return;
      }
    }
  }

  private cooldownRemaining(): boolean {
    const until = this.state.nextAttemptAt;
    if (until === null) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && this.clock().getTime() < at;
  }

  /** One conditional poll, then the trigger decision. */
  async poll(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    const startedAt = this.clock();
    try {
      const result = await this.listIssues({ etag: this.state.poll.etag });
      if (this.stopping) return;
      this.state.poll.lastPollAt = startedAt.toISOString();
      switch (result.kind) {
        case "not-modified": {
          this.state.poll.etag = result.etag;
          this.state.poll.notModified = true;
          this.state.poll.error = null;
          this.state.poll.rateLimitedUntil = null;
          this.state.poll.nextPollAt = new Date(
            startedAt.getTime() + this.intervalMs,
          ).toISOString();
          this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
          this.refreshQueue();
          break;
        }
        case "issues": {
          this.state.poll.etag = result.etag;
          this.state.poll.notModified = false;
          this.state.poll.error = null;
          this.state.poll.rateLimitedUntil = null;
          this.state.poll.nextPollAt = new Date(
            startedAt.getTime() + this.intervalMs,
          ).toISOString();
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
        case "error": {
          this.state.poll.error = result.detail;
          this.state.poll.nextPollAt = new Date(
            startedAt.getTime() + this.intervalMs,
          ).toISOString();
          this.nextPollDue = Date.parse(this.state.poll.nextPollAt);
          this.state.lastError = result.detail;
          break;
        }
      }
      this.publish();
      this.maybeTrigger();
    } finally {
      this.polling = false;
    }
  }

  private applyIssues(issues: IssuesIssue[]): void {
    const open = new Set(issues.map((issue) => issue.number));
    const pruned = pruneLedger(this.ledger, open);
    if (pruned !== this.ledger) {
      this.ledger = pruned;
      writeLedger(this.stateDir, this.repoDir, this.ledger);
    }
    this.state.queue = issues.map((issue) => {
      const handled = this.ledger.handled[String(issue.number)];
      return {
        ...issue,
        handled: handled !== undefined,
        runId: handled?.runId ?? null,
      };
    });
    if (this.active !== undefined) {
      const captured = new Set(this.active.captured.map((issue) => issue.number));
      const novel = this.state.queue.filter(
        (issue) => !issue.handled && !captured.has(issue.number),
      );
      if (novel.length > 0) this.followUp = true;
    }
  }

  private refreshQueue(): void {
    this.state.queue = this.state.queue.map((issue) => {
      const handled = this.ledger.handled[String(issue.number)];
      return {
        ...issue,
        handled: handled !== undefined,
        runId: handled?.runId ?? null,
      };
    });
  }

  private maybeTrigger(): void {
    if (this.stopping || this.state.paused || !this.state.enabled) return;
    if (this.active !== undefined || this.finishing) return;
    if (this.cooldownRemaining()) {
      this.state.lifecycle = "failed";
      return;
    }
    const unhandled = this.state.queue.filter((issue) => !issue.handled);
    if (unhandled.length === 0) {
      if (this.state.lifecycle !== "idle") {
        this.state.lifecycle = "idle";
        this.state.lastExitCode = null;
        this.state.lastError = null;
        this.state.nextAttemptAt = null;
        this.publish();
      }
      return;
    }
    this.begin(unhandled);
  }

  private begin(captured: IssuesIssue[]): void {
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
      issues: captured,
      firstStderrLine: null,
      workerPid: process.pid,
      harnessVersion: this.harnessVersion,
    };
    writeRunFile(created.directory, run);
    this.runs.unshift({ run, directory: created.directory });
    this.pruneHistory();

    const firstLine = new FirstLine();
    let peer: AcpPeer;
    try {
      peer = this.connect({
        command: this.agentCommand,
        cwd: this.repoDir,
        onActivity: (entry) => this.recordActivity(entry),
        onQuestion: (question) => this.recordQuestion(question),
        onStderr: (text) => firstLine.push(text),
      });
    } catch (error) {
      this.finishFailed(created.runId, created.directory, 1, error instanceof Error ? error.message : String(error));
      return;
    }

    this.active = {
      runId: created.runId,
      directory: created.directory,
      captured,
      activity,
      peer,
      firstLine,
      finished: false,
    };
    this.followUp = false;
    this.state.activeRun = {
      runId: created.runId,
      startedAt: run.startedAt,
      issueNumbers: captured.map((issue) => issue.number),
    };
    this.state.lifecycle = "running";
    this.state.lastExitCode = null;
    this.state.lastError = null;
    this.state.nextAttemptAt = null;
    this.state.question = null;
    this.state.acp =
      observedChild(peer.pid, this.repoDir) ?? {
        pid: peer.pid ?? 0,
        argv: [...peer.argv],
        cwd: this.repoDir,
      };
    if (this.state.acp.pid === 0) this.state.acp = null;
    this.state.runs = this.summaries();
    this.publish();

    void peer
      .run(IMPLEMENT_ALL_PROMPT)
      .then(() => this.finishSucceeded())
      .catch((error: unknown) => {
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "the agent ended its turn with an error";
        this.finishFailed(this.active?.runId ?? created.runId, created.directory, 1, detail);
      });
  }

  private recordActivity(entry: AcpActivity): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
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

  private recordQuestion(question: AcpQuestion): void {
    if (this.active === undefined) return;
    const stored: IssuesQuestion = {
      id: question.id,
      message: question.message,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        recommended: option.recommended,
      })),
    };
    this.state.question = stored;
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

  private finishSucceeded(): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    active.finished = true;
    this.finishing = true;
    this.closePeer(active);
    const finishedAt = this.clock().toISOString();
    this.updateRun(active.runId, active.directory, "succeeded", finishedAt, 0, null);
    this.ledger = recordHandled(this.ledger, active.captured, active.runId, this.clock());
    writeLedger(this.stateDir, this.repoDir, this.ledger);
    this.refreshQueue();
    this.finishActive(0, null, finishedAt);
  }

  private finishFailed(runId: string, directory: string, exitCode: number, detail: string): void {
    if (this.stopping && this.active === undefined) return;
    this.finishing = true;
    const active = this.active;
    if (active !== undefined && active.runId === runId) {
      active.finished = true;
      this.closePeer(active);
    }
    active?.firstLine.finish();
    const error = active?.firstLine.value ?? detail;
    const finishedAt = this.clock().toISOString();
    this.updateRun(runId, directory, "failed", finishedAt, exitCode, error);
    this.finishActive(exitCode, error, finishedAt);
  }

  private finishActive(exitCode: number | null, error: string | null, finishedAt: string): void {
    const active = this.active;
    const followUp = this.followUp;
    this.followUp = false;
    this.state.activeRun = null;
    this.state.acp = null;
    this.state.question = null;
    this.state.runs = this.summaries();
    this.state.lastExitCode = exitCode;
    this.state.lastError = error;
    this.state.finishedAt = finishedAt;
    if (this.stopping) {
      this.state.lifecycle = "stopped";
    } else if (this.state.paused) {
      this.state.lifecycle = "paused";
    } else if (exitCode === 0) {
      this.state.lifecycle = "idle";
      this.state.nextAttemptAt = null;
    } else {
      this.state.lifecycle = "failed";
      this.state.nextAttemptAt = new Date(this.clock().getTime() + COOLDOWN_MS).toISOString();
    }
    this.active = undefined;
    this.finishing = false;
    this.publish();
    if (followUp && exitCode === 0 && !this.stopping && !this.state.paused) {
      this.nextPollDue = this.clock().getTime();
    }
  }

  private closePeer(active: ActiveRun): void {
    try {
      active.peer.close();
    } catch {
      // The peer already exited.
    }
  }

  private pruneHistory(): void {
    const base = runsDirectory(this.stateDir, this.repoDir);
    for (const name of listRunDirectories(this.stateDir, this.repoDir).slice(50)) {
      try {
        rmSync(join(base, name), { recursive: true, force: true });
      } catch {
        // A stale directory is left for the watchdog.
      }
    }
    this.runs = this.runs.slice(0, 50);
  }

  /** Stop: end the peer, record `stopped`, leave captured issues unhandled. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.state.enabled = false;
    this.state.paused = false;
    this.state.nextAttemptAt = null;
    const active = this.active;
    if (active !== undefined && !active.finished) {
      active.finished = true;
      this.closePeer(active);
      const finishedAt = this.clock().toISOString();
      this.updateRun(active.runId, active.directory, "stopped", finishedAt, null, null);
      this.state.activeRun = null;
      this.state.acp = null;
      this.state.question = null;
      this.state.runs = this.summaries();
      this.state.lastExitCode = null;
      this.state.lastError = null;
      this.active = undefined;
    }
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

function parseArguments(args: string[]): { repoDir: string; stateDir: string; intervalMs?: number } | undefined {
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

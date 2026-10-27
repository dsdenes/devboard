import {
  handledNumbers,
  loadLedger,
  pruneLedger,
  recordHandled,
  writeLedger,
  type Ledger,
} from "./ledger";
import {
  loadState,
  writeState,
  type OrchestratorIssue,
  type OrchestratorState,
  type OrchestratorStatus,
} from "./state";
import { startRun, type RunHandle, type RunResult } from "./runner";

/**
 * The trigger policy. It is deliberately small and clock-free at its core:
 * every decision reads the tracker, the ledger, and the last published state,
 * and every transition writes the state atomically first. No model decides
 * anything here.
 */

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_INTERVAL_MS = 60_000;

export interface RunStarterOptions {
  argv: string[];
  cwd: string;
  stateDir: string;
  now?: Date;
  environment?: Record<string, string | undefined>;
}

export type RunStarter = (options: RunStarterOptions) => RunHandle;

export interface OrchestratorOptions {
  root: string;
  repository: string;
  stateDir: string;
  listIssues: () => Promise<OrchestratorIssue[]>;
  /** Injected for tests; defaults to the real spawner. */
  startRun?: RunStarter;
  argv: string[];
  now?: () => Date;
  cooldownMs?: number;
  intervalMs?: number;
  once?: boolean;
  log?: (line: string) => void;
}

export type TickOutcome = "idle" | "cooldown" | "triggered" | "running" | "error";

export interface PollReport {
  repo: string;
  open: number;
  issues: OrchestratorIssue[];
  action: "none" | "trigger";
}

interface ActiveRun {
  handle: RunHandle;
  captured: Set<number>;
}

/**
 * The `--dry-run` answer: what the poll found and whether it would spawn. It
 * reads the ledger and state without touching either file.
 */
export function dryRunReport(options: {
  repository: string;
  issues: OrchestratorIssue[];
  ledger: Ledger;
  state: OrchestratorState | undefined;
  now: Date;
}): PollReport {
  const handled = handledNumbers(options.ledger);
  const unhandled = options.issues.filter((issue) => !handled.has(issue.number));
  const until = options.state?.nextAttemptAt ?? null;
  const cooling =
    until !== null && Number.isFinite(Date.parse(until)) && options.now.getTime() < Date.parse(until);
  return {
    repo: options.repository,
    open: options.issues.length,
    issues: options.issues,
    action: unhandled.length > 0 && !cooling ? "trigger" : "none",
  };
}

export class IssueOrchestrator {
  private readonly root: string;
  private readonly repository: string;
  private readonly stateDir: string;
  private readonly listIssues: () => Promise<OrchestratorIssue[]>;
  private readonly spawnRun: RunStarter;
  private readonly argv: string[];
  private readonly clock: () => Date;
  private readonly cooldownMs: number;
  private readonly intervalMs: number;
  private readonly once: boolean;
  private readonly log: (line: string) => void;

  private state: OrchestratorState;
  private ledger: Ledger;
  private active: ActiveRun | undefined;
  private capturedIssues: OrchestratorIssue[] = [];
  private exitPromise: Promise<void> | undefined;
  private finishing = false;
  private followUp = false;
  private immediate = false;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(options: OrchestratorOptions) {
    this.root = options.root;
    this.repository = options.repository;
    this.stateDir = options.stateDir;
    this.listIssues = options.listIssues;
    this.spawnRun = options.startRun ?? startRun;
    this.argv = options.argv;
    this.clock = options.now ?? (() => new Date());
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.once = options.once === true;
    this.log = options.log ?? (() => undefined);
    this.ledger = loadLedger(this.stateDir);
    this.state = this.startupState();
  }

  /**
   * The state written at startup. A previous `running` is stale because the
   * lock is held by this process; a previous failure keeps its cooldown so a
   * service restart does not bypass it.
   */
  private startupState(): OrchestratorState {
    const previous = loadState(this.stateDir);
    const now = this.clock();
    const cooling =
      previous?.status === "failed" &&
      previous.nextAttemptAt !== null &&
      Number.isFinite(Date.parse(previous.nextAttemptAt)) &&
      now.getTime() < Date.parse(previous.nextAttemptAt);
    return {
      version: 1,
      root: this.root,
      repo: this.repository,
      status: cooling ? "failed" : "idle",
      startedAt: null,
      finishedAt: previous?.finishedAt ?? null,
      open: 0,
      issues: [],
      lastExitCode: cooling ? (previous?.lastExitCode ?? null) : null,
      lastError: cooling ? (previous?.lastError ?? null) : null,
      nextAttemptAt: cooling ? (previous?.nextAttemptAt ?? null) : null,
      updatedAt: now.toISOString(),
    };
  }

  /** Writes the startup state before the first poll can spawn anything. */
  publishStartup(): void {
    writeState(this.stateDir, this.state);
  }

  get currentState(): OrchestratorState {
    return this.state;
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  private write(update: Partial<OrchestratorState>, status: OrchestratorStatus): void {
    this.state = {
      ...this.state,
      ...update,
      status,
      updatedAt: this.clock().toISOString(),
    };
    writeState(this.stateDir, this.state);
  }

  private cooldownRemaining(now: Date): boolean {
    const until = this.state.nextAttemptAt;
    if (until === null) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && now.getTime() < at;
  }

  /** What the next poll would do, for `--dry-run`. */
  report(issues: OrchestratorIssue[]): PollReport {
    return dryRunReport({
      repository: this.repository,
      issues,
      ledger: this.ledger,
      state: this.state,
      now: this.clock(),
    });
  }

  /** One poll: prune the ledger, notice a queued issue, or start a run. */
  async tick(): Promise<TickOutcome> {
    if (this.stopping) return "idle";
    let issues: OrchestratorIssue[];
    try {
      issues = await this.listIssues();
    } catch (error) {
      this.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return "error";
    }
    if (this.stopping) return "idle";

    const open = new Set(issues.map((issue) => issue.number));
    const pruned = pruneLedger(this.ledger, open);
    if (pruned !== this.ledger) {
      this.ledger = pruned;
      writeLedger(this.stateDir, this.ledger);
    }
    const handled = handledNumbers(this.ledger);

    // While an agent runs, a new issue queues exactly one follow-up run; no
    // second agent is ever spawned concurrently.
    if (this.active !== undefined) {
      const captured = this.active.captured;
      const novel = issues.filter((issue) => !handled.has(issue.number) && !captured.has(issue.number));
      if (novel.length > 0 && !this.followUp) {
        this.followUp = true;
        this.log(`queued a follow-up run for ${novel.length} new issue(s)`);
      }
      return "running";
    }
    if (this.finishing) return "running";

    if (this.cooldownRemaining(this.clock())) return "cooldown";

    const unhandled = issues.filter((issue) => !handled.has(issue.number));
    if (unhandled.length === 0) {
      if (this.state.status !== "idle" || this.state.open !== 0 || this.state.issues.length > 0) {
        this.write(
          {
            startedAt: null,
            open: 0,
            issues: [],
            lastExitCode: null,
            lastError: null,
            nextAttemptAt: null,
          },
          "idle",
        );
      }
      return "idle";
    }

    this.begin(unhandled);
    return "triggered";
  }

  private begin(captured: OrchestratorIssue[]): void {
    const now = this.clock();
    this.capturedIssues = captured;
    this.followUp = false;
    let handle: RunHandle;
    try {
      handle = this.spawnRun({
        argv: this.argv,
        cwd: this.root,
        stateDir: this.stateDir,
        now,
      });
    } catch (error) {
      this.recordFailure(captured, 1, error instanceof Error ? error.message : String(error));
      return;
    }
    this.active = { handle, captured: new Set(captured.map((issue) => issue.number)) };
    this.write(
      {
        startedAt: handle.startedAt,
        finishedAt: null,
        open: captured.length,
        issues: captured,
        lastExitCode: null,
        lastError: null,
        nextAttemptAt: null,
      },
      "running",
    );
    this.log(
      `run ${handle.runId} started with ${captured.length} issue(s): ` +
        captured.map((issue) => `#${issue.number}`).join(" "),
    );
    this.exitPromise = handle.exited
      .then((result) => this.finish(result))
      .catch((error: unknown) => {
        this.log(`run failed to report: ${error instanceof Error ? error.message : String(error)}`);
        this.finishing = false;
        this.active = undefined;
        this.exitPromise = undefined;
      });
  }

  private recordFailure(captured: OrchestratorIssue[], exitCode: number, error: string | null): void {
    const now = this.clock();
    const nextAttemptAt = new Date(now.getTime() + this.cooldownMs).toISOString();
    this.write(
      {
        startedAt: null,
        finishedAt: now.toISOString(),
        open: captured.length,
        issues: captured,
        lastExitCode: exitCode,
        lastError: error,
        nextAttemptAt,
      },
      "failed",
    );
    this.log(`run failed with code ${exitCode}${error === null ? "" : `: ${error}`}`);
    this.log(`next attempt after ${nextAttemptAt}`);
  }

  private async finish(result: RunResult): Promise<void> {
    this.finishing = true;
    const followUp = this.followUp;
    this.followUp = false;
    try {
      if (this.stopping) return;
      const captured = this.capturedIssues;
      if (result.exitCode !== 0) {
        this.recordFailure(
          captured,
          result.exitCode,
          result.firstStderrLine ?? `agent exited with code ${result.exitCode}`,
        );
        return;
      }
      this.ledger = recordHandled(this.ledger, captured, result.runId, this.clock());
      writeLedger(this.stateDir, this.ledger);
      this.write(
        {
          startedAt: null,
          finishedAt: result.finishedAt,
          open: 0,
          issues: [],
          lastExitCode: 0,
          lastError: null,
          nextAttemptAt: null,
        },
        "idle",
      );
      this.log(`run ${result.runId} handled ${captured.length} issue(s)`);
      if (followUp) this.requestImmediate();
    } finally {
      this.finishing = false;
      this.active = undefined;
      this.capturedIssues = [];
      this.exitPromise = undefined;
      this.wakeNow();
    }
  }

  private requestImmediate(): void {
    this.immediate = true;
    this.wakeNow();
  }

  private wakeNow(): void {
    this.wake?.();
  }

  private async pause(ms: number): Promise<void> {
    if (this.stopping) return;
    if (this.immediate) {
      this.immediate = false;
      return;
    }
    const gate = Promise.withResolvers<void>();
    const timer = setTimeout(gate.resolve, ms);
    this.wake = gate.resolve;
    await gate.promise;
    clearTimeout(timer);
    this.wake = undefined;
    this.immediate = false;
  }

  /** Waits for the active run, then for any follow-up run it earned. */
  async drain(): Promise<void> {
    while (!this.stopping) {
      const pending = this.exitPromise;
      if (pending !== undefined) {
        await pending;
        continue;
      }
      if (!this.immediate) return;
      this.immediate = false;
      await this.tick();
    }
  }

  /** One cycle: poll, then wait for the run and any immediate follow-up. */
  async cycle(): Promise<TickOutcome> {
    const outcome = await this.tick();
    await this.drain();
    return outcome;
  }

  /** The service loop. `--once` still runs one follow-up when one is owed. */
  async run(): Promise<void> {
    this.publishStartup();
    if (this.once) {
      await this.cycle();
      return;
    }
    while (!this.stopping) {
      await this.tick();
      await this.pause(this.intervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const pending = this.exitPromise;
    this.active?.handle.kill();
    this.wakeNow();
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        // The run's own failure is already recorded.
      }
    }
    if (this.state.status === "running") {
      this.write(
        { startedAt: null, open: 0, issues: [], lastExitCode: null, lastError: null },
        "idle",
      );
    }
  }
}

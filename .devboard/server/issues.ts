import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeCommand, type IssuesCommand } from "../issues/control";
import { liveLockOwner, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  lockPath,
  runDirectory,
  statePath,
} from "../issues/paths";
import {
  ISSUES_PREFLIGHT_TIMEOUT_MS,
  preflightIssues,
  type PreflightResult,
} from "../issues/preflight";
import { DEADLINE_EXPIRED, withinDeadline } from "../lib/deadline";
import { cachedRepository, topLevel } from "../issues/repository";
import { closeIssue as closeTrackerIssue, type CloseIssueRequest } from "./issue-close";
import {
  TrackerSync,
  type TrackerRead,
  type TrackerSyncView,
} from "./issue-sync";
import {
  activityPath,
  parseActivity,
  parseRunFile,
  readState,
  runDetail,
  runFilePath,
  type IssuesAgent,
  type IssuesRunDetail,
  type IssuesState,
} from "../issues/state";
import { activityDelta } from "./activity";

/**
 * The dashboard half of Issues mode. It never owns a poll loop, an agent, or
 * a lock: it reads the worker's repo-scoped state, replays its activity, and
 * writes commands to it. A worker started here is detached in its own session,
 * so killing this server leaves it running and a replacement reattaches.
 */

/** The command's grace, after which a worker the table proves is signalled. */
const STOP_PROOF_MS = 3_000;
/** How long a proven worker gets to exit after SIGTERM before SIGKILL. */
const STOP_KILL_GRACE_MS = 2_000;
/** Start waits no longer than the whole stop proof window for the peer to exit. */
const STOP_DEADLINE_MS = STOP_PROOF_MS + STOP_KILL_GRACE_MS;
const STOP_POLL_MS = 50;

export interface IssuesSnapshot {
  present: boolean;
  repo: string | null;
  root: string;
  lifecycle: IssuesState["lifecycle"];
  enabled: boolean;
  paused: boolean;
  attached: boolean;
  worker: IssuesState["worker"];
  poll: IssuesState["poll"] | null;
  queue: IssuesState["queue"];
  runs: IssuesState["runs"];
  agents: IssuesAgent[];
  cooldowns: IssuesState["cooldowns"];
  lastError: string | null;
  lastExitCode: number | null;
  finishedAt: string | null;
  notice: string | null;
  updatedAt: string | null;
  /** The dashboard's own tracker reads, independent of the worker. */
  sync: TrackerSyncView;
}

export interface ActivityEntry {
  text: string;
  append: boolean;
}

export interface IssuesBridgeOptions {
  repoDir: string;
  stateDir: string;
  agentCommand: string;
  /** Resolves the selected provider's environment for the detached worker. */
  agentEnvironment: () => Promise<Record<string, string | undefined>>;
  runningVersion: string | null;
  harnessDir: string;
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  log?: (line: string) => void;
  environment?: Record<string, string | undefined>;
  pollMs?: number;
  /** How often a connected dashboard re-reads the origin's open issues. */
  syncMs?: number;
  /** Test seam: replaces the dashboard's origin read. */
  syncRead?: TrackerRead;
  /** Test seam: the clock behind the dashboard's read freshness. */
  now?: () => Date;
  /** Test seam: false while no client is watching, so no read runs. */
  hasClients?: () => boolean;
  /** Wall-clock bound for the start preflight; defaults to 20 seconds. */
  preflightTimeoutMs?: number;
  /** Test seams: replace the start preflight and the detached spawn. */
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    environment: Record<string, string | undefined>;
    timeoutMs: number;
  }) => Promise<PreflightResult>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  /** Test seam: replace the tracker mutation the close control performs. */
  closeIssue?: (request: CloseIssueRequest) => Promise<void>;
}

/** The bits of the state a dashboard may safely publish. */
export class IssuesBridge {
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly agentCommand: string;
  private readonly agentEnvironment: () => Promise<Record<string, string | undefined>>;
  private readonly runningVersion: string | null;
  private readonly harnessDir: string;
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly environment: Record<string, string | undefined>;
  private readonly repository: () => string | null;
  private readonly preflight: NonNullable<IssuesBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<IssuesBridgeOptions["spawnWorker"]>;
  private readonly closeIssueAction: (request: CloseIssueRequest) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;
  private readonly preflightTimeoutMs: number;
  private readonly tracker: TrackerSync;
  private readonly hasClients: () => boolean;
  /** Runs already told to end because their issue left the tracker. */
  private readonly abandoned = new Set<string>();

  private timer: Timer | undefined;
  private syncTimer: Timer | undefined;
  private lastSignature = "";
  private lastActivities = new Map<string, string[]>();
  private stopping: { pid: number; timer: Timer; killTimer?: Timer } | undefined;
  private startTask:
    | Promise<{ ok: true; attached: boolean } | { ok: false; message: string }>
    | undefined;

  constructor(options: IssuesBridgeOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.agentCommand = options.agentCommand;
    this.agentEnvironment = options.agentEnvironment;
    this.runningVersion = options.runningVersion;
    this.harnessDir = options.harnessDir;
    this.send = options.send;
    this.environment = options.environment ?? process.env;
    this.repository = cachedRepository(this.repoDir);
    this.log = options.log ?? (() => undefined);
    this.pollMsValue = Math.max(50, options.pollMs ?? 250);
    this.preflightTimeoutMs = Math.max(
      1,
      options.preflightTimeoutMs ?? ISSUES_PREFLIGHT_TIMEOUT_MS,
    );
    this.preflight =
      options.preflight ??
      ((request) =>
        preflightIssues({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          environment: request.environment,
          timeoutMs: request.timeoutMs,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
    this.closeIssueAction = options.closeIssue ?? ((request) => closeTrackerIssue(request));
    this.hasClients = options.hasClients ?? (() => true);
    this.tracker = new TrackerSync({
      repoDir: this.repoDir,
      repository: () => this.currentRepository(),
      environment: this.environment,
      ...(options.syncMs === undefined ? {} : { intervalMs: options.syncMs }),
      ...(options.syncRead === undefined ? {} : { read: options.syncRead }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * The worker's published repository first, then the checkout's origin. A
   * directory below the checkout root inherits its parent's origin from git,
   * which would point the Open issues view at a different project, so only the
   * checkout root itself is read.
   */
  private currentRepository(): string | null {
    const state = this.currentState();
    if (state !== undefined && state.repo.length > 0) return state.repo;
    if (topLevel(this.repoDir) !== resolve(this.repoDir)) return null;
    return this.repository();
  }

  /** Reads the tracker now when a client is watching; joins an in-flight read. */
  syncNow(): Promise<void> {
    if (!this.hasClients()) return Promise.resolve();
    return this.tracker
      .sync()
      .then((result) => {
        // A forge this reader never reads retries nothing: one named state is
        // published and the periodic sync stops instead of polling a `gh`
        // path that cannot answer.
        if (this.tracker.unsupportedDetail !== null) this.stopSyncTimer();
        if (result.fresh && result.issues !== null && result.startedAt !== null) {
          const startedAt = Date.parse(result.startedAt);
          if (Number.isFinite(startedAt)) {
            this.stopClosedRuns(new Set(result.issues.map((issue) => issue.number)), startedAt);
          }
        }
        this.refresh();
      })
      .catch((error) => {
        // A snapshot can fail to publish while a client is closing; the next
        // read retries and the timer must keep running.
        this.log(
          `issues tracker sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * Ends every run the dashboard's fresh read no longer lists. A closed issue
   * is a decision, so its peer stops instead of finishing unseen. A run that
   * started after the read began was never in its answer and is left alone.
   * A live worker whose own read started no earlier than this one owns the
   * decision: its list may already show the issue open again, so the abandon
   * belongs to the worker's own newer read. Only a live worker attached to
   * this state directory receives the command. The fingerprint is recorded
   * only after the command is written, so a transient write failure is retried
   * by the next fresh read.
   */
  private stopClosedRuns(open: Set<number>, readStartedAt: number): void {
    const state = this.currentState();
    const owner = this.lockOwner();
    if (state === undefined || owner === undefined) return;
    if (resolve(owner.stateDir) !== this.stateDir) return;
    if (!state.enabled || state.lifecycle === "stopped") return;
    const workerPollAt = state.poll.lastPollAt === null ? NaN : Date.parse(state.poll.lastPollAt);
    if (
      (state.poll.error ?? null) === null &&
      Number.isFinite(workerPollAt) &&
      workerPollAt >= readStartedAt
    ) {
      return;
    }

    const eligible = state.agents.filter((agent) => {
      if (open.has(agent.issueNumber)) return false;
      const startedAt = Date.parse(agent.startedAt);
      return Number.isFinite(startedAt) && startedAt < readStartedAt;
    });
    const pending = new Set<string>();
    for (const agent of eligible) pending.add(`${agent.issueNumber}:${agent.runId}`);
    for (const key of [...this.abandoned]) {
      if (!pending.has(key)) this.abandoned.delete(key);
    }
    for (const agent of eligible) {
      const key = `${agent.issueNumber}:${agent.runId}`;
      if (this.abandoned.has(key)) continue;
      try {
        writeCommand(controlDirectory(this.stateDir, this.repoDir), {
          type: "abandon",
          number: agent.issueNumber,
        });
        this.abandoned.add(key);
      } catch (error) {
        this.log(
          `could not ask the issues worker to stop #${agent.issueNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Starts observing the worker state; it never starts a worker itself. */
  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.refresh(), this.pollMsValue);
    void this.refresh();
    if (this.tracker.unsupportedDetail === null) {
      this.syncTimer = setInterval(() => {
        void this.syncNow();
      }, this.tracker.view.intervalMs);
      this.syncTimer.unref?.();
    }
  }

  /** Stops the periodic tracker read once its origin forge is unreadable. */
  private stopSyncTimer(): void {
    if (this.syncTimer === undefined) return;
    clearInterval(this.syncTimer);
    this.syncTimer = undefined;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.syncTimer !== undefined) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.stopping !== undefined) this.clearStopProof(this.stopping.pid);
  }

  private detach(argv: string[], environment: Record<string, string | undefined>): number | undefined {
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: this.repoDir,
        env: environment,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child.pid;
    } catch (error) {
      this.log(`could not start the issues worker: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  private currentState(): IssuesState | undefined {
    return readState(statePath(this.stateDir, this.repoDir));
  }

  private lockOwner(): LockOwner | undefined {
    return liveLockOwner(lockPath(this.repoDir));
  }

  /** True when there is a worker state or a live lock to replay. */
  get present(): boolean {
    return this.currentState() !== undefined || this.lockOwner() !== undefined;
  }

  snapshot(): IssuesSnapshot {
    const state = this.currentState();
    const owner = this.lockOwner();
    const attached =
      owner !== undefined && resolve(owner.stateDir) === this.stateDir && pidAlive(owner.pid);
    const repo = state !== undefined && state.repo.length > 0 ? state.repo : this.repository();
    const active = attached ? state : undefined;
    const lifecycle = active?.lifecycle === "stopped" || active === undefined ? "stopped" : active.lifecycle;
    const worker = state?.worker ?? null;
    const mismatch =
      attached && worker !== null && worker.harnessVersion !== this.runningVersion
        ? `Issues worker ${worker.harnessVersion ?? "unknown"} is running; this dashboard loaded ${
            this.runningVersion ?? "unknown"
          }. It is left running; Stop it to launch the current harness on the next Start.`
        : null;
    return {
      present: state !== undefined,
      repo,
      root: this.repoDir,
      lifecycle,
      enabled: active?.enabled === true && lifecycle !== "stopped",
      paused: active?.paused === true && lifecycle !== "stopped",
      attached,
      worker: active?.worker ?? null,
      poll: active?.poll ?? null,
      queue: this.queueFor(state, attached),
      runs: state?.runs ?? [],
      agents: active?.agents ?? [],
      cooldowns: active?.cooldowns ?? {},
      lastError: active?.lastError ?? null,
      lastExitCode: active?.lastExitCode ?? null,
      finishedAt: active?.finishedAt ?? null,
      notice: mismatch ?? active?.notice ?? null,
      updatedAt: state?.updatedAt ?? null,
      sync: this.tracker.view,
    };
  }

  /**
   * The Open issues list. A live worker whose own read started no earlier than
   * the dashboard's is authoritative; otherwise the dashboard's read is used,
   * with the worker's handled and running markers merged in. Before the first
   * dashboard read the worker's queue is the only list there is. Only an
   * attached worker can be working an issue, so the running markers its state
   * left behind when it stopped are dropped: a worker that dies without a
   * final write keeps its last queue, and its old `agentRunId` entries would
   * otherwise count as running with no agent to run them.
   */
  private queueFor(state: IssuesState | undefined, attached: boolean): IssuesState["queue"] {
    const workerQueue = attached
      ? (state?.queue ?? [])
      : (state?.queue ?? []).map((entry) =>
          entry.agentRunId === null ? entry : { ...entry, agentRunId: null },
        );
    const open = this.tracker.openIssues;
    if (open === null) return workerQueue;
    const workerPollAt = state?.poll.lastPollAt ?? null;
    const readStartedAt = this.tracker.freshStartedAt;
    const workerIsNewer =
      attached &&
      (state?.poll.error ?? null) === null &&
      workerPollAt !== null &&
      readStartedAt !== null &&
      Date.parse(workerPollAt) >= Date.parse(readStartedAt);
    if (workerIsNewer) return workerQueue;
    const markers = new Map(workerQueue.map((issue) => [issue.number, issue]));
    const listed = new Set(open.map((issue) => issue.number));
    const queue = open.map((issue) => {
      const marker = markers.get(issue.number);
      return {
        ...issue,
        handled: marker?.handled ?? false,
        runId: marker?.runId ?? null,
        agentRunId: marker?.agentRunId ?? null,
      };
    });
    // A run younger than the read was never part of its answer: its issue is
    // kept visible until a read that started after the run reports on it.
    const cutoff = readStartedAt === null ? null : Date.parse(readStartedAt);
    if (attached && cutoff !== null && Number.isFinite(cutoff)) {
      for (const agent of state?.agents ?? []) {
        if (listed.has(agent.issueNumber)) continue;
        const startedAt = Date.parse(agent.startedAt);
        if (!Number.isFinite(startedAt) || startedAt < cutoff) continue;
        const marker = markers.get(agent.issueNumber);
        if (marker !== undefined) queue.push(marker);
      }
    }
    return queue.sort((left, right) => left.number - right.number);
  }

  /**
   * A connect-time replay: state to the caller, then every running agent's
   * whole activity to the caller and every other client. The baselines are
   * shared, so advancing one for a single client would make the next delta skip
   * what the older clients missed.
   */
  replay(target?: { send(data: string): unknown }): void {
    const deliver = target === undefined ? this.send : (event: unknown) => {
      try {
        target.send(JSON.stringify(event));
      } catch {
        // The socket closed before the replay finished.
      }
    };
    const snapshot = this.snapshot();
    deliver({ type: "issuesState", ...snapshot });
    for (const runId of this.activeRunIds(snapshot)) {
      const activity = this.readActivity(runId);
      this.lastActivities.set(runId, activity);
      const event = {
        type: "issuesActivity",
        runId,
        replay: true,
        entries: this.entries(activity),
      };
      deliver(event);
      // A targeted replay also reaches the other clients: the baseline is
      // shared, so a replay only the new client saw would make the next delta
      // skip it.
      if (target !== undefined) this.send(event, target);
    }
  }

  private activeRunIds(snapshot: IssuesSnapshot): string[] {
    return [...new Set(snapshot.agents.map((agent) => agent.runId))];
  }

  private entries(lines: string[]): ActivityEntry[] {
    return lines.map((text) => ({ text, append: false }));
  }

  private readActivity(runId: string): string[] {
    try {
      return parseActivity(readFileSync(activityPath(runDirectory(this.stateDir, this.repoDir, runId)), "utf8")) ?? [];
    } catch {
      return [];
    }
  }

  private publishActivity(runId: string, activity: string[]): void {
    const previous = this.lastActivities.get(runId);
    if (previous === undefined) {
      this.lastActivities.set(runId, activity);
      this.send({ type: "issuesActivity", runId, replay: true, entries: this.entries(activity) });
      return;
    }
    // A trim drops the front of the log, so only a whole replay stays correct.
    const delta = activityDelta(previous, activity);
    this.lastActivities.set(runId, activity);
    if (!delta.replay && delta.entries.length === 0) return;
    this.send({
      type: "issuesActivity",
      runId,
      ...(delta.replay ? { replay: true } : {}),
      entries: delta.entries,
    });
  }

  refresh(): void {
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.send({ type: "issuesState", ...snapshot });
    }
    const runIds = this.activeRunIds(snapshot);
    const active = new Set(runIds);
    for (const runId of [...this.lastActivities.keys()]) {
      if (!active.has(runId)) this.lastActivities.delete(runId);
    }
    for (const runId of runIds) {
      this.publishActivity(runId, this.readActivity(runId));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One in-flight Start for this bridge: a concurrent press joins the same
   * preflight and spawn instead of reporting success before anything started.
   */
  start(): Promise<{ ok: true; attached: boolean } | { ok: false; message: string }> {
    if (this.startTask !== undefined) return this.startTask;
    const task = this.startOnce().finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  private async startOnce(): Promise<
    { ok: true; attached: boolean } | { ok: false; message: string }
  > {
    for (;;) {
      const owner = this.lockOwner();
      if (owner === undefined) break;
      if (resolve(owner.stateDir) !== this.stateDir) {
        return {
          ok: false,
          message:
            `this checkout already has an issues worker (pid ${owner.pid}) using ${owner.stateDir}; ` +
            `this dashboard's STATE_DIR is ${this.stateDir}`,
        };
      }
      // A live owner that this bridge has told to stop is not attachable: the
      // worker is already ending, so report its state only after it has exited
      // and the new spawn holds the lock.
      if (this.stopping === undefined || this.stopping.pid !== owner.pid) {
        this.refresh();
        return { ok: true, attached: true };
      }
      if (!(await this.waitForStop(owner.pid))) {
        return {
          ok: false,
          message:
            `the previous issues worker (pid ${owner.pid}) is still stopping; ` +
            "press Start once it has exited.",
        };
      }
    }

    // A preflight that never settles (a stalled `gh`, credential helper, or
    // transport) loses this race, so Start reports a bounded failure and the
    // task memo is cleared instead of disabling Start for the server's life.
    const result = await withinDeadline(
      Promise.resolve(
        this.preflight({
          repoDir: this.repoDir,
          stateDir: this.stateDir,
          environment: this.environment,
          timeoutMs: this.preflightTimeoutMs,
        }),
      ),
      this.preflightTimeoutMs,
    );
    if (result === DEADLINE_EXPIRED) {
      return {
        ok: false,
        message:
          `the start preflight did not finish within ${this.preflightTimeoutMs} ms; ` +
          "press Start to retry.",
      };
    }
    if (!result.ok) return result;
    return await this.spawn();
  }

  /**
   * Waits out Stop's whole proof window for `pid` to exit. The worker is not
   * signalled here; Stop's own proof does that at its own deadline.
   */
  private async waitForStop(pid: number): Promise<boolean> {
    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (pidAlive(pid) && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, STOP_POLL_MS);
      await promise;
    }
    return !pidAlive(pid);
  }

  private async spawn(): Promise<{ ok: true; attached: boolean } | { ok: false; message: string }> {
    const argv = [
      process.execPath,
      join(this.harnessDir, "issues", "worker.ts"),
      "--repo",
      this.repoDir,
      "--state-dir",
      this.stateDir,
    ];
    let base: Record<string, string | undefined>;
    try {
      base = await this.agentEnvironment();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const pid = this.spawnWorker(argv, {
      ...base,
      REPO_DIR: this.repoDir,
      STATE_DIR: this.stateDir,
      AGENT_COMMAND: this.agentCommand,
    });
    if (pid === undefined) {
      return { ok: false, message: "the issues worker could not be started" };
    }
    return { ok: true, attached: false };
  }

  command(command: IssuesCommand): { ok: true } | { ok: false; message: string } {
    const state = this.currentState();
    const owner = this.lockOwner();
    if (owner === undefined) {
      return { ok: false, message: "No issues worker is running for this checkout." };
    }
    if (resolve(owner.stateDir) !== this.stateDir) {
      return {
        ok: false,
        message:
          `the issues worker (pid ${owner.pid}) uses ${owner.stateDir}; this dashboard's STATE_DIR is ` +
          `${this.stateDir}`,
      };
    }
    // The live lock proves a worker exists even when its state file is absent,
    // unreadable, or left by another harness version; Stop, pause, resume, and
    // check must still reach it. Only an answer needs the state's agent list.
    if (command.type === "answer") {
      if (state === undefined || !state.enabled || state.lifecycle === "stopped") {
        return { ok: false, message: "No issues worker is running for this checkout." };
      }
      if (typeof command.runId !== "string" || command.runId.length === 0) {
        return { ok: false, message: "An answer needs its run id." };
      }
      if (!state.agents.some((agent) => agent.runId === command.runId)) {
        return { ok: false, message: `No agent is running for run ${command.runId}.` };
      }
    }
    writeCommand(controlDirectory(this.stateDir, this.repoDir), command);
    if (command.type === "stop") this.scheduleStopProof(owner.pid);
    return { ok: true };
  }

  /**
   * Closes one open issue on the tracker. The worker is the source of truth for
   * the origin, so its state names the repository even when the dashboard's own
   * remote discovery came up empty.
   */
  async closeIssue(
    number: unknown,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      return { ok: false, message: "Closing an issue needs a positive issue number." };
    }
    const state = this.currentState();
    const repository = state !== undefined && state.repo.length > 0 ? state.repo : this.repository();
    if (repository === null || repository === undefined) {
      return { ok: false, message: "This checkout has no GitHub origin." };
    }
    try {
      await this.closeIssueAction({
        repoDir: this.repoDir,
        repository,
        number,
        environment: this.environment,
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Stop must end a worker that is still alive after the command. Only a
   * process the table proves is this checkout's worker is signalled.
   */
  private scheduleStopProof(pid: number): void {
    if (this.stopping !== undefined) this.clearStopProof(this.stopping.pid);
    const timer = setTimeout(() => {
      if (!pidAlive(pid) || !this.provesWorker(pid)) {
        this.clearStopProof(pid);
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        this.clearStopProof(pid);
        return;
      }
      // The stop is still pending until the grace ends, so Start must keep
      // waiting for this pid through it rather than report it attached.
      const killTimer = setTimeout(() => {
        if (!pidAlive(pid) || !this.provesWorker(pid)) {
          this.clearStopProof(pid);
          return;
        }
        this.clearStopProof(pid);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It exited between the proof and the signal.
        }
      }, STOP_KILL_GRACE_MS);
      killTimer.unref?.();
      if (this.stopping !== undefined && this.stopping.pid === pid) {
        this.stopping.killTimer = killTimer;
      }
    }, STOP_PROOF_MS);
    timer.unref?.();
    this.stopping = { pid, timer };
  }

  private clearStopProof(pid: number): void {
    if (this.stopping === undefined || this.stopping.pid !== pid) return;
    clearTimeout(this.stopping.timer);
    clearTimeout(this.stopping.killTimer);
    this.stopping = undefined;
  }

  private provesWorker(pid: number): boolean {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
    } catch {
      return false;
    }
    if (!argv.some((entry) => entry.endsWith(join("issues", "worker.ts")))) return false;
    if (!argv.includes(this.repoDir)) return false;
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === this.repoDir;
    } catch {
      return false;
    }
  }

  run(runId: unknown): IssuesRunDetail | undefined {
    if (typeof runId !== "string" || !/^[A-Za-z0-9_.-]+$/.test(runId)) return undefined;
    const directory = runDirectory(this.stateDir, this.repoDir, runId);
    try {
      const run = parseRunFile(readFileSync(runFilePath(directory), "utf8"));
      if (run === undefined) return undefined;
      return runDetail(run, this.readActivity(runId));
    } catch {
      return undefined;
    }
  }

}


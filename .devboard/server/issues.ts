import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readDrainMarker,
  writeCommand,
  writeDrainMarker,
  type IssuesCommand,
} from "../issues/control";
import { liveLockOwners, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  drainMarkerPath,
  lockPath,
  runDirectory,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/paths";
import {
  ISSUES_PREFLIGHT_TIMEOUT_MS,
  preflightIssues,
  type PreflightResult,
} from "../issues/preflight";
import { DEADLINE_EXPIRED, withinDeadline } from "../lib/deadline";
import { cachedRepository } from "../issues/repository";
import { hostHarnessDir, readHarnessVersion } from "./version";
import { closedByRun } from "../issues/self-close";
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
  type IssuesIssue,
  type IssuesRunDetail,
  type IssuesLifecycle,
  type IssuesState,
} from "../issues/state";
import { activityDelta } from "./activity";
import { canonicalProcessPath } from "./process";
import { supervisedDetach } from "../watchdog/supervision";

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

/** One running issue's peer, attributed to the worker version that owns it. */
export interface IssuesAgentView extends IssuesAgent {
  /**
   * The harness version recorded by the worker that owns this run. It comes
   * from the run record when that summary carries one, so a label never shows
   * the dashboard's own version for another worker's task.
   */
  harnessVersion: string | null;
}

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
  agents: IssuesAgentView[];
  cooldowns: IssuesState["cooldowns"];
  lastError: string | null;
  lastExitCode: number | null;
  finishedAt: string | null;
  notice: string | null;
  updatedAt: string | null;
  /** Every live worker of this family, whatever harness version started it. */
  workers: Array<{
    pid: number;
    version: string | null;
    stateDir: string;
    lifecycle: IssuesLifecycle;
  }>;
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
  /** Called after each fresh open-issue read, never on a failure. */
  onOpenIssues?: (issues: IssuesIssue[]) => void;
}

/** The bits of the state a dashboard may safely publish. */
export class IssuesBridge {
  private readonly repoDir: string;
  /** The repo path the kernel reports for a worker's cwd. */
  private readonly canonicalRepoDir: string;
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
  private readonly onOpenIssues: (issues: IssuesIssue[]) => void;
  /** Runs already told to end because their issue left the tracker. */
  private readonly abandoned = new Set<string>();

  private timer: Timer | undefined;
  private syncTimer: Timer | undefined;
  private lastSignature = "";
  private lastActivities = new Map<string, string[]>();
  /** An owning version read from a run record an earlier summary omitted. */
  private readonly runVersions = new Map<string, string | null>();
  /**
   * One proof per stopped pid. A proof belongs to its own pid alone, so
   * stopping a second owner never clears the first owner's timers.
   */
  private readonly stopping = new Map<number, { timer: Timer; killTimer?: Timer }>();
  private startTask:
    | Promise<{ ok: true; attached: boolean } | { ok: false; message: string }>
    | undefined;
  /** One automatic new-version start per dashboard lifetime. */
  private takeover: "idle" | "started" = "idle";

  constructor(options: IssuesBridgeOptions) {
    this.repoDir = resolve(options.repoDir);
    this.canonicalRepoDir = canonicalProcessPath(this.repoDir);
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
    this.onOpenIssues = options.onOpenIssues ?? (() => undefined);
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
   * The worker's published repository first, then the checkout's origin. The
   * origin read itself refuses a root below a checkout, which would otherwise
   * inherit its parent's remote and point the Open issues view at a different
   * project.
   */
  private currentRepository(): string | null {
    const state = this.currentState();
    if (state !== undefined && state.repo.length > 0) return state.repo;
    return this.repository();
  }

  /** The last complete open list from the dashboard's own read, or null. */
  get openIssues(): IssuesIssue[] | null {
    return this.tracker.openIssues;
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
          this.onOpenIssues(result.issues);
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
    const owners = this.owners().filter((owner) => !this.foreignOwner(owner));
    if (owners.length === 0) return;
    const pending = new Set<string>();
    for (const owner of owners) {
      const state = this.stateForOwner(owner);
      if (state === undefined) continue;
      if (!state.enabled || state.lifecycle === "stopped") continue;
      const workerPollAt = state.poll.lastPollAt === null ? NaN : Date.parse(state.poll.lastPollAt);
      if (
        (state.poll.error ?? null) === null &&
        Number.isFinite(workerPollAt) &&
        workerPollAt >= readStartedAt
      ) {
        continue;
      }
      const eligible = state.agents.filter((agent) => {
        if (open.has(agent.issueNumber)) return false;
        // The run closed its own issue: its worker settles the run as
        // succeeded, so the dashboard must not send the cancellation it sends
        // for an operator's close.
        if (closedByRun(this.stateDir, this.repoDir, agent.issueNumber) === agent.runId) {
          return false;
        }
        const startedAt = Date.parse(agent.startedAt);
        return Number.isFinite(startedAt) && startedAt < readStartedAt;
      });
      for (const agent of eligible) pending.add(`${agent.issueNumber}:${agent.runId}`);
      for (const agent of eligible) {
        const key = `${agent.issueNumber}:${agent.runId}`;
        if (this.abandoned.has(key)) continue;
        try {
          writeCommand(this.controlFor(owner), {
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
    for (const key of [...this.abandoned]) {
      if (!pending.has(key)) this.abandoned.delete(key);
    }
  }

  /** Starts observing the worker state; it never starts a worker itself. */
  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.refresh(), this.pollMsValue);
    void this.refresh();
    void this.takeoverOldWorkers();
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

  /**
   * Starts this version's worker when an older version's worker is live and
   * this process is the newest harness. The older worker is told to drain: it
   * finishes its current unit, starts no new one, and exits on its own.
   */
  private async takeoverOldWorkers(): Promise<void> {
    if (this.takeover === "started") return;
    this.takeover = "started";
    const owners = this.owners().filter((owner) => !this.foreignOwner(owner));
    if (owners.length === 0) return;
    const newest = readHarnessVersion(hostHarnessDir(this.repoDir));
    if (newest === null || newest !== this.runningVersion) return;
    if (owners.some((owner) => owner.harnessVersion === this.runningVersion)) return;
    const started = await this.spawn();
    if (!started.ok) {
      this.log(`could not start the ${this.runningVersion} issues worker: ${started.message}`);
      return;
    }
    for (const owner of owners) {
      if (owner.harnessVersion === this.runningVersion) continue;
      try {
        // Recorded before the command, so the aggregate view can tell this
        // automatic drain from a Pause even when the drained harness predates
        // the pause source it would otherwise write.
        writeDrainMarker(drainMarkerPath(this.stateDir, this.repoDir, owner.harnessVersion), {
          version: owner.harnessVersion,
          pid: owner.pid,
          by: this.runningVersion,
          at: new Date().toISOString(),
        });
        writeCommand(this.controlFor(owner), { type: "drain" });
      } catch (error) {
        this.log(
          `could not drain the ${owner.harnessVersion ?? "legacy"} issues worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
    this.clearStopProof();
  }

  private detach(argv: string[], environment: Record<string, string | undefined>): number | undefined {
    return supervisedDetach(argv, {
      cwd: this.repoDir,
      env: environment,
      stateDir: this.stateDir,
      onError: (error) => {
        this.log(
          `could not start the issues worker: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  /** Every readable worker state: the legacy file and each version's file. */
  private allStates(): IssuesState[] {
    const states: IssuesState[] = [];
    const push = (path: string): void => {
      const state = readState(path);
      if (state !== undefined) states.push(state);
    };
    push(statePath(this.stateDir, this.repoDir));
    for (const directory of workerStateDirectories(this.stateDir, this.repoDir)) {
      push(join(directory, "state.json"));
    }
    return states;
  }

  /** The newest published state, or undefined before any worker wrote one. */
  private currentState(): IssuesState | undefined {
    return this.allStates().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  /** Owners of every live lock beside this checkout's legacy lock. */
  private owners(): LockOwner[] {
    return liveLockOwners(lockPath(this.repoDir));
  }

  private lockOwner(): LockOwner | undefined {
    return this.owners()[0];
  }

  /** True for a live owner this dashboard's STATE_DIR does not own. */
  private foreignOwner(owner: LockOwner): boolean {
    return resolve(owner.stateDir) !== this.stateDir;
  }

  /** The control directory one live owner consumes, versioned or legacy. */
  private controlFor(owner: LockOwner): string {
    if (owner.harnessVersion !== null) {
      const path = versionedStatePath(this.stateDir, this.repoDir, owner.harnessVersion);
      if (existsSync(path)) {
        return versionedControlDirectory(this.stateDir, this.repoDir, owner.harnessVersion);
      }
    }
    return controlDirectory(this.stateDir, this.repoDir);
  }

  /** True when there is a worker state or a live lock to replay. */
  get present(): boolean {
    return this.currentState() !== undefined || this.lockOwner() !== undefined;
  }

  /**
   * True when this dashboard, or a worker that records its own provenance,
   * says the worker paused because a newer version took over. A marker is
   * honoured only for the pid it was written for and only when the worker's
   * state does not claim an operator pause, so a fresh worker of the same
   * version never inherits an older drain.
   */
  private automaticDrain(owner: LockOwner, state: IssuesState): boolean {
    if (state.pauseSource === "drain") return true;
    if (state.pauseSource === "operator") return false;
    if (!state.paused) return false;
    const marker = readDrainMarker(
      drainMarkerPath(this.stateDir, this.repoDir, owner.harnessVersion),
    );
    return marker !== undefined && marker.pid === owner.pid;
  }

  /**
   * The harness version a run record itself carries. A summary an earlier
   * harness wrote has no version to give, so the record is read once and its
   * answer cached: a run's owning version never changes after it starts.
   */
  private runVersion(run: IssuesState["runs"][number]): string | null {
    if (run.harnessVersion !== undefined && run.harnessVersion !== null) {
      return run.harnessVersion;
    }
    const cached = this.runVersions.get(run.runId);
    if (cached !== undefined) return cached;
    let version: string | null = null;
    try {
      const record = parseRunFile(
        readFileSync(runFilePath(runDirectory(this.stateDir, this.repoDir, run.runId)), "utf8"),
      );
      version = record?.harnessVersion ?? null;
    } catch {
      version = null;
    }
    this.runVersions.set(run.runId, version);
    return version;
  }

  snapshot(): IssuesSnapshot {
    const owners = this.owners();
    const attachedOwners = owners.filter((owner) => !this.foreignOwner(owner));
    const states = this.allStates();
    const byPid = new Map(
      states.filter((state) => state.worker !== null).map((state) => [state.worker!.pid, state]),
    );
    const ownerless = states.find((state) => state.worker === null);
    const attachedPairs = attachedOwners
      .map((owner) => ({ owner, state: byPid.get(owner.pid) ?? ownerless }))
      .filter((pair): pair is { owner: LockOwner; state: IssuesState } => pair.state !== undefined)
      .map((pair) => ({ ...pair, drained: this.automaticDrain(pair.owner, pair.state) }));
    const attachedStates = attachedPairs.map((pair) => pair.state);
    const drainedStates = new Set(
      attachedPairs.filter((pair) => pair.drained).map((pair) => pair.state),
    );
    const attached = attachedOwners.length > 0;
    const sorted = [...states].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const newest = [...attachedStates].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    // A drain is not the family's pause: while any attached member works or
    // polls, the family reports that work instead of one member's shutdown.
    const operatorPaused = newest.filter(
      (state) => state.paused && !drainedStates.has(state),
    );
    const liveStates = newest.filter((state) => state.lifecycle !== "stopped");
    const working = liveStates.some(
      (state) => state.lifecycle === "running" || state.agents.length > 0,
    );
    const lifecycle: IssuesLifecycle =
      !attached || liveStates.length === 0
        ? "stopped"
        : operatorPaused.length > 0
          ? working
            ? "pausing"
            : "paused"
          : working
            ? "running"
            : liveStates.some((state) => state.lifecycle === "idle")
              ? "idle"
              : liveStates.some((state) => state.lifecycle === "failed")
                ? "failed"
                : "paused";
    const candidates = attached && newest.length > 0 ? newest : sorted;
    const active =
      operatorPaused[0] ??
      candidates.find((state) => state.lifecycle === "running") ??
      candidates.find((state) => state.lifecycle === "idle") ??
      candidates.find((state) => !drainedStates.has(state)) ??
      candidates[0];
    const repo = active !== undefined && active.repo.length > 0 ? active.repo : this.repository();
    const versionByPid = new Map<number, string | null>();
    for (const state of states) {
      if (state.worker !== null) versionByPid.set(state.worker.pid, state.worker.harnessVersion);
    }
    for (const owner of owners) {
      if (!versionByPid.has(owner.pid)) versionByPid.set(owner.pid, owner.harnessVersion);
    }
    const workers = attachedOwners.map((owner) => {
      const state = byPid.get(owner.pid);
      return {
        pid: owner.pid,
        version: owner.harnessVersion,
        stateDir: owner.stateDir,
        lifecycle: (state?.lifecycle ?? "running") as IssuesLifecycle,
      };
    });
    const runs = new Map<string, IssuesState["runs"][number]>();
    for (const state of states) {
      for (const run of state.runs) {
        if (runs.has(run.runId)) continue;
        // The run record's own version wins; an earlier summary that lacks it
        // falls back to the record itself, then to the pid that wrote the run.
        runs.set(run.runId, {
          ...run,
          harnessVersion:
            this.runVersion(run) ??
            (run.workerPid === undefined ? null : versionByPid.get(run.workerPid) ?? null),
        });
      }
    }
    const cooldowns: IssuesState["cooldowns"] = {};
    const agents: IssuesAgentView[] = [];
    for (const { state } of attachedPairs) {
      Object.assign(cooldowns, state.cooldowns);
      for (const agent of state.agents) {
        agents.push({
          ...agent,
          harnessVersion:
            runs.get(agent.runId)?.harnessVersion ??
            (state.worker === null ? null : versionByPid.get(state.worker.pid) ?? null),
        });
      }
    }
    return {
      present: states.length > 0 || owners.length > 0,
      repo,
      root: this.repoDir,
      lifecycle,
      enabled:
        attached &&
        liveStates.length > 0 &&
        lifecycle !== "stopped" &&
        liveStates.some((state) => state.enabled),
      paused: lifecycle === "pausing" || lifecycle === "paused",
      attached,
      worker: attached && attachedPairs.length > 0 && active !== undefined ? active.worker : null,
      poll: active?.poll ?? null,
      queue: this.queueFor(),
      runs: [...runs.values()].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      ),
      agents,
      cooldowns,
      lastError: active?.lastError ?? null,
      lastExitCode: active?.lastExitCode ?? null,
      finishedAt: active?.finishedAt ?? null,
      notice: active?.notice ?? null,
      updatedAt: active?.updatedAt ?? null,
      workers,
      sync: this.tracker.view,
    };
  }

  /**
   * The Open issues list: exactly the open issues one forge read returned.
   * No worker state adds, removes, or restates a row, so a stopped worker's
   * stale list, a live worker's newer poll, and the ledger's history all
   * decide nothing here. A row's running state is the `processing` label the
   * forge returned for it; the worker-owned markers stay false so no second
   * source can claim a row is handled or running.
   */
  private queueFor(): IssuesState["queue"] {
    const open = this.tracker.openIssues;
    if (open === null) return [];
    return open
      .map((issue) => ({
        ...issue,
        handled: false,
        runId: null,
        agentRunId: null,
      }))
      .sort((left, right) => left.number - right.number);
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
      const owners = this.owners();
      if (owners.length === 0) break;
      const foreign = owners.find((owner) => this.foreignOwner(owner));
      if (foreign !== undefined) {
        return {
          ok: false,
          message:
            `this checkout already has an issues worker (pid ${foreign.pid}) using ${foreign.stateDir}; ` +
            `this dashboard's STATE_DIR is ${this.stateDir}`,
        };
      }
      // A live owner that this bridge has told to stop is not attachable: the
      // worker is already ending, so report its state only after every stopped
      // owner has exited and the new spawn holds the lock.
      const live = owners.filter((owner) => !this.stopping.has(owner.pid));
      if (live.length > 0) {
        this.refresh();
        return { ok: true, attached: true };
      }
      const stopping = owners.map((owner) => owner.pid);
      const waits = await Promise.all(stopping.map((pid) => this.waitForStop(pid)));
      if (waits.some((stopped) => !stopped)) {
        return {
          ok: false,
          message:
            `the previous issues worker (pid ${stopping.join(", ")}) is still stopping; ` +
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
    const owners = this.owners();
    if (owners.length === 0) {
      return { ok: false, message: "No issues worker is running for this checkout." };
    }
    const foreign = owners.find((owner) => this.foreignOwner(owner));
    if (foreign !== undefined) {
      return {
        ok: false,
        message:
          `the issues worker (pid ${foreign.pid}) uses ${foreign.stateDir}; this dashboard's STATE_DIR is ` +
          `${this.stateDir}`,
      };
    }
    if (command.type === "answer") {
      if (typeof command.runId !== "string" || command.runId.length === 0) {
        return { ok: false, message: "An answer needs its run id." };
      }
      const target = owners.find((owner) => {
        const state = this.stateForOwner(owner);
        return state !== undefined && state.agents.some((agent) => agent.runId === command.runId);
      });
      if (target === undefined) {
        return { ok: false, message: `No agent is running for run ${command.runId}.` };
      }
      writeCommand(this.controlFor(target), command);
      return { ok: true };
    }
    for (const owner of owners) {
      writeCommand(this.controlFor(owner), command);
      if (command.type === "stop") this.scheduleStopProof(owner.pid);
    }
    return { ok: true };
  }

  /** The published state one live owner wrote, when it is readable. */
  private stateForOwner(owner: LockOwner): IssuesState | undefined {
    if (owner.harnessVersion !== null) {
      const state = readState(
        versionedStatePath(this.stateDir, this.repoDir, owner.harnessVersion),
      );
      if (state !== undefined) return state;
    }
    return readState(statePath(this.stateDir, this.repoDir));
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
    this.clearStopProof(pid);
    const prove = (): void => {
      const proof = this.stopping.get(pid);
      if (proof === undefined) return;
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
        if (this.stopping.get(pid) !== proof) return;
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
      proof.killTimer = killTimer;
    };
    const timer = setTimeout(prove, STOP_PROOF_MS);
    timer.unref?.();
    this.stopping.set(pid, { timer });
  }

  private clearStopProof(pid?: number): void {
    if (pid === undefined) {
      for (const proof of this.stopping.values()) {
        clearTimeout(proof.timer);
        clearTimeout(proof.killTimer);
      }
      this.stopping.clear();
      return;
    }
    const proof = this.stopping.get(pid);
    if (proof === undefined) return;
    clearTimeout(proof.timer);
    clearTimeout(proof.killTimer);
    this.stopping.delete(pid);
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
      return readlinkSync(`/proc/${pid}/cwd`) === this.canonicalRepoDir;
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


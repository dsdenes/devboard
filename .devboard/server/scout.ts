import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwners, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  lockPath,
  scanDirectory,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/scout/paths";
import { writeCommand } from "../issues/scout/control";
import {
  SCOUT_PREFLIGHT_TIMEOUT_MS,
  preflightScout,
  type ScoutPreflightResult,
} from "../issues/scout/preflight";
import { DEADLINE_EXPIRED, withinDeadline } from "../lib/deadline";
import { cachedRepository } from "../issues/repository";
import {
  DEFAULT_SETTINGS,
  isValidCadence,
  isValidLimit,
  readSettings,
  readState,
  writeSettings,
  type ScoutIssueRow,
  type ScoutSettings,
  type ScoutState,
} from "../issues/scout/state";
import { readActivity } from "../issues/state";
import { hostHarnessDir, readHarnessVersion } from "./version";
import { canonicalProcessPath } from "./state";
import { activityDelta } from "./activity";
import { AgentForgeState } from "./agents/forge-state";
import { createForgeIssueReader, type ForgeIssueReader } from "./agents/forge-reader";
import { projectAgentSnapshot, type AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";
import type { AgentDescriptor } from "./agents/registry";
import { supervisedDetach } from "../watchdog/supervision";

/**
 * The dashboard half of Auto Scout. It never owns a scan loop, an agent, or a
 * lock: it reads the worker's repo-scoped board, replays its activity, and
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

export interface ScoutActivityEntry {
  text: string;
  append: boolean;
}

export interface ScoutBridgeOptions {
  descriptor: AgentDescriptor;
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
  /** Wall-clock bound for the start preflight; defaults to 20 seconds. */
  preflightTimeoutMs?: number;
  /** Injectable forge read; production reads the origin's issue state. */
  reader?: ForgeIssueReader;
  /** True while at least one dashboard client is connected. */
  hasClients?: () => boolean;
  /** Test seams: replace the start preflight and the detached spawn. */
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    environment: Record<string, string | undefined>;
    timeoutMs: number;
  }) => Promise<ScoutPreflightResult>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  now?: () => number;
}

/** How long a spawned worker may take to publish its lock before Start fails. */
const START_PROOF_MS = 5_000;
/**
 * A page open asks the attached worker for one fresh read. Two clients opening
 * the same page within this window share that read instead of queuing another.
 */
const SYNC_REQUEST_MIN_INTERVAL_MS = 5_000;

export class ScoutBridge implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
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
  private readonly forge: AgentForgeState;
  private readonly preflight: NonNullable<ScoutBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<ScoutBridgeOptions["spawnWorker"]>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;
  private readonly preflightTimeoutMs: number;
  private readonly now: () => number;

  private timer: Timer | undefined;
  private lastActivityScanId: string | null = null;
  private lastActivity: string[] = [];
  /**
   * One proof per stopped pid. A proof belongs to its own pid alone, so
   * stopping a second owner never clears the first owner's timers.
   */
  private readonly stopping = new Map<number, { timer: Timer; killTimer?: Timer }>();
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private startTask: Promise<AgentCommandResult> | undefined;
  /** One automatic new-version start per dashboard lifetime. */
  private takeover: "idle" | "started" = "idle";
  private takeoverTask: Promise<void> | undefined;
  private lastSyncRequestAt = Number.NEGATIVE_INFINITY;

  constructor(options: ScoutBridgeOptions) {
    this.descriptor = options.descriptor;
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
    this.now = options.now ?? (() => Date.now());
    this.preflightTimeoutMs = Math.max(
      1,
      options.preflightTimeoutMs ?? SCOUT_PREFLIGHT_TIMEOUT_MS,
    );
    this.preflight =
      options.preflight ??
      ((request) =>
        preflightScout({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          environment: request.environment,
          timeoutMs: request.timeoutMs,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
    this.forge = new AgentForgeState({
      reader:
        options.reader ??
        createForgeIssueReader({
          repoDir: this.repoDir,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        }),
      urls: () => this.mergedRows().map((issue) => issue.url),
      hasClients: options.hasClients ?? (() => false),
      now: this.now,
      log: this.log,
    });
  }

  /** Starts observing the worker state; it never starts a worker itself. */
  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.refresh(), this.pollMsValue);
    this.forge.begin();
    void this.refresh();
    this.takeoverTask = this.takeoverOldWorkers();
  }

  /** Resolves after the automatic takeover attempt and any read have settled. */
  settled(): Promise<void> {
    return Promise.all([this.takeoverTask ?? Promise.resolve(), this.forge.settled()]).then(
      () => undefined,
    );
  }

  /**
   * Starts this version's worker when an older version's worker is live and
   * this process is the newest harness. The older worker is told to drain: it
   * finishes its in-flight scan, starts no new one, and exits on its own.
   */
  private async takeoverOldWorkers(): Promise<void> {
    if (this.takeover === "started") return;
    this.takeover = "started";
    const owners = this.owners();
    if (owners.length === 0) return;
    const newest = readHarnessVersion(hostHarnessDir(this.repoDir));
    if (newest === null || newest !== this.runningVersion) return;
    if (owners.some((owner) => owner.harnessVersion === this.runningVersion)) return;
    const started = await this.spawn();
    if (!started.ok) {
      this.log(`could not start the ${this.runningVersion} Auto Scout worker: ${started.message}`);
      return;
    }
    for (const owner of owners) {
      if (owner.harnessVersion === this.runningVersion) continue;
      try {
        writeCommand(this.controlFor(owner), { type: "drain" });
      } catch (error) {
        this.log(
          `could not drain the ${owner.harnessVersion ?? "legacy"} Auto Scout worker: ${
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
    this.forge.dispose();
    this.clearStopProof();
  }

  private detach(argv: string[], environment: Record<string, string | undefined>): number | undefined {
    return supervisedDetach(argv, {
      cwd: this.repoDir,
      env: environment,
      stateDir: this.stateDir,
      onError: (error) => {
        this.log(
          `could not start the scout worker: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  /** Every readable worker state: the legacy file and each version's file. */
  private allStates(): ScoutState[] {
    const states: ScoutState[] = [];
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
  private currentState(): ScoutState | undefined {
    return this.allStates().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  /** Owners of every live lock beside this checkout's legacy lock. */
  private allOwners(): LockOwner[] {
    return liveLockOwners(lockPath(this.repoDir));
  }

  /** Live owners this dashboard's STATE_DIR may command. */
  private owners(): LockOwner[] {
    return this.allOwners().filter((owner) => !this.foreignOwner(owner));
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

  /** The published state one live owner wrote, when it is readable. */
  private stateForOwner(owner: LockOwner): ScoutState | undefined {
    if (owner.harnessVersion !== null) {
      const state = readState(versionedStatePath(this.stateDir, this.repoDir, owner.harnessVersion));
      if (state !== undefined) return state;
    }
    return readState(statePath(this.stateDir, this.repoDir));
  }

  private settings(state: ScoutState | undefined): ScoutSettings {
    return (
      readSettings(settingsPath(this.stateDir, this.repoDir)) ?? {
        maxPerHour: state?.limits.maxPerHour ?? DEFAULT_SETTINGS.maxPerHour,
        maxPending: state?.limits.maxPending ?? DEFAULT_SETTINGS.maxPending,
        intervalMinutes: state?.intervalMinutes ?? DEFAULT_SETTINGS.intervalMinutes,
      }
    );
  }

  /**
   * The scan the detail panel follows: a running unit first, otherwise the
   * newest recorded scan across every worker version.
   */
  private scanIdOf(states: ScoutState[]): string | null {
    const running = states
      .map((state) => state.scan)
      .filter((scan): scan is NonNullable<ScoutState["scan"]> => scan !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (running !== undefined) return running.scanId;
    return states
      .map((state) => state.newestScanId)
      .filter((scanId): scanId is string => scanId !== null)
      .sort()
      .at(-1) ?? null;
  }

  /** The shared lifecycle vocabulary for one worker's published state. */
  private workerLifecycle(state: ScoutState | undefined): AgentSnapshotInput["lifecycle"] {
    if (state === undefined) return "running";
    if (state.lifecycle === "failed") return "failed";
    if (state.lifecycle === "stopped") return "stopped";
    return "running";
  }

  /** True when there is a worker state or a live lock to replay. */
  get present(): boolean {
    return this.allStates().length > 0 || this.allOwners().length > 0;
  }

  /**
   * Every filed row the attached workers published, newest state first. Live
   * workers' reads are merged, so the view shows every running unit; a
   * stopped worker's state is history, and its dropped rows must not return.
   */
  private mergedRows(): ScoutIssueRow[] {
    const owners = this.owners();
    const ownerStates = owners
      .map((owner) => this.stateForOwner(owner))
      .filter((state): state is ScoutState => state !== undefined);
    const state = this.currentState();
    const reading = owners.length > 0 ? ownerStates : state === undefined ? [] : [state];
    const issues = new Map<number, ScoutIssueRow>();
    for (const entry of [...reading].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )) {
      for (const issue of entry.issues) if (!issues.has(issue.number)) issues.set(issue.number, issue);
    }
    return [...issues.values()].sort((left, right) => {
      const byCreation = right.createdAt.localeCompare(left.createdAt);
      return byCreation !== 0 ? byCreation : right.number - left.number;
    });
  }

  snapshot(): AgentSnapshotInput {
    this.forge.requestSync();
    const allOwners = this.allOwners();
    const owners = this.owners();
    const attached = owners.length > 0;
    const states = this.allStates();
    const ownerStates = owners
      .map((owner) => this.stateForOwner(owner))
      .filter((state): state is ScoutState => state !== undefined);
    const state = this.currentState();
    const scanning = ownerStates.some((entry) => entry.lifecycle === "scanning");
    const failed = ownerStates.some((entry) => entry.lifecycle === "failed");
    const stopped = ownerStates.length > 0 && ownerStates.every((entry) => entry.lifecycle === "stopped");
    const active = ownerStates.find((entry) => entry.lifecycle === "scanning") ?? ownerStates[0];
    const foreign = attached ? undefined : allOwners[0];
    if (this.starting && owners.length > 0) {
      this.starting = false;
      this.startingSince = null;
    }
    if (
      this.starting &&
      this.startingSince !== null &&
      this.now() - this.startingSince > START_PROOF_MS
    ) {
      this.starting = false;
      this.startingSince = null;
      this.startError = "the Auto Scout worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && owners.length === 0) this.stopRequested = false;
    if (foreign !== undefined) {
      this.notice =
        `this checkout already has an Auto Scout worker (pid ${foreign.pid}) using ` +
        `${foreign.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
    } else if (this.notice !== null && this.notice.startsWith("this checkout already has")) {
      this.notice = null;
    }

    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested
        ? "stopping"
        : attached
          ? scanning
            ? "running"
            : failed
              ? "failed"
              : stopped
                ? "stopped"
                : "running"
          : foreign !== undefined
            ? "running"
            : state?.lifecycle === "failed" && state.enabled
              ? "failed"
              : "stopped";
    const settings = this.settings(state);
    const lastRunAt =
      ownerStates
        .map((entry) => entry.lastScanStartedAt)
        .filter((entry): entry is string => entry !== null)
        .sort()
        .at(-1) ??
      state?.lastScanStartedAt ??
      active?.scan?.startedAt ??
      null;
    const nextRunAt = attached
      ? (active?.nextAttemptAt ?? nextCadenceAt(lastRunAt, settings.intervalMinutes))
      : null;
    const merged = this.mergedRows();
    const rows = merged
      .filter((issue) => this.forge.reported(issue.url))
      .map((issue) => {
        const fact = this.forge.fact(issue.url);
        if (fact !== undefined) {
          return {
            title: issue.title,
            category: issue.category,
            filedAt: issue.createdAt,
            url: issue.url,
            state: fact.state,
            version: fact.version,
          };
        }
        return this.forge.unreadable(issue.url)
          ? { ...projectIssue(issue), state: "unknown" as const }
          : projectIssue(issue);
      });
    const scanId = this.scanIdOf(states);
    const workers = owners.map((owner) => {
      const workerState = this.stateForOwner(owner);
      return {
        pid: owner.pid,
        version: owner.harnessVersion,
        stateDir: owner.stateDir,
        lifecycle: this.workerLifecycle(workerState),
      };
    });
    return {
      lifecycle,
      enabled: attached && ownerStates.some((entry) => entry.enabled) && lifecycle !== "stopped",
      owned: attached,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt,
        nextRunAt,
      },
      limits: {
        maxPerHour: settings.maxPerHour,
        maxPending: settings.maxPending,
      },
      issues: rows,
      pending: rows.filter((issue) => issue.state === "pending").length,
      sync: this.forge.sync,
      detail: {
        panel: "activity",
        scanId,
        entries: [...this.lastActivity],
      },
      notice: this.notice ?? active?.notice ?? null,
      error: this.startError ?? active?.lastError ?? null,
      timer: null,
      workers,
    };
  }

  /**
   * A connect-time replay: the newest scan's whole activity to the caller and
   * every other client. The baseline is shared, so advancing it for one client
   * alone would make the next delta skip what the older clients missed.
   */
  replay(target: { send(data: string): unknown }): void {
    const deliver = (event: unknown) => {
      try {
        target.send(JSON.stringify(event));
      } catch {
        // The socket closed before the replay finished.
      }
    };
    deliver({
      type: "agentState",
      agent: projectAgentSnapshot(this.descriptor, this.snapshot()),
    });
    const scanId = this.lastActivityScanId ?? this.scanIdOf(this.allStates());
    if (scanId === null) return;
    const activity = this.readActivity(scanId);
    this.lastActivityScanId = scanId;
    this.lastActivity = activity;
    const event = {
      type: "agentActivity",
      id: this.descriptor.id,
      scanId,
      replay: true,
      entries: activity.map((text) => ({ text, append: false })),
    };
    deliver(event);
    this.send(event, target);
  }

  private readActivity(scanId: string): string[] {
    return readActivity(scanDirectory(this.repoDir, scanId));
  }

  private publishActivity(scanId: string, activity: string[]): void {
    if (this.lastActivityScanId !== scanId) {
      this.lastActivityScanId = scanId;
      this.lastActivity = activity;
      this.send({
        type: "agentActivity",
        id: this.descriptor.id,
        scanId,
        replay: true,
        entries: activity.map((text) => ({ text, append: false })),
      });
      return;
    }
    const delta = activityDelta(this.lastActivity, activity);
    this.lastActivity = activity;
    if (!delta.replay && delta.entries.length === 0) return;
    this.send({
      type: "agentActivity",
      id: this.descriptor.id,
      scanId,
      ...(delta.replay ? { replay: true } : {}),
      entries: delta.entries,
    });
  }

  refresh(): void {
    const snapshot = this.snapshot();
    const scanId = snapshot.detail.panel === "activity" ? snapshot.detail.scanId : null;
    if (scanId === null) {
      this.lastActivityScanId = null;
      this.lastActivity = [];
      return;
    }
    this.publishActivity(scanId, this.readActivity(scanId));
  }

  /**
   * A view opened this agent: read the forge now when the shared cadence
   * allows, and ask every attached worker for its own fresh read, at most once
   * per sync-request window. A stopped worker gets no command and is never
   * started; the dashboard read alone still shows its table.
   */
  requestSync(): void {
    this.forge.requestSync();
    const owners = this.owners();
    if (owners.length === 0) return;
    const now = this.now();
    if (now - this.lastSyncRequestAt < SYNC_REQUEST_MIN_INTERVAL_MS) return;
    this.lastSyncRequestAt = now;
    for (const owner of owners) {
      try {
        writeCommand(this.controlFor(owner), { type: "refresh" });
      } catch (error) {
        this.log(
          `could not request an Auto Scout read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One in-flight Start for this bridge: a concurrent press joins the same
   * preflight and spawn instead of reporting success before anything started.
   */
  start(): Promise<AgentCommandResult> {
    if (this.startTask !== undefined) return this.startTask;
    const task = this.startOnce().finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  private async startOnce(): Promise<AgentCommandResult> {
    for (;;) {
      const allOwners = this.allOwners();
      const owners = allOwners.filter((owner) => !this.foreignOwner(owner));
      const foreign = allOwners.find((owner) => this.foreignOwner(owner));
      if (owners.length === 0) {
        if (foreign === undefined) break;
        this.notice =
          `this checkout already has an Auto Scout worker (pid ${foreign.pid}) using ` +
          `${foreign.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
        return { ok: true, notice: this.notice };
      }
      // A live worker of any version occupies the family: Start spawns nothing
      // while one exists. Every live owner this bridge has told to stop is not
      // attachable, so report its state only after all of them have exited.
      const stopping = owners
        .map((owner) => owner.pid)
        .filter((pid) => this.stopping.has(pid));
      if (stopping.length === 0) {
        this.refresh();
        return { ok: true };
      }
      const waits = await Promise.all(stopping.map((pid) => this.waitForStop(pid)));
      if (waits.some((stopped) => !stopped)) {
        return {
          ok: false,
          message:
            `the previous Auto Scout worker (pid ${stopping.join(", ")}) is still stopping; ` +
            "press Start once it has exited.",
        };
      }
    }

    this.starting = true;
    this.startingSince = this.now();
    this.startError = null;
    this.notice = null;
    try {
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
        this.starting = false;
        this.startingSince = null;
        const message =
          `the start preflight did not finish within ${this.preflightTimeoutMs} ms; ` +
          "press Start to retry.";
        this.startError = message;
        return { ok: false, message };
      }
      if (!result.ok) {
        this.starting = false;
        this.startingSince = null;
        this.startError = result.message;
        return { ok: false, message: result.message };
      }
      return await this.spawn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.starting = false;
      this.startingSince = null;
      this.startError = message;
      return { ok: false, message };
    }
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

  private async spawn(): Promise<AgentCommandResult> {
    const argv = [
      process.execPath,
      join(this.harnessDir, "issues", "scout", "worker.ts"),
      "--repo",
      this.repoDir,
      "--state-dir",
      this.stateDir,
    ];
    let base: Record<string, string | undefined>;
    try {
      base = await this.agentEnvironment();
    } catch (error) {
      this.starting = false;
      this.startingSince = null;
      const message = error instanceof Error ? error.message : String(error);
      this.startError = message;
      return { ok: false, message };
    }
    const pid = this.spawnWorker(argv, {
      ...base,
      REPO_DIR: this.repoDir,
      STATE_DIR: this.stateDir,
      AGENT_COMMAND: this.agentCommand,
    });
    if (pid === undefined) {
      this.starting = false;
      this.startingSince = null;
      this.startError = "the Auto Scout worker could not be started";
      return { ok: false, message: this.startError };
    }
    return { ok: true };
  }

  /**
   * Saves the cadence and both caps as one settings write. The settings file is
   * the durable source, so a save shows after a reload and is read by the next
   * worker start; a running worker applies it immediately through its command
   * channel.
   */
  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult {
    if (!isValidCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidLimit(maxPerHour) || !isValidLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    const state = this.currentState();
    const settings = this.settings(state);
    try {
      writeSettings(settingsPath(this.stateDir, this.repoDir), {
        ...settings,
        intervalMinutes: minutes,
        maxPerHour,
        maxPending,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not save the settings: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      for (const owner of this.owners()) {
        writeCommand(this.controlFor(owner), {
          type: "settings",
          intervalMinutes: minutes,
          maxPerHour,
          maxPending,
        });
      }
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach the worker: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.startError = null;
    this.refresh();
    return { ok: true };
  }

  stop(): AgentCommandResult {
    const owners = this.owners();
    if (owners.length === 0) {
      const foreign = this.allOwners()[0];
      if (foreign !== undefined) {
        return {
          ok: false,
          message:
            `the Auto Scout worker (pid ${foreign.pid}) uses ${foreign.stateDir}; this dashboard's ` +
            `STATE_DIR is ${this.stateDir}`,
        };
      }
      return { ok: false, message: "No Auto Scout worker is running for this checkout." };
    }
    try {
      for (const owner of owners) writeCommand(this.controlFor(owner), { type: "stop" });
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach the worker: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.stopRequested = true;
    this.startError = null;
    for (const owner of owners) this.scheduleStopProof(owner.pid);
    return { ok: true };
  }

  /**
   * Stop must end a worker that is still alive after the command. Only a
   * process the table proves is this checkout's scout is signalled.
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
    if (!argv.some((entry) => entry.endsWith(join("scout", "worker.ts")))) return false;
    if (!argv.includes(this.repoDir)) return false;
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === this.canonicalRepoDir;
    } catch {
      return false;
    }
  }
}

function projectIssue(issue: ScoutIssueRow): {
  title: string;
  category: string | null;
  filedAt: string;
  url: string;
  state: "pending" | "implemented";
  version: string | null;
} {
  return {
    title: issue.title,
    category: issue.category,
    filedAt: issue.createdAt,
    url: issue.url,
    state: issue.state,
    version: issue.version,
  };
}

function nextCadenceAt(lastRunAt: string | null, minutes: number): string | null {
  if (lastRunAt === null) return null;
  const started = Date.parse(lastRunAt);
  if (!Number.isFinite(started)) return null;
  return new Date(started + minutes * 60_000).toISOString();
}

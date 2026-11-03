import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwners, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  cycleDirectory,
  lockPath,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/consistent-naming/paths";
import { writeCommand } from "../issues/consistent-naming/control";
import {
  preflightConsistentNaming,
  type ConsistentNamingPreflightResult,
} from "../issues/consistent-naming/preflight";
import { cachedRepository } from "../issues/repository";
import {
  DEFAULT_SETTINGS,
  isValidCadence,
  isValidLimit,
  readSettings,
  readState,
  writeSettings,
  type ConsistentNamingIssueRow,
  type ConsistentNamingSettings,
  type ConsistentNamingState,
} from "../issues/consistent-naming/state";
import { readActivity } from "../issues/state";
import { activityDelta } from "./activity";
import { canonicalProcessPath } from "./state";
import { hostHarnessDir, readHarnessVersion } from "./version";
import { AgentForgeState } from "./agents/forge-state";
import { createForgeIssueReader, type ForgeIssueReader } from "./agents/forge-reader";
import { projectAgentSnapshot, type AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";
import type { AgentDescriptor } from "./agents/registry";
import { supervisedDetach } from "../watchdog/supervision";

/**
 * The dashboard half of Consistent Naming. It never owns an audit loop or a lock:
 * it reads the worker's published board, replays its newest cycle's activity,
 * and writes commands for Start, Stop, cadence, and limits.
 */

const STOP_PROOF_MS = 3_000;
const STOP_KILL_GRACE_MS = 2_000;
const STOP_DEADLINE_MS = STOP_PROOF_MS + STOP_KILL_GRACE_MS;
const STOP_POLL_MS = 50;
const START_PROOF_MS = 5_000;
/** A page open asks the attached worker for one fresh read at most this often. */
const SYNC_REQUEST_MIN_INTERVAL_MS = 5_000;

export interface ConsistentNamingBridgeOptions {
  descriptor: AgentDescriptor;
  repoDir: string;
  stateDir: string;
  agentCommand: string;
  agentEnvironment: () => Promise<Record<string, string | undefined>>;
  runningVersion: string | null;
  harnessDir: string;
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  log?: (line: string) => void;
  environment?: Record<string, string | undefined>;
  pollMs?: number;
  /** Injectable forge read; production reads the origin's issue state. */
  reader?: ForgeIssueReader;
  /** True while at least one dashboard client is connected. */
  hasClients?: () => boolean;
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<ConsistentNamingPreflightResult>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  now?: () => number;
}

export class ConsistentNamingBridge implements AgentAdapter {
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
  private readonly preflight: NonNullable<ConsistentNamingBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<ConsistentNamingBridgeOptions["spawnWorker"]>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;
  private readonly now: () => number;

  private timer: Timer | undefined;
  private lastActivityCycleId: string | null = null;
  private lastActivity: string[] = [];
  private readonly stopping = new Map<number, { timer: Timer; killTimer?: Timer }>();
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private startTask: Promise<AgentCommandResult> | undefined;
  /** One automatic new-version start per dashboard lifetime. */
  private takeover: "idle" | "started" = "idle";
  private lastSyncRequestAt = Number.NEGATIVE_INFINITY;

  constructor(options: ConsistentNamingBridgeOptions) {
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
    this.preflight =
      options.preflight ??
      ((request) =>
        preflightConsistentNaming({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          environment: request.environment,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
    this.forge = new AgentForgeState({
      reader:
        options.reader ??
        createForgeIssueReader({
          repoDir: this.repoDir,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        }),
      urls: () => mergeIssues(this.allStates()).map((issue) => issue.url),
      hasClients: options.hasClients ?? (() => false),
      now: this.now,
      log: this.log,
    });
  }

  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.refresh(), this.pollMsValue);
    this.forge.begin();
    void this.refresh();
    void this.takeoverOldWorkers();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.forge.dispose();
    for (const pid of [...this.stopping.keys()]) this.clearStopProof(pid);
  }

  /**
   * Starts this version's worker when an older version's worker is live and
   * this process runs the newest harness. The older worker is told to drain:
   * it finishes its in-flight cycle, starts no new one, and exits on its own.
   */
  async takeoverOldWorkers(): Promise<void> {
    if (this.takeover === "started") return;
    this.takeover = "started";
    const owners = this.owners();
    if (owners.length === 0) return;
    const newest = readHarnessVersion(hostHarnessDir(this.repoDir));
    if (newest === null || newest !== this.runningVersion) return;
    if (owners.some((owner) => owner.harnessVersion === this.runningVersion)) return;
    const started = await this.spawn();
    if (!started.ok) {
      this.log(`could not start the ${this.runningVersion} consistent-naming worker: ${started.message}`);
      return;
    }
    for (const owner of owners) {
      if (owner.harnessVersion === this.runningVersion) continue;
      try {
        writeCommand(this.controlFor(owner), { type: "drain" });
      } catch (error) {
        this.log(
          `could not drain the ${owner.harnessVersion ?? "legacy"} consistent-naming worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private detach(argv: string[], environment: Record<string, string | undefined>): number | undefined {
    return supervisedDetach(argv, {
      cwd: this.repoDir,
      env: environment,
      stateDir: this.stateDir,
      onError: (error) => {
        this.log(
          `could not start the consistent-naming worker: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  /** Owners of every live lock beside this checkout's legacy lock. */
  private owners(): LockOwner[] {
    return liveLockOwners(lockPath(this.repoDir));
  }

  /** Every readable worker state: the legacy file and each version's file. */
  private allStates(): ConsistentNamingState[] {
    const states: ConsistentNamingState[] = [];
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

  /** The published state one live owner wrote, when it is readable. */
  private stateForOwner(owner: LockOwner): ConsistentNamingState | undefined {
    return readState(
      owner.harnessVersion === null
        ? statePath(this.stateDir, this.repoDir)
        : versionedStatePath(this.stateDir, this.repoDir, owner.harnessVersion),
    );
  }

  /** The control directory one live owner consumes, versioned or legacy. */
  private controlFor(owner: LockOwner): string {
    return owner.harnessVersion === null
      ? controlDirectory(this.stateDir, this.repoDir)
      : versionedControlDirectory(this.stateDir, this.repoDir, owner.harnessVersion);
  }

  private settings(state: ConsistentNamingState | undefined): ConsistentNamingSettings {
    return (
      readSettings(settingsPath(this.stateDir, this.repoDir)) ?? {
        maxPerHour: state?.limits.maxPerHour ?? DEFAULT_SETTINGS.maxPerHour,
        maxPending: state?.limits.maxPending ?? DEFAULT_SETTINGS.maxPending,
        intervalMinutes: state?.intervalMinutes ?? DEFAULT_SETTINGS.intervalMinutes,
      }
    );
  }

  snapshot(): AgentSnapshotInput {
    this.forge.requestSync();
    const owners = this.owners();
    const attachedOwners = owners.filter(
      (owner) => resolve(owner.stateDir) === this.stateDir && pidAlive(owner.pid),
    );
    const foreign = owners.find((owner) => resolve(owner.stateDir) !== this.stateDir);
    const states = this.allStates();
    const byPid = new Map(
      states
        .filter((state) => state.worker !== null)
        .map((state) => [state.worker!.pid, state]),
    );
    const attachedStates = attachedOwners
      .map((owner) => byPid.get(owner.pid) ?? this.stateForOwner(owner))
      .filter((state): state is ConsistentNamingState => state !== undefined);
    const attached = attachedOwners.length > 0;
    const sorted = [...states].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active =
      attachedStates.find((state) => state.lifecycle === "auditing") ??
      [...attachedStates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
      (attached ? undefined : sorted[0]);
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
      this.startError = "the Consistent Naming worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && attachedOwners.length === 0) this.stopRequested = false;
    if (foreign !== undefined) {
      this.notice =
        `this checkout already has a Consistent Naming worker (pid ${foreign.pid}) using ` +
        `${foreign.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
    } else if (this.notice !== null && this.notice.startsWith("this checkout already has")) {
      this.notice = null;
    }
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested && attached
        ? "stopping"
        : attached
          ? active?.lifecycle === "failed"
            ? "failed"
            : active?.lifecycle === "stopped"
              ? "stopped"
              : "running"
          : owners.length > 0
            ? "running"
            : active?.lifecycle === "failed" && active.enabled
              ? "failed"
              : "stopped";
    const settings = this.settings(active);
    const rows = mergeIssues(states)
      .filter((issue) => this.forge.reported(issue.url))
      .map((issue) => {
        const fact = this.forge.fact(issue.url);
        return fact === undefined
          ? projectIssue(issue)
          : {
              title: issue.title,
              category: issue.category,
              filedAt: issue.createdAt,
              url: issue.url,
              state: fact.state,
              version: fact.version,
            };
      });
    const cycleId = newestCycle(states);
    const lastRunAt =
      states
        .map((state) => state.lastCycleStartedAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    const workers = attachedOwners.map((owner) => {
      const state = byPid.get(owner.pid) ?? this.stateForOwner(owner);
      return {
        pid: owner.pid,
        version: owner.harnessVersion,
        stateDir: owner.stateDir,
        lifecycle: workerLifecycle(state),
      };
    });
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
      owned: attached,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt,
        nextRunAt: attached ? (active?.nextAttemptAt ?? null) : null,
      },
      limits: { maxPerHour: settings.maxPerHour, maxPending: settings.maxPending },
      issues: rows,
      pending: rows.filter((issue) => issue.state === "pending").length,
      sync: this.forge.sync,
      detail: { panel: "activity", scanId: cycleId, entries: [...this.lastActivity] },
      notice: this.notice ?? active?.notice ?? null,
      error: this.startError ?? active?.lastError ?? null,
      timer: null,
      workers,
    };
  }

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
    const cycleId = this.lastActivityCycleId ?? newestCycle(this.allStates()) ?? null;
    if (cycleId === null) return;
    const activity = this.readActivity(cycleId);
    this.lastActivityCycleId = cycleId;
    this.lastActivity = activity;
    const event = {
      type: "agentActivity",
      id: this.descriptor.id,
      scanId: cycleId,
      replay: true,
      entries: activity.map((text) => ({ text, append: false })),
    };
    deliver(event);
    this.send(event, target);
  }

  /** A view opened this agent: read the forge now and ask the worker to read. */
  requestSync(): void {
    this.forge.requestSync();
    const owners = this.owners().filter((owner) => resolve(owner.stateDir) === this.stateDir);
    if (owners.length === 0) return;
    const now = this.now();
    if (now - this.lastSyncRequestAt < SYNC_REQUEST_MIN_INTERVAL_MS) return;
    this.lastSyncRequestAt = now;
    for (const owner of owners) {
      try {
        writeCommand(this.controlFor(owner), { type: "refresh" });
      } catch (error) {
        this.log(
          `could not request a consistent-naming read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Resolves after the read in flight, if any, has settled. */
  settled(): Promise<void> {
    return this.forge.settled();
  }

  private readActivity(cycleId: string): string[] {
    return readActivity(cycleDirectory(this.repoDir, cycleId));
  }

  private publishActivity(cycleId: string, activity: string[]): void {
    if (this.lastActivityCycleId !== cycleId) {
      this.lastActivityCycleId = cycleId;
      this.lastActivity = activity;
      this.send({
        type: "agentActivity",
        id: this.descriptor.id,
        scanId: cycleId,
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
      scanId: cycleId,
      ...(delta.replay ? { replay: true } : {}),
      entries: delta.entries,
    });
  }

  refresh(): void {
    const snapshot = this.snapshot();
    const cycleId = snapshot.detail.panel === "activity" ? snapshot.detail.scanId : null;
    if (cycleId === null) {
      this.lastActivityCycleId = null;
      this.lastActivity = [];
      return;
    }
    this.publishActivity(cycleId, this.readActivity(cycleId));
  }

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
      const owners = this.owners();
      if (owners.length === 0) break;
      const foreign = owners.find((owner) => resolve(owner.stateDir) !== this.stateDir);
      if (foreign !== undefined) {
        this.notice =
          `this checkout already has a Consistent Naming worker (pid ${foreign.pid}) using ` +
          `${foreign.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
        return { ok: true, notice: this.notice };
      }
      const stopping = [...this.stopping.keys()];
      const live = owners.filter((owner) => !stopping.includes(owner.pid));
      if (live.length > 0) {
        this.refresh();
        return { ok: true };
      }
      const waits = await Promise.all(stopping.map((pid) => this.waitForStop(pid)));
      if (waits.some((stopped) => !stopped)) {
        return {
          ok: false,
          message:
            `the previous Consistent Naming worker (pid ${stopping.join(", ")}) is still stopping; ` +
            "press Start once it has exited.",
        };
      }
    }

    this.starting = true;
    this.startingSince = this.now();
    this.startError = null;
    this.notice = null;
    try {
      const result = await this.preflight({
        repoDir: this.repoDir,
        stateDir: this.stateDir,
        environment: this.environment,
      });
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

  private async waitForStop(pid: number): Promise<boolean> {
    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (pidAlive(pid) && Date.now() < deadline) {
      const { promise, resolve: settle } = Promise.withResolvers<void>();
      setTimeout(settle, STOP_POLL_MS);
      await promise;
    }
    return !pidAlive(pid);
  }

  private async spawn(): Promise<AgentCommandResult> {
    const argv = [
      process.execPath,
      join(this.harnessDir, "issues", "consistent-naming", "worker.ts"),
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
      this.startError = "the Consistent Naming worker could not be started";
      return { ok: false, message: this.startError };
    }
    return { ok: true };
  }

  setSettings(
    minutes: unknown,
    maxPerHour: unknown,
    maxPending: unknown,
  ): AgentCommandResult {
    if (!isValidCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidLimit(maxPerHour) || !isValidLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    try {
      writeSettings(settingsPath(this.stateDir, this.repoDir), {
        maxPerHour,
        maxPending,
        intervalMinutes: minutes,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not save the settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    for (const owner of this.owners()) {
      if (resolve(owner.stateDir) !== this.stateDir) continue;
      try {
        writeCommand(this.controlFor(owner), {
          type: "settings",
          intervalMinutes: minutes,
          maxPerHour,
          maxPending,
        });
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    this.startError = null;
    this.refresh();
    return { ok: true };
  }

  stop(): AgentCommandResult {
    const owners = this.owners();
    if (owners.length === 0) {
      return { ok: false, message: "No Consistent Naming worker is running for this checkout." };
    }
    const foreign = owners.find((owner) => resolve(owner.stateDir) !== this.stateDir);
    if (foreign !== undefined) {
      return {
        ok: false,
        message:
          `the Consistent Naming worker (pid ${foreign.pid}) uses ${foreign.stateDir}; this dashboard's ` +
          `STATE_DIR is ${this.stateDir}`,
      };
    }
    for (const owner of owners) {
      try {
        writeCommand(this.controlFor(owner), { type: "stop" });
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the worker: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    this.stopRequested = true;
    this.startError = null;
    for (const owner of owners) this.scheduleStopProof(owner.pid);
    return { ok: true };
  }

  private scheduleStopProof(pid: number): void {
    this.clearStopProof(pid);
    const prove = (): void => {
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
      const killTimer = setTimeout(() => {
        if (!pidAlive(pid) || !this.provesWorker(pid)) {
          this.clearStopProof(pid);
          return;
        }
        if (this.stopping.get(pid) === undefined) return;
        this.clearStopProof(pid);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It exited between the proof and the signal.
        }
      }, STOP_KILL_GRACE_MS);
      killTimer.unref?.();
      const proof = this.stopping.get(pid);
      if (proof !== undefined) proof.killTimer = killTimer;
    };
    const timer = setTimeout(prove, STOP_PROOF_MS);
    timer.unref?.();
    this.stopping.set(pid, { timer });
  }

  private clearStopProof(pid: number): void {
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
    if (!argv.some((entry) => entry.endsWith(join("consistent-naming", "worker.ts")))) return false;
    if (!argv.includes(this.repoDir)) return false;
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === this.canonicalRepoDir;
    } catch {
      return false;
    }
  }
}

/** Every worker's filed issues, newest state first, deduplicated by URL. */
function mergeIssues(states: readonly ConsistentNamingState[]): ConsistentNamingIssueRow[] {
  const rows = new Map<string, ConsistentNamingIssueRow>();
  const ordered = [...states].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const state of ordered) {
    for (const issue of state.issues) {
      const key = issue.url.length > 0 ? issue.url : issue.title;
      if (!rows.has(key)) rows.set(key, issue);
    }
  }
  return [...rows.values()];
}

/** The newest cycle id any worker published; ids begin with their timestamp. */
function newestCycle(states: readonly ConsistentNamingState[]): string | null {
  let newest: string | null = null;
  for (const state of states) {
    const id = state.newestCycleId;
    if (id !== null && (newest === null || id.localeCompare(newest) > 0)) newest = id;
  }
  return newest;
}

function workerLifecycle(
  state: ConsistentNamingState | undefined,
): "running" | "stopping" | "stopped" | "failed" {
  if (state === undefined) return "running";
  if (state.lifecycle === "stopped") return "stopped";
  if (state.lifecycle === "failed") return "failed";
  if (state.draining) return "stopping";
  return "running";
}

function projectIssue(issue: ConsistentNamingIssueRow): {
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

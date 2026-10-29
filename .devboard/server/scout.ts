import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwner, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  lockPath,
  scanDirectory,
  settingsPath,
  statePath,
} from "../issues/scout/paths";
import { writeCommand, type ScoutCommand } from "../issues/scout/control";
import { preflightScout, type ScoutPreflightResult } from "../issues/scout/preflight";
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
  type ScoutSync,
} from "../issues/scout/state";
import { readActivity } from "../issues/state";
import { activityDelta } from "./activity";
import { projectAgentSnapshot, type AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";
import type { AgentDescriptor } from "./agents/registry";

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
  /** Test seams: replace the start preflight and the detached spawn. */
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<ScoutPreflightResult>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  now?: () => number;
}

/** How long a spawned worker may take to publish its lock before Start fails. */
const START_PROOF_MS = 5_000;

export class ScoutBridge implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly agentCommand: string;
  private readonly agentEnvironment: () => Promise<Record<string, string | undefined>>;
  private readonly runningVersion: string | null;
  private readonly harnessDir: string;
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly environment: Record<string, string | undefined>;
  private readonly repository: () => string | null;
  private readonly preflight: NonNullable<ScoutBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<ScoutBridgeOptions["spawnWorker"]>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;
  private readonly now: () => number;

  private timer: Timer | undefined;
  private lastActivityScanId: string | null = null;
  private lastActivity: string[] = [];
  private stopping: { pid: number; timer: Timer; killTimer?: Timer } | undefined;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private startTask: Promise<AgentCommandResult> | undefined;

  constructor(options: ScoutBridgeOptions) {
    this.descriptor = options.descriptor;
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
    this.now = options.now ?? (() => Date.now());
    this.preflight =
      options.preflight ??
      ((request) =>
        preflightScout({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          environment: request.environment,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
  }

  /** Starts observing the worker state; it never starts a worker itself. */
  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.refresh(), this.pollMsValue);
    void this.refresh();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
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
      this.log(
        `could not start the scout worker: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  private currentState(): ScoutState | undefined {
    return readState(statePath(this.stateDir, this.repoDir));
  }

  private lockOwner(): LockOwner | undefined {
    return liveLockOwner(lockPath(this.repoDir));
  }

  private owned(owner: LockOwner | undefined): boolean {
    return owner !== undefined && resolve(owner.stateDir) === this.stateDir && pidAlive(owner.pid);
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

  /** True when there is a worker state or a live lock to replay. */
  get present(): boolean {
    return this.currentState() !== undefined || this.lockOwner() !== undefined;
  }

  snapshot(): AgentSnapshotInput {
    const state = this.currentState();
    const owner = this.lockOwner();
    const attached = this.owned(owner);
    const active = attached ? state : undefined;
    if (this.starting && owner !== undefined) {
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
    if (this.stopRequested && owner === undefined) this.stopRequested = false;
    if (owner !== undefined && !this.owned(owner)) {
      this.notice =
        `this checkout already has an Auto Scout worker (pid ${owner.pid}) using ` +
        `${owner.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
    } else if (this.notice !== null && this.notice.startsWith("this checkout already has")) {
      this.notice = null;
    }

    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested
        ? "stopping"
        : attached
          ? active?.lifecycle === "idle" || active?.lifecycle === "scanning"
            ? "running"
            : active?.lifecycle === "failed"
              ? "failed"
              : active?.lifecycle === "stopped"
                ? "stopped"
                : "running"
          : owner !== undefined
            ? "running"
            : state?.lifecycle === "failed" && state.enabled
              ? "failed"
              : "stopped";
    const settings = this.settings(state);
    const worker = state?.worker ?? null;
    const mismatch =
      attached && worker !== null && worker.harnessVersion !== this.runningVersion
        ? `Auto Scout worker ${worker.harnessVersion ?? "unknown"} is running; this dashboard ` +
          `loaded ${this.runningVersion ?? "unknown"}. It is left running; Stop it to launch the ` +
          "current harness on the next Start."
        : null;
    const lastRunAt =
      state?.lastScanStartedAt ?? active?.scan?.startedAt ?? null;
    const nextRunAt = attached
      ? (state?.nextAttemptAt ?? nextCadenceAt(lastRunAt, settings.intervalMinutes))
      : null;
    const issues = state?.issues ?? [];
    const sync: ScoutSync = state?.sync ?? { state: "stale", at: null, error: null };
    const scanId = state?.scan?.scanId ?? state?.newestScanId ?? null;
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
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
      issues: issues.map(projectIssue),
      pending: issues.filter((issue) => issue.state === "pending").length,
      sync,
      detail: {
        panel: "activity",
        scanId,
        entries: [...this.lastActivity],
      },
      notice: mismatch ?? this.notice ?? active?.notice ?? null,
      error: this.startError ?? active?.lastError ?? null,
      timer: null,
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
    const state = this.currentState();
    deliver({
      type: "agentState",
      agent: projectAgentSnapshot(this.descriptor, this.snapshot()),
    });
    const scanId = this.lastActivityScanId ?? state?.scan?.scanId ?? state?.newestScanId ?? null;
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
      const owner = this.lockOwner();
      if (owner === undefined) break;
      if (!this.owned(owner)) {
        this.notice =
          `this checkout already has an Auto Scout worker (pid ${owner.pid}) using ` +
          `${owner.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
        return { ok: true, notice: this.notice };
      }
      // A live owner that this bridge has told to stop is not attachable: the
      // worker is already ending, so report its state only after it has exited
      // and the new spawn holds the lock.
      if (this.stopping === undefined || this.stopping.pid !== owner.pid) {
        this.refresh();
        return { ok: true };
      }
      if (!(await this.waitForStop(owner.pid))) {
        return {
          ok: false,
          message:
            `the previous Auto Scout worker (pid ${owner.pid}) is still stopping; ` +
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
    const owner = this.lockOwner();
    if (this.owned(owner)) {
      try {
        writeCommand(controlDirectory(this.stateDir, this.repoDir), {
          type: "settings",
          intervalMinutes: minutes,
          maxPerHour,
          maxPending,
        });
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the worker: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    this.startError = null;
    this.refresh();
    return { ok: true };
  }

  stop(): AgentCommandResult {
    const owner = this.lockOwner();
    if (owner === undefined) {
      return { ok: false, message: "No Auto Scout worker is running for this checkout." };
    }
    if (!this.owned(owner)) {
      return {
        ok: false,
        message:
          `the Auto Scout worker (pid ${owner.pid}) uses ${owner.stateDir}; this dashboard's ` +
          `STATE_DIR is ${this.stateDir}`,
      };
    }
    try {
      writeCommand(controlDirectory(this.stateDir, this.repoDir), { type: "stop" });
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach the worker: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.stopRequested = true;
    this.startError = null;
    this.scheduleStopProof(owner.pid);
    return { ok: true };
  }

  /**
   * Stop must end a worker that is still alive after the command. Only a
   * process the table proves is this checkout's scout is signalled.
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
    if (!argv.some((entry) => entry.endsWith(join("scout", "worker.ts")))) return false;
    if (!argv.includes(this.repoDir)) return false;
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === this.repoDir;
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

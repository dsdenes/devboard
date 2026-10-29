import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwner, pidAlive, type LockOwner } from "../issues/lock";
import {
  controlDirectory,
  lockPath,
  cycleDirectory,
  designConfig,
  settingsPath,
  statePath,
} from "../issues/design/paths";
import { writeCommand } from "../issues/design/control";
import { preflightDesign, type DesignPreflightResult } from "../issues/design/preflight";
import { cachedRepository } from "../issues/repository";
import {
  DEFAULT_SETTINGS,
  isValidCadence,
  isValidLimit,
  readSettings,
  readState,
  writeSettings,
  type DesignIssueRow,
  type DesignSettings,
  type DesignState,
  type DesignSync,
} from "../issues/design/state";
import { readActivity } from "../issues/state";
import { activityDelta } from "./activity";
import { projectAgentSnapshot, type AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";
import type { AgentDescriptor } from "./agents/registry";

/**
 * The dashboard half of Design System. It never owns an audit loop or a lock:
 * it reads the worker's published board, replays its newest cycle's activity,
 * and writes commands for Start, Stop, cadence, and limits.
 */

const STOP_PROOF_MS = 3_000;
const STOP_KILL_GRACE_MS = 2_000;
const STOP_DEADLINE_MS = STOP_PROOF_MS + STOP_KILL_GRACE_MS;
const STOP_POLL_MS = 50;
const START_PROOF_MS = 5_000;

export interface DesignBridgeOptions {
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
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    config: ReturnType<typeof designConfig>;
    environment: Record<string, string | undefined>;
  }) => Promise<DesignPreflightResult>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  now?: () => number;
}

export class DesignBridge implements AgentAdapter {
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
  private readonly preflight: NonNullable<DesignBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<DesignBridgeOptions["spawnWorker"]>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;
  private readonly now: () => number;

  private timer: Timer | undefined;
  private lastActivityCycleId: string | null = null;
  private lastActivity: string[] = [];
  private stopping: { pid: number; timer: Timer; killTimer?: Timer } | undefined;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private startTask: Promise<AgentCommandResult> | undefined;

  constructor(options: DesignBridgeOptions) {
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
        preflightDesign({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          config: request.config,
          environment: request.environment,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
  }

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
        `could not start the design worker: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private currentState(): DesignState | undefined {
    return readState(statePath(this.stateDir, this.repoDir));
  }

  private lockOwner(): LockOwner | undefined {
    return liveLockOwner(lockPath(this.repoDir));
  }

  private owned(owner: LockOwner | undefined): boolean {
    return owner !== undefined && resolve(owner.stateDir) === this.stateDir && pidAlive(owner.pid);
  }

  private settings(state: DesignState | undefined): DesignSettings {
    return (
      readSettings(settingsPath(this.stateDir, this.repoDir)) ?? {
        maxPerHour: state?.limits.maxPerHour ?? DEFAULT_SETTINGS.maxPerHour,
        maxPending: state?.limits.maxPending ?? DEFAULT_SETTINGS.maxPending,
        intervalMinutes: state?.intervalMinutes ?? DEFAULT_SETTINGS.intervalMinutes,
      }
    );
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
      this.startError = "the Design System worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && owner === undefined) this.stopRequested = false;
    if (owner !== undefined && !this.owned(owner)) {
      this.notice =
        `this checkout already has a Design System worker (pid ${owner.pid}) using ` +
        `${owner.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
    } else if (this.notice !== null && this.notice.startsWith("this checkout already has")) {
      this.notice = null;
    }
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested
        ? "stopping"
        : attached
          ? active?.lifecycle === "failed"
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
        ? `Design System worker ${worker.harnessVersion ?? "unknown"} is running; this dashboard ` +
          `loaded ${this.runningVersion ?? "unknown"}. It is left running; Stop it to launch the ` +
          "current harness on the next Start."
        : null;
    const issues = state?.issues ?? [];
    const sync: DesignSync = state?.sync ?? { state: "stale", at: null, error: null };
    const cycleId = state?.newestCycleId ?? null;
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
      owned: attached,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt: state?.lastCycleStartedAt ?? null,
        nextRunAt: attached ? (state?.nextAttemptAt ?? null) : null,
      },
      limits: { maxPerHour: settings.maxPerHour, maxPending: settings.maxPending },
      issues: issues.map(projectIssue),
      pending: issues.filter((issue) => issue.state === "pending").length,
      sync,
      detail: { panel: "activity", scanId: cycleId, entries: [...this.lastActivity] },
      notice: mismatch ?? this.notice ?? state?.notice ?? null,
      error: this.startError ?? state?.lastError ?? null,
      timer: null,
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
    const state = this.currentState();
    const cycleId = this.lastActivityCycleId ?? state?.newestCycleId ?? null;
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
      const owner = this.lockOwner();
      if (owner === undefined) break;
      if (!this.owned(owner)) {
        this.notice =
          `this checkout already has a Design System worker (pid ${owner.pid}) using ` +
          `${owner.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`;
        return { ok: true, notice: this.notice };
      }
      if (this.stopping === undefined || this.stopping.pid !== owner.pid) {
        this.refresh();
        return { ok: true };
      }
      if (!(await this.waitForStop(owner.pid))) {
        return {
          ok: false,
          message:
            `the previous Design System worker (pid ${owner.pid}) is still stopping; ` +
            "press Start once it has exited.",
        };
      }
    }

    this.starting = true;
    this.startingSince = this.now();
    this.startError = null;
    this.notice = null;
    try {
      const config = designConfig(this.environment);
      const result = await this.preflight({
        repoDir: this.repoDir,
        stateDir: this.stateDir,
        config,
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
      join(this.harnessDir, "issues", "design", "worker.ts"),
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
      this.startError = "the Design System worker could not be started";
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
    const owner = this.lockOwner();
    if (owner === undefined) {
      return { ok: false, message: "No Design System worker is running for this checkout." };
    }
    if (!this.owned(owner)) {
      return {
        ok: false,
        message:
          `the Design System worker (pid ${owner.pid}) uses ${owner.stateDir}; this dashboard's ` +
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

  private scheduleStopProof(pid: number): void {
    if (this.stopping !== undefined) this.clearStopProof(this.stopping.pid);
    const prove = (): void => {
      if (!pidAlive(pid) || !this.provesWorker(pid)) {
        this.clearStopProof(pid);
        return;
      }
      const proof = this.stopping;
      if (proof === undefined || proof.pid !== pid) return;
      if (this.currentState()?.lifecycle === "releasing") {
        // A release that already pushed must finish its workflow wait, its
        // publish, and its worktree cleanup. The worker is stopping and exits
        // by itself once the release settles; never signal it in between.
        proof.timer = setTimeout(prove, STOP_PROOF_MS);
        proof.timer.unref?.();
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
        if (this.stopping !== proof) return;
        if (this.currentState()?.lifecycle === "releasing") {
          // The release began after the signal; wait for it instead of
          // killing the worker between its push and its publish.
          proof.killTimer = undefined;
          proof.timer = setTimeout(prove, STOP_PROOF_MS);
          proof.timer.unref?.();
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
    if (!argv.some((entry) => entry.endsWith(join("design", "worker.ts")))) return false;
    if (!argv.includes(this.repoDir)) return false;
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === this.repoDir;
    } catch {
      return false;
    }
  }
}

function projectIssue(issue: DesignIssueRow): {
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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwners, type LockOwner } from "../issues/lock";
import { ghCommand } from "../issues/scout/preflight";
import { configuredGiteaToken, giteaBaseUrl } from "../lib/forge";
import { giteaRepository } from "../lib/gitea";
import { findOnPath, originForge, rootProblem } from "../issues/repository";
import type { WatchdogCycle } from "../watchdog/history";
import { readWatchdogStatus, type WatchdogIssue } from "../watchdog/status";
import { writeWatchdogCommand } from "../watchdog/control";
import { writeProjection } from "../watchdog/projection";
import {
  controlDirectory,
  lockPath,
  versionedControlDirectory,
  versionedWorkerDirectory,
  watchdogDirectory,
} from "../watchdog/paths";
import { readWatchdogSettings, writeWatchdogSettings } from "../watchdog/settings";
import {
  readNewestWorkerState,
  readWorkerState,
  readWorkerStates,
  type WatchdogWorkerState,
} from "../watchdog/worker-state";
import { hostHarnessDir, readHarnessVersion } from "./version";
import { AgentForgeState } from "./agents/forge-state";
import {
  createForgeIssueReader,
  type ForgeIssueReader,
  type ForgeIssueState,
} from "./agents/forge-reader";
import type { AgentDescriptor, AgentSnapshotInput, AgentSync } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";

/**
 * The Issues-mode watchdog page's server half. It reads the watchdog's local
 * facts on every request and overlays a GitHub projection that is refreshed in
 * the background at most once per interval. A request is never held open for
 * `gh`, and a failed read keeps the last known state and version for every
 * issue instead of inventing one.
 */

export interface WatchdogIssueRow extends WatchdogIssue {
  /** `null` until a forge read has answered for this issue. */
  state: ForgeIssueState | null;
  /** The earliest published release that shipped the closing commit. */
  version: string | null;
}

export interface WatchdogSnapshot {
  cycle: string | null;
  action: string;
  reason?: string;
  findings: number;
  issues: WatchdogIssueRow[];
  pending: number;
  cycles: WatchdogCycle[];
  sync: AgentSync;
}

/** A systemd command result, injectable for the timer gate's tests. */
export interface WatchdogCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WatchdogActivityOptions {
  descriptor: AgentDescriptor;
  /** The canonical host root; every runtime path is anchored here. */
  repoDir: string;
  /** Test seam; production derives it from the root. */
  watchdogDir?: string;
  /** This dashboard's STATE_DIR, which decides whether it owns the worker. */
  stateDir: string;
  harnessDir: string;
  /** The harness version this dashboard loaded, for parallel-worker takeover. */
  runningVersion?: string | null;
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  reader?: ForgeIssueReader;
  /** True while at least one dashboard client is connected. */
  hasClients?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  environment?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Test seams. */
  preflight?: (options: {
    repoDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  systemctl?: (args: string[]) => WatchdogCommandResult;
}

/** How long a spawned worker may take to publish its state before Start fails. */
const START_PROOF_MS = 5_000;
/**
 * How long Stop leaves a live worker alone to finish its cycle and publish
 * stopped before the proof escalates. A cycle may wait on forge calls, so this
 * is far longer than the worker's control poll.
 */
const STOP_CYCLE_GRACE_MS = 10 * 60_000;
/** How long a signalled worker may take to publish stopped before SIGKILL. */
const STOP_KILL_GRACE_MS = 2_000;
/** The timer gate is re-read in the background at most this often. */
const TIMER_REFRESH_MS = 5_000;

function firstLineOf(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The identity a legacy owner's state publishes for its control directory. */
function legacyControlKey(pid: number, version: string | null): string {
  return `${pid}:${version ?? "unknown"}`;
}

function watchdogIssueTitle(issue: WatchdogIssue): string {
  return `[watchdog] ${issue.category}: ${issue.line}`;
}

/**
 * The Watchdog page's server half and the adapter behind the shared background
 * agent contract. It reads the root-anchored worker state and ledger, overlays
 * the GitHub projection refreshed in the background, and starts or stops the
 * detached worker. It never holds a request open for `gh`.
 */
export class WatchdogActivity implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly watchdogDir: string;
  private readonly harnessDir: string;
  /** The harness version this dashboard loaded, for parallel-worker takeover. */
  private readonly runningVersion: string | null;
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly forge: AgentForgeState;
  private readonly now: () => number;
  private readonly environment: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly preflight: NonNullable<WatchdogActivityOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<WatchdogActivityOptions["spawnWorker"]>;
  private readonly systemctl: NonNullable<WatchdogActivityOptions["systemctl"]>;

  private timerGate: AgentSnapshotInput["timer"] = null;
  private timer: Timer | undefined;
  private timerReadAt = 0;
  private timerReading = false;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private stopping: { pids: number[]; timer: Timer } | undefined;
  /** One automatic new-version start per dashboard lifetime. */
  private takeover: "idle" | "started" = "idle";
  /** Legacy workers whose published state proves they read the legacy control dir. */
  private readonly legacyControlKeys = new Set<string>();

  constructor(options: WatchdogActivityOptions) {
    this.descriptor = options.descriptor;
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.watchdogDir = resolve(options.watchdogDir ?? watchdogDirectory(this.repoDir));
    this.harnessDir = options.harnessDir;
    this.runningVersion = options.runningVersion ?? null;
    this.send = options.send;
    this.now = options.now ?? (() => Date.now());
    this.environment = options.environment ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.forge = new AgentForgeState({
      reader:
        options.reader ??
        createForgeIssueReader({
          repoDir: this.repoDir,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        }),
      urls: () => readWatchdogStatus(this.watchdogDir).issues.map((issue) => issue.url),
      hasClients: options.hasClients ?? (() => false),
      now: this.now,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      onRead: () => {
        if (this.shouldPersistProjection()) this.persistProjection();
      },
      log: this.log,
    });
    this.preflight = options.preflight ?? ((request) => preflightWatchdog(request));
    this.spawnWorker =
      options.spawnWorker ??
      ((argv, environment) => {
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
            `could not start the watchdog worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      });
    this.systemctl = options.systemctl ?? defaultSystemctl;
  }

  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.refreshTimer(false);
    }, Math.max(50, Math.min(TIMER_REFRESH_MS, 1_000)));
    this.forge.begin();
    void this.refreshTimer(true);
    void this.takeoverOldWorkers();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.forge.dispose();
    this.clearStopProof();
  }

  /**
   * Starts this version's worker when an older version's worker is live and
   * this process is the newest harness. The older worker is told to drain: it
   * finishes the in-flight cycle, starts no new one, and exits on its own.
   */
  private async takeoverOldWorkers(): Promise<void> {
    if (this.takeover === "started") return;
    this.takeover = "started";
    const owners = this.owners().filter((owner) => !this.foreignOwner(owner));
    if (owners.length === 0) return;
    const newest = readHarnessVersion(hostHarnessDir(this.repoDir));
    if (newest === null || newest !== this.runningVersion) return;
    if (owners.some((owner) => owner.harnessVersion === this.runningVersion)) return;
    const pid = this.spawnNewest();
    if (pid === undefined) {
      this.log(`could not start the ${this.runningVersion} watchdog worker`);
      return;
    }
    for (const owner of owners) {
      if (owner.harnessVersion === this.runningVersion) continue;
      try {
        writeWatchdogCommand(this.controlFor(owner), { type: "drain" });
      } catch (error) {
        this.log(
          `could not drain the ${owner.harnessVersion ?? "legacy"} watchdog worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Spawns the newest harness's worker for this root. */
  private spawnNewest(): number | undefined {
    const argv = [
      process.execPath,
      join(this.harnessDir, "watchdog", "worker.ts"),
      "--root",
      this.repoDir,
      "--state-dir",
      this.watchdogDir,
      "--owner-state-dir",
      this.stateDir,
    ];
    return this.spawnWorker(argv, { ...this.environment, REPO_DIR: this.repoDir });
  }

  /** Every live worker: versioned locks first, then a legacy state-only owner. */
  private owners(): LockOwner[] {
    const owners = liveLockOwners(lockPath(this.watchdogDir));
    const legacy = readWorkerState(this.watchdogDir);
    if (legacy === undefined || legacy.lifecycle === "stopped" || !processAlive(legacy.pid)) {
      return owners;
    }
    // The older harness wrote a pid-only lock that cannot be parsed as the
    // shared owner format; its published state is the remaining proof, and it
    // tells this bridge which control directory that worker reads.
    this.legacyControlKeys.add(legacyControlKey(legacy.pid, legacy.harnessVersion));
    if (
      !owners.some(
        (owner) => owner.pid === legacy.pid && owner.harnessVersion === legacy.harnessVersion,
      )
    ) {
      owners.push({
        pid: legacy.pid,
        startedAt: legacy.startedAt,
        repo: legacy.root,
        stateDir: legacy.stateDir,
        harnessVersion: legacy.harnessVersion,
        argv: legacy.argv,
      });
    }
    return owners;
  }

  /** True for a live owner this dashboard's STATE_DIR does not own. */
  private foreignOwner(owner: LockOwner): boolean {
    return resolve(owner.stateDir) !== this.stateDir;
  }

  /** The control directory one live owner consumes, versioned or legacy. */
  private controlFor(owner: LockOwner): string {
    if (
      owner.harnessVersion !== null &&
      !this.legacyControlKeys.has(legacyControlKey(owner.pid, owner.harnessVersion))
    ) {
      return versionedControlDirectory(this.watchdogDir, owner.harnessVersion);
    }
    return controlDirectory(this.watchdogDir);
  }

  /** The published state one live owner wrote, when it is readable. */
  private stateForOwner(owner: LockOwner): WatchdogWorkerState | undefined {
    if (owner.harnessVersion !== null) {
      const state = readWorkerState(
        versionedWorkerDirectory(this.watchdogDir, owner.harnessVersion),
      );
      if (state !== undefined && state.pid === owner.pid) return state;
    }
    const legacy = readWorkerState(this.watchdogDir);
    return legacy !== undefined && legacy.pid === owner.pid ? legacy : undefined;
  }

  /** Awaits the background projection refresh a snapshot scheduled. */
  settled(): Promise<void> {
    return this.forge.settled();
  }

  replay(_target: { send(data: string): unknown }): void {
    // Watchdog activity is the retained cycle history carried by the snapshot.
  }

  /** A view opened this agent: read the forge now when the cadence allows. */
  requestSync(): void {
    this.forge.requestSync();
  }

  /**
   * A fresh host writes no watchdog file until a worker has run or a cap is
   * set, so a reset never stages a projection the operator did not create.
   */
  private shouldPersistProjection(): boolean {
    if (readWorkerStates(this.watchdogDir).length > 0) return true;
    const settings = readWatchdogSettings(this.watchdogDir);
    return settings.maxPerHour !== null || settings.maxPending !== null;
  }

  /** The worker enforces caps from this file; a failed read keeps the rows. */
  private persistProjection(): void {
    const sync = this.forge.sync;
    try {
      writeProjection(this.watchdogDir, {
        version: 1,
        state: sync.state,
        at: sync.at,
        error: sync.error,
        issues: [...this.forge.entries()].map(([url, fact]) => ({
          url,
          state: fact.state,
          version: fact.version,
        })),
      });
    } catch (error) {
      this.log(
        `could not persist the watchdog projection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  snapshot(): AgentSnapshotInput {
    this.forge.requestSync();
    const owners = this.owners();
    const own = owners.filter((owner) => !this.foreignOwner(owner));
    const foreign = owners.find((owner) => this.foreignOwner(owner));
    const attached = owners.length > 0;
    const owned = own.length > 0;
    const states = readWorkerStates(this.watchdogDir);
    const ownStates = own
      .map((owner) => this.stateForOwner(owner))
      .filter((state): state is WatchdogWorkerState => state !== undefined);
    const newest = readNewestWorkerState(this.watchdogDir);
    if (this.starting && attached) {
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
      this.startError = "the Watchdog worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && !attached) this.stopRequested = false;
    // A worker that published stopped needs no proof, even if its process is
    // still finishing its exit.
    if (!attached) this.clearStopProof();
    if (foreign !== undefined) {
      this.notice =
        `Watchdog is running for this root from another dashboard ` +
        `(STATE_DIR ${foreign.stateDir}).`;
    } else if (this.notice !== null && this.notice.startsWith("Watchdog is running")) {
      this.notice = null;
    }

    const status = readWatchdogStatus(this.watchdogDir);
    const settings = readWatchdogSettings(this.watchdogDir);
    // A running worker outranks one that is draining; both stay in `workers`
    // so the operator sees the whole takeover.
    const runningState = ownStates.find((state) => state.lifecycle === "running");
    const drainingState = ownStates.find((state) => state.lifecycle === "stopping");
    const active = runningState ?? drainingState ?? newest;
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested
        ? "stopping"
        : runningState !== undefined
          ? "running"
          : ownStates.some((state) => state.lifecycle === "stopping")
            ? "stopping"
          : attached
            ? ownStates.some((state) => state.lifecycle === "failed")
              ? "failed"
              : "running"
            : newest?.lifecycle === "failed"
              ? "failed"
              : "stopped";
    const issues: WatchdogIssueRow[] = status.issues
      .filter((issue) => this.forge.reported(issue.url))
      .map((issue) => {
        const fact = this.forge.fact(issue.url);
        return {
          ...issue,
          state: fact?.state ?? null,
          version: fact?.version ?? null,
        };
      });
    const lastRunAt =
      states
        .map((state) => state.lastRunAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? status.cycle;
    const workers: NonNullable<AgentSnapshotInput["workers"]> = own.map((owner) => {
      const state = this.stateForOwner(owner);
      return {
        pid: owner.pid,
        version: owner.harnessVersion,
        stateDir: owner.stateDir,
        lifecycle: state?.lifecycle ?? "running",
      };
    });
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
      owned,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt,
        nextRunAt: attached ? ((runningState ?? active)?.nextRunAt ?? null) : null,
      },
      limits: {
        maxPerHour: settings.maxPerHour,
        maxPending: settings.maxPending,
      },
      issues: issues.map((issue) => ({
        title: watchdogIssueTitle(issue),
        category: issue.category,
        filedAt: issue.filedAt,
        url: issue.url,
        state: issue.state ?? "unknown",
        version: issue.version,
      })),
      pending: status.pending,
      sync: this.forge.sync,
      detail: { panel: "cycles", cycles: status.cycles },
      notice: active?.notice ?? this.notice,
      error: this.startError ?? active?.lastError ?? null,
      timer: this.timerGate,
      workers,
    };
  }

  async start(): Promise<AgentCommandResult> {
    if (this.starting) return { ok: true };
    // Start never adds a second worker to a live family, whatever version it
    // is: only Stop (or the automatic drain/exiting takeover) ends one.
    const owners = this.owners();
    if (owners.length > 0) {
      const foreign = owners.find((owner) => this.foreignOwner(owner));
      if (foreign !== undefined) {
        this.notice =
          `Watchdog is running for this root from another dashboard ` +
          `(STATE_DIR ${foreign.stateDir}).`;
        return { ok: true, notice: this.notice };
      }
      return { ok: true };
    }

    this.starting = true;
    this.startingSince = this.now();
    this.startError = null;
    this.notice = null;
    try {
      const result = await this.preflight({
        repoDir: this.repoDir,
        environment: this.environment,
      });
      if (!result.ok) {
        this.starting = false;
        this.startingSince = null;
        this.startError = result.message;
        return { ok: false, message: result.message };
      }
      const pid = this.spawnNewest();
      if (pid === undefined) {
        this.starting = false;
        this.startingSince = null;
        this.startError = "the Watchdog worker could not be started";
        return { ok: false, message: this.startError };
      }
      this.forge.requestSync();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.starting = false;
      this.startingSince = null;
      this.startError = message;
      return { ok: false, message };
    }
  }

  stop(): AgentCommandResult {
    const owners = this.owners();
    if (owners.length === 0) {
      return { ok: false, message: "No Watchdog worker is running for this root." };
    }
    const foreign = owners.find((owner) => this.foreignOwner(owner));
    if (foreign !== undefined) {
      return {
        ok: false,
        message:
          `Watchdog is running from another dashboard (STATE_DIR ${foreign.stateDir}); ` +
          `this dashboard cannot stop it.`,
      };
    }
    // Every live version gets Stop in its own control directory; each one
    // finishes its in-flight cycle and exits on its own.
    for (const owner of owners) {
      try {
        writeWatchdogCommand(this.controlFor(owner), { type: "stop" });
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    this.stopRequested = true;
    this.startError = null;
    this.scheduleStopProof(owners.map((owner) => owner.pid));
    return { ok: true };
  }

  /** Saves the cadence and both caps as one settings write. */
  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult {
    if (!isValidWatchdogCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidWatchdogLimit(maxPerHour) || !isValidWatchdogLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    const settings = readWatchdogSettings(this.watchdogDir);
    try {
      writeWatchdogSettings(this.watchdogDir, {
        ...settings,
        intervalMinutes: minutes,
        maxPerHour,
        maxPending,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not save the settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    // The settings file already carries the new values; a live worker of any
    // version is also told immediately so its cadence changes without restart.
    for (const owner of this.owners().filter((entry) => !this.foreignOwner(entry))) {
      try {
        writeWatchdogCommand(this.controlFor(owner), {
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
    if (this.shouldPersistProjection()) this.persistProjection();
    return { ok: true };
  }

  async disableTimer(): Promise<AgentCommandResult> {
    const unit = this.descriptor.timerGate?.unit;
    if (unit === undefined) return { ok: false, message: "This agent has no legacy timer." };
    const result = this.systemctl(["disable", "--now", unit]);
    if (result.code !== 0) {
      const message =
        `could not disable ${unit}: ` +
        firstLineOf(result.stderr.length > 0 ? result.stderr : result.stdout);
      this.startError = message;
      if (this.timerGate !== null && this.timerGate !== undefined) {
        this.timerGate = { ...this.timerGate, error: message };
      }
      return { ok: false, message };
    }
    await this.refreshTimer(true);
    return { ok: true };
  }

  private scheduleStopProof(pids: number[]): void {
    if (pids.length === 0) return;
    this.clearStopProof();
    const timer = setTimeout(() => {
      this.stopping = undefined;
      this.escalateStop(pids);
    }, STOP_CYCLE_GRACE_MS);
    timer.unref?.();
    this.stopping = { pids, timer };
  }

  private clearStopProof(): void {
    if (this.stopping !== undefined) clearTimeout(this.stopping.timer);
    this.stopping = undefined;
  }

  /** True when the worker published stopped or is no longer alive. */
  private stopSettled(pid: number): boolean {
    if (!processAlive(pid)) return true;
    return readWorkerStates(this.watchdogDir).some(
      (worker) => worker.pid === pid && worker.lifecycle === "stopped",
    );
  }

  /**
   * The grace ended without a stopped state. Signal only a process the table
   * proves is this root's worker, then give its handler the kill grace.
   */
  private escalateStop(pids: number[]): void {
    const signalled = pids.filter((pid) => {
      if (this.stopSettled(pid) || !this.provesWorker(pid)) return false;
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    });
    if (signalled.length === 0) return;
    const timer = setTimeout(() => {
      this.stopping = undefined;
      for (const pid of signalled) {
        if (this.stopSettled(pid) || !this.provesWorker(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It exited between the proof and the signal.
        }
      }
    }, STOP_KILL_GRACE_MS);
    timer.unref?.();
    this.stopping = { pids: signalled, timer };
  }

  private provesWorker(pid: number): boolean {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
      return (
        argv.some((entry) => entry.endsWith(join("watchdog", "worker.ts"))) &&
        argv.includes(this.repoDir)
      );
    } catch {
      return false;
    }
  }

  private async refreshTimer(force: boolean): Promise<void> {
    const unit = this.descriptor.timerGate?.unit;
    if (unit === undefined) return;
    if (this.timerReading) return;
    const now = this.now();
    if (!force && this.timerGate !== null && now - this.timerReadAt < TIMER_REFRESH_MS) return;
    this.timerReading = true;
    this.timerReadAt = now;
    try {
      const available = this.systemctl(["is-active", unit]);
      if (available.code === 127 || /not found|No such file/i.test(available.stderr)) {
        this.timerGate = { unit, state: "absent", blocked: false, error: null };
        return;
      }
      const active = available.stdout === "active";
      const enabledResult = this.systemctl(["is-enabled", unit]);
      const enabled = enabledResult.stdout === "enabled";
      const known =
        available.stdout === "active" ||
        available.stdout === "inactive" ||
        enabledResult.stdout === "enabled" ||
        enabledResult.stdout === "disabled";
      const state: NonNullable<AgentSnapshotInput["timer"]>["state"] = !known
        ? "unknown"
        : active
          ? "active"
          : enabled
            ? "enabled"
            : "inactive";
      this.timerGate = {
        unit,
        state,
        blocked: state === "active" || state === "enabled",
        error: null,
      };
    } finally {
      this.timerReading = false;
    }
  }
}

function isValidWatchdogLimit(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100);
}

function isValidWatchdogCadence(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1440;
}

/** The default timer gate: no `systemctl` means no legacy unit can block. */
function defaultSystemctl(args: string[]): WatchdogCommandResult {
  if (Bun.which("systemctl") === null) {
    return { code: 127, stdout: "", stderr: "systemctl: not found" };
  }
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 1_500,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Watchdog's Start preflight: the canonical root, the forge write access its
 * delivery needs, and no active or enabled legacy timer. It names the missing
 * fact and spawns nothing.
 */
export async function preflightWatchdog(options: {
  repoDir: string;
  environment?: Record<string, string | undefined>;
  systemctl?: (args: string[]) => WatchdogCommandResult;
  run?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const environment = options.environment ?? process.env;
  const problem = rootProblem(options.repoDir);
  if (problem !== undefined) return { ok: false, message: problem };
  const remote = originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message: `Watchdog supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  if (remote.forge === "github") {
    if (findOnPath("gh", environment) === undefined) {
      return { ok: false, message: "missing prerequisite: gh is not on PATH" };
    }
    const run =
      options.run ??
      ((argv: string[]) => ghCommand(argv, environment));
    const permission = await run(["api", `repos/${remote.project}`, "--jq", ".permissions.push"]);
    if (permission.code !== 0 || permission.stdout.trim() !== "true") {
      const detail =
        firstLineOf(permission.stderr) ??
        firstLineOf(permission.stdout) ??
        `gh exited with code ${permission.code}`;
      return {
        ok: false,
        message:
          `missing prerequisite: 'gh api repos/${remote.project} --jq .permissions.push' ` +
          `did not return true: ${detail}`,
      };
    }
  } else {
    const baseUrl = giteaBaseUrl(remote, environment);
    if (baseUrl === undefined) {
      return {
        ok: false,
        message:
          "missing prerequisite: the Gitea address is not configured " +
          "(set DEVBOARD_GITEA_URL or use an HTTP(S) origin)",
      };
    }
    const token = configuredGiteaToken(environment);
    if (token === undefined) return { ok: false, message: "missing prerequisite: GITEA_TOKEN is not set" };
    try {
      const document = await giteaRepository({ baseUrl, project: remote.project, token });
      const permissions =
        typeof document.permissions === "object" && document.permissions !== null
          ? document.permissions
          : {};
      const writable =
        ("push" in permissions && permissions.push === true) ||
        ("admin" in permissions && permissions.admin === true);
      if (!writable) {
        return {
          ok: false,
          message:
            `missing prerequisite: the Gitea token cannot write to ${remote.project} on ${baseUrl}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        message:
          `missing prerequisite: the Gitea repository ${remote.project} could not be read: ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }
  const systemctl = options.systemctl ?? defaultSystemctl;
  const active = systemctl(["is-active", "devboard-watchdog.timer"]);
  const enabled = systemctl(["is-enabled", "devboard-watchdog.timer"]);
  if (active.stdout === "active" || enabled.stdout === "enabled") {
    return {
      ok: false,
      message:
        "the legacy devboard-watchdog.timer is active or enabled; disable it before starting Watchdog",
    };
  }
  return { ok: true };
}

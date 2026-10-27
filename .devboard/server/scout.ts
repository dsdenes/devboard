import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveLockOwner, pidAlive, type LockOwner } from "../issues/lock";
import { MAX_STAGED, controlDirectory, lockPath, scanDirectory, statePath } from "../issues/scout/paths";
import { writeCommand, type ScoutCommand } from "../issues/scout/control";
import { preflightScout, type ScoutPreflightResult } from "../issues/scout/preflight";
import { cachedRepository } from "../issues/repository";
import { readState, type ScoutState } from "../issues/scout/state";
import { readActivity } from "../issues/state";
import { activityDelta } from "./activity";

/**
 * The dashboard half of Auto Scout. It never owns a scan loop, an agent, or a
 * lock: it reads the worker's repo-scoped board, replays its activity, and
 * writes commands to it. A worker started here is detached in its own session,
 * so killing this server leaves it running and a replacement reattaches.
 */

export interface ScoutSnapshot {
  present: boolean;
  repo: string | null;
  root: string;
  lifecycle: ScoutState["lifecycle"];
  enabled: boolean;
  attached: boolean;
  worker: ScoutState["worker"];
  staged: ScoutState["staged"];
  scan: ScoutState["scan"];
  newestScanId: string | null;
  shortfall: ScoutState["shortfall"];
  nextAttemptAt: string | null;
  lastError: string | null;
  notice: string | null;
  decisions: ScoutState["decisions"];
  updatedAt: string | null;
}

export interface ScoutActivityEntry {
  text: string;
  append: boolean;
}

export interface ScoutBridgeOptions {
  repoDir: string;
  stateDir: string;
  agentCommand: string;
  runningVersion: string | null;
  harnessDir: string;
  send: (event: unknown) => void;
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
}

export class ScoutBridge {
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly agentCommand: string;
  private readonly runningVersion: string | null;
  private readonly harnessDir: string;
  private readonly send: (event: unknown) => void;
  private readonly environment: Record<string, string | undefined>;
  private readonly repository: () => string | null;
  private readonly preflight: NonNullable<ScoutBridgeOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<ScoutBridgeOptions["spawnWorker"]>;
  private readonly log: (line: string) => void;
  private readonly pollMsValue: number;

  private timer: Timer | undefined;
  private lastSignature = "";
  private lastActivityScanId: string | null = null;
  private lastActivity: string[] = [];
  private stopping: { pid: number; timer: Timer } | undefined;
  private starting = false;

  constructor(options: ScoutBridgeOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.agentCommand = options.agentCommand;
    this.runningVersion = options.runningVersion;
    this.harnessDir = options.harnessDir;
    this.send = options.send;
    this.environment = options.environment ?? process.env;
    this.repository = cachedRepository(this.repoDir);
    this.log = options.log ?? (() => undefined);
    this.pollMsValue = Math.max(50, options.pollMs ?? 250);
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
    if (this.stopping !== undefined) {
      clearTimeout(this.stopping.timer);
      this.stopping = undefined;
    }
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

  /** True when there is a worker state or a live lock to replay. */
  get present(): boolean {
    return this.currentState() !== undefined || this.lockOwner() !== undefined;
  }

  snapshot(): ScoutSnapshot {
    const state = this.currentState();
    const owner = this.lockOwner();
    const attached =
      owner !== undefined && resolve(owner.stateDir) === this.stateDir && pidAlive(owner.pid);
    const active = attached ? state : undefined;
    const lifecycle =
      active?.lifecycle === "stopped" || active === undefined ? "stopped" : active.lifecycle;
    const worker = state?.worker ?? null;
    const mismatch =
      attached && worker !== null && worker.harnessVersion !== this.runningVersion
        ? `Auto Scout worker ${worker.harnessVersion ?? "unknown"} is running; this dashboard ` +
          `loaded ${this.runningVersion ?? "unknown"}. It is left running; Stop it to launch the ` +
          "current harness on the next Start."
        : null;
    return {
      present: state !== undefined,
      repo: state !== undefined && state.repo.length > 0 ? state.repo : this.repository(),
      root: this.repoDir,
      lifecycle,
      enabled: active?.enabled === true && lifecycle !== "stopped",
      attached,
      worker: active?.worker ?? null,
      staged: state?.staged ?? [],
      scan: active?.scan ?? null,
      newestScanId: state?.newestScanId ?? null,
      shortfall: active?.shortfall ?? null,
      nextAttemptAt: active?.nextAttemptAt ?? null,
      lastError: active?.lastError ?? null,
      notice: mismatch ?? active?.notice ?? null,
      decisions: state?.decisions ?? [],
      updatedAt: state?.updatedAt ?? null,
    };
  }

  /** A connect-time replay: state, then the newest scan's whole activity. */
  replay(target?: { send(data: string): unknown }): void {
    const deliver =
      target === undefined
        ? this.send
        : (event: unknown) => {
            try {
              target.send(JSON.stringify(event));
            } catch {
              // The socket closed before the replay finished.
            }
          };
    const snapshot = this.snapshot();
    deliver({ type: "scoutState", ...snapshot });
    const scanId = snapshot.scan?.scanId ?? snapshot.newestScanId;
    if (scanId === null) return;
    const activity = this.readActivity(scanId);
    this.lastActivityScanId = scanId;
    this.lastActivity = activity;
    deliver({
      type: "scoutActivity",
      scanId,
      replay: true,
      entries: activity.map((text) => ({ text, append: false })),
    });
  }

  private readActivity(scanId: string): string[] {
    return readActivity(scanDirectory(this.repoDir, scanId));
  }

  private publishActivity(scanId: string, activity: string[]): void {
    if (this.lastActivityScanId !== scanId) {
      this.lastActivityScanId = scanId;
      this.lastActivity = activity;
      this.send({
        type: "scoutActivity",
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
      type: "scoutActivity",
      scanId,
      ...(delta.replay ? { replay: true } : {}),
      entries: delta.entries,
    });
  }

  refresh(): void {
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.send({ type: "scoutState", ...snapshot });
    }
    // The page shows the current scan, or the newest one once it finishes.
    const scanId = snapshot.scan?.scanId ?? snapshot.newestScanId;
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

  async start(): Promise<{ ok: true; attached: boolean } | { ok: false; message: string }> {
    if (this.starting) return { ok: true, attached: false };
    const owner = this.lockOwner();
    if (owner !== undefined) {
      if (resolve(owner.stateDir) !== this.stateDir) {
        return {
          ok: false,
          message:
            `this checkout already has an Auto Scout worker (pid ${owner.pid}) using ` +
            `${owner.stateDir}; this dashboard's STATE_DIR is ${this.stateDir}`,
        };
      }
      this.refresh();
      return { ok: true, attached: true };
    }

    this.starting = true;
    try {
      const result = await this.preflight({
        repoDir: this.repoDir,
        stateDir: this.stateDir,
        environment: this.environment,
      });
      if (!result.ok) return result;
      return await this.spawn();
    } finally {
      this.starting = false;
    }
  }

  private async spawn(): Promise<{ ok: true; attached: boolean } | { ok: false; message: string }> {
    const argv = [
      process.execPath,
      join(this.harnessDir, "issues", "scout", "worker.ts"),
      "--repo",
      this.repoDir,
      "--state-dir",
      this.stateDir,
    ];
    const pid = this.spawnWorker(argv, {
      ...this.environment,
      REPO_DIR: this.repoDir,
      STATE_DIR: this.stateDir,
      AGENT_COMMAND: this.agentCommand,
    });
    if (pid === undefined) {
      return { ok: false, message: "the Auto Scout worker could not be started" };
    }
    return { ok: true, attached: false };
  }

  /** Scan now: refused while a scan runs or the board already holds nine. */
  scan(): { ok: true } | { ok: false; message: string } {
    const state = this.currentState();
    if (state?.scan != null) return { ok: false, message: "A scan is already running." };
    if ((state?.staged.length ?? 0) >= MAX_STAGED) {
      return { ok: false, message: "The board already holds nine recommendations." };
    }
    return this.command({ type: "scan" });
  }

  /** One decision for one staged id; an id no longer staged is refused. */
  decide(
    kind: "approve" | "draft" | "reject",
    id: unknown,
  ): { ok: true } | { ok: false; message: string } {
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, message: "A decision needs the recommendation's id." };
    }
    const state = this.currentState();
    if (state === undefined || !state.staged.some((item) => item.id === id)) {
      return { ok: false, message: "That recommendation is no longer staged." };
    }
    return this.command({ type: kind, id });
  }

  stop(): { ok: true } | { ok: false; message: string } {
    return this.command({ type: "stop" });
  }

  private command(command: ScoutCommand): { ok: true } | { ok: false; message: string } {
    const state = this.currentState();
    const owner = this.lockOwner();
    if (owner === undefined) {
      return { ok: false, message: "No Auto Scout worker is running for this checkout." };
    }
    if (resolve(owner.stateDir) !== this.stateDir) {
      return {
        ok: false,
        message:
          `the Auto Scout worker (pid ${owner.pid}) uses ${owner.stateDir}; this dashboard's ` +
          `STATE_DIR is ${this.stateDir}`,
      };
    }
    if (state === undefined || !state.enabled || state.lifecycle === "stopped") {
      return { ok: false, message: "No Auto Scout worker is running for this checkout." };
    }
    writeCommand(controlDirectory(this.stateDir, this.repoDir), command);
    if (command.type === "stop") this.scheduleStopProof(owner.pid);
    return { ok: true };
  }

  /**
   * Stop must end a worker that is still alive after the command. Only a
   * process the table proves is this checkout's scout is signalled.
   */
  private scheduleStopProof(pid: number): void {
    if (this.stopping !== undefined) clearTimeout(this.stopping.timer);
    const timer = setTimeout(() => {
      this.stopping = undefined;
      if (!pidAlive(pid)) return;
      if (!this.provesWorker(pid)) return;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      const killTimer = setTimeout(() => {
        if (!pidAlive(pid)) return;
        if (!this.provesWorker(pid)) return;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It exited between the proof and the signal.
        }
      }, 2000);
      killTimer.unref?.();
    }, 3000);
    timer.unref?.();
    this.stopping = { pid, timer };
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

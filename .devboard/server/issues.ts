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
import { preflightIssues, type PreflightResult } from "../issues/preflight";
import { cachedRepository } from "../issues/repository";
import { closeIssue as closeTrackerIssue, type CloseIssueRequest } from "./issue-close";
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
  /** Test seams: replace the start preflight and the detached spawn. */
  preflight?: (options: {
    repoDir: string;
    stateDir: string;
    environment: Record<string, string | undefined>;
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

  private timer: Timer | undefined;
  private lastSignature = "";
  private lastActivities = new Map<string, string[]>();
  private stopping: { pid: number; timer: Timer } | undefined;
  private starting = false;

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
    this.preflight =
      options.preflight ??
      ((request) =>
        preflightIssues({
          repoDir: request.repoDir,
          stateDir: request.stateDir,
          environment: request.environment,
        }));
    this.spawnWorker = options.spawnWorker ?? ((argv, environment) => this.detach(argv, environment));
    this.closeIssueAction = options.closeIssue ?? ((request) => closeTrackerIssue(request));
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
      queue: state?.queue ?? [],
      runs: state?.runs ?? [],
      agents: active?.agents ?? [],
      cooldowns: active?.cooldowns ?? {},
      lastError: active?.lastError ?? null,
      lastExitCode: active?.lastExitCode ?? null,
      finishedAt: active?.finishedAt ?? null,
      notice: mismatch ?? active?.notice ?? null,
      updatedAt: state?.updatedAt ?? null,
    };
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

  async start(): Promise<{ ok: true; attached: boolean } | { ok: false; message: string }> {
    if (this.starting) return { ok: true, attached: false };
    const owner = this.lockOwner();
    if (owner !== undefined) {
      if (resolve(owner.stateDir) !== this.stateDir) {
        return {
          ok: false,
          message:
            `this checkout already has an issues worker (pid ${owner.pid}) using ${owner.stateDir}; ` +
            `this dashboard's STATE_DIR is ${this.stateDir}`,
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


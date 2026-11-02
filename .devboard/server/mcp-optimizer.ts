import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ghCommand } from "../issues/scout/preflight";
import { findOnPath, rootProblem } from "../issues/repository";
import { configuredGiteaToken, giteaBaseUrl } from "../lib/forge";
import { giteaRepository } from "../lib/gitea";
import { originForge } from "../issues/repository";
import { liveLockOwners, readLock, type LockOwner } from "../issues/lock";
import {
  mcpOptimizerDirectory,
  controlDirectory,
  lockPath,
  versionedControlDirectory,
  workerStateDirectories,
} from "../mcp-optimizer/paths";
import { writeMcpOptimizerCommand } from "../mcp-optimizer/control";
import { readMcpOptimizerStatus, type McpOptimizerStatus } from "../mcp-optimizer/status";
import {
  isValidCadence,
  isValidLimit,
  readMcpOptimizerSettings,
  writeMcpOptimizerSettings,
  type McpOptimizerSettings,
} from "../mcp-optimizer/settings";
import { readWorkerState, type McpOptimizerWorkerState } from "../mcp-optimizer/worker-state";
import { hostHarnessDir, readHarnessVersion } from "./version";
import { readProjection, writeProjection } from "../watchdog/projection";
import { AgentForgeState } from "./agents/forge-state";
import {
  createForgeIssueReader,
  type ForgeIssueReader,
} from "./agents/forge-reader";
import type { AgentDescriptor, AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";

/**
 * The MCP optimizer page's server half and its background-agent adapter. It reads the
 * detached worker's state, overlays the forge projection that the filing caps
 * count, and starts or stops the worker. A page load, a reconnect, or a
 * dashboard restart only reads; it never starts a cycle.
 */

export interface McpOptimizerActivityOptions {
  descriptor: AgentDescriptor;
  repoDir: string;
  /** This dashboard's STATE_DIR; MCP optimizer files live under its `coach/`. */
  stateDir: string;
  harnessDir: string;
  /** The harness version this dashboard loaded, for parallel-worker takeover. */
  runningVersion?: string | null;
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  /** Test seam; production derives it from the state directory. */
  mcpOptimizerDir?: string;
  reader?: ForgeIssueReader;
  /** True while at least one dashboard client is connected. */
  hasClients?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  environment?: Record<string, string | undefined>;
  log?: (line: string) => void;
  preflight?: (options: {
    repoDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
}

const START_PROOF_MS = 5_000;
const STOP_CYCLE_GRACE_MS = 10 * 60_000;
const STOP_KILL_GRACE_MS = 2_000;

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

export class McpOptimizerActivity implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly mcpOptimizerDir: string;
  private readonly harnessDir: string;
  private readonly runningVersion: string | null;
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly forge: AgentForgeState;
  private readonly now: () => number;
  private readonly environment: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly preflight: NonNullable<McpOptimizerActivityOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<McpOptimizerActivityOptions["spawnWorker"]>;

  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private stopping = new Map<number, Timer>();
  /** One automatic new-version start per dashboard lifetime. */
  private takeoverTask: Promise<void> | null = null;
  private takeoverDone = false;

  constructor(options: McpOptimizerActivityOptions) {
    this.descriptor = options.descriptor;
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.mcpOptimizerDir = resolve(options.mcpOptimizerDir ?? mcpOptimizerDirectory(this.stateDir));
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
      urls: () => readMcpOptimizerStatus(this.mcpOptimizerDir).issues.map((issue) => issue.url),
      hasClients: options.hasClients ?? (() => false),
      now: this.now,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      seed: (readProjection(this.mcpOptimizerDir)?.issues ?? []).map(
        (issue) => [issue.url, { url: issue.url, state: issue.state, version: issue.version }] as const,
      ),
      onRead: () => {
        if (this.shouldPersistProjection()) this.persistProjection();
      },
      log: this.log,
    });
    this.preflight = options.preflight ?? ((request) => preflightMcpOptimizer(request));
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
            `could not start the MCP optimizer worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      });
  }

  begin(): void {
    this.forge.begin();
    this.takeoverTask = this.takeoverOldWorkers().finally(() => {
      this.takeoverTask = null;
    });
  }

  dispose(): void {
    this.forge.dispose();
    this.clearStopProof();
  }

  settled(): Promise<void> {
    return Promise.all([
      this.forge.settled(),
      this.takeoverTask ?? Promise.resolve(),
    ]).then(() => undefined);
  }

  replay(_target: { send(data: string): unknown }): void {
    // MCP optimizer detail is the retained cycle history carried by the snapshot.
  }

  /** A view opened this agent: read the forge now when the cadence allows. */
  requestSync(): void {
    this.forge.requestSync();
  }

  private shouldPersistProjection(): boolean {
    if (this.allStates().length > 0) return true;
    const settings = readMcpOptimizerSettings(this.mcpOptimizerDir);
    return settings.maxPerHour !== null || settings.maxPending !== null;
  }

  private persistProjection(): void {
    const sync = this.forge.sync;
    try {
      writeProjection(this.mcpOptimizerDir, {
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
        `could not persist the MCP optimizer projection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Every published worker state: the legacy file and each version's file. */
  private allStates(): McpOptimizerWorkerState[] {
    const states: McpOptimizerWorkerState[] = [];
    const legacy = readWorkerState(this.mcpOptimizerDir);
    if (legacy !== undefined) states.push(legacy);
    for (const directory of workerStateDirectories(this.mcpOptimizerDir)) {
      const state = readWorkerState(directory);
      if (state !== undefined) states.push(state);
    }
    return states;
  }

  /** Live owners of this family whose STATE_DIR is this dashboard's. */
  private owners(): LockOwner[] {
    return liveLockOwners(lockPath(this.mcpOptimizerDir)).filter(
      (owner) => resolve(owner.stateDir) === this.stateDir,
    );
  }

  /** The control directory one live owner consumes, legacy or versioned. */
  private controlFor(owner: LockOwner): string {
    // The legacy lock identifies a worker that predates versioned state, even
    // before that worker has published its state file.
    const legacyOwner = readLock(lockPath(this.mcpOptimizerDir));
    if (legacyOwner !== undefined && legacyOwner.pid === owner.pid) {
      return controlDirectory(this.mcpOptimizerDir);
    }
    return versionedControlDirectory(this.mcpOptimizerDir, owner.harnessVersion);
  }

  snapshot(): AgentSnapshotInput {
    this.forge.requestSync();
    const owners = this.owners();
    const states = this.allStates();
    const byPid = new Map(states.map((state) => [state.pid, state] as const));
    const ownerStates = owners.map((owner) => byPid.get(owner.pid));
    // A lock whose worker published `stopped` is releasing it: no new work is
    // served, so it no longer counts as attached.
    const attached = owners.some((_, index) => ownerStates[index]?.lifecycle !== "stopped");
    const active =
      ownerStates.find((state) => state !== undefined && state.lifecycle !== "stopped") ??
      ownerStates.find((state) => state !== undefined) ??
      [...states].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const owned = attached;
    if (this.starting && attached) {
      this.starting = false;
      this.startingSince = null;
    }
    // A worker that published is proof the start succeeded: a proof that
    // expired while it was still warming up must not outlive it.
    if (attached) this.startError = null;
    if (
      this.starting &&
      this.startingSince !== null &&
      this.now() - this.startingSince > START_PROOF_MS
    ) {
      this.starting = false;
      this.startingSince = null;
      this.startError = "the MCP optimizer worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && !attached) this.stopRequested = false;
    if (!attached) this.clearStopProof();

    const status: McpOptimizerStatus = readMcpOptimizerStatus(this.mcpOptimizerDir);
    const settings: McpOptimizerSettings = readMcpOptimizerSettings(this.mcpOptimizerDir);
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested || active?.lifecycle === "stopping"
        ? "stopping"
        : attached
          ? active?.lifecycle === "failed"
            ? "failed"
            : "running"
          : active?.lifecycle === "failed"
            ? "failed"
            : "stopped";
    const workers = owners.map((owner) => ({
      pid: owner.pid,
      version: owner.harnessVersion,
      stateDir: owner.stateDir,
      lifecycle: byPid.get(owner.pid)?.lifecycle ?? "running",
    }));
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
      owned,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt: active?.lastRunAt ?? status.cycle,
        nextRunAt: attached ? (active?.nextRunAt ?? null) : null,
      },
      limits: {
        maxPerHour: settings.maxPerHour,
        maxPending: settings.maxPending,
      },
      issues: status.issues
        .filter((issue) => this.forge.reported(issue.url))
        .map((issue) => {
          const fact = this.forge.fact(issue.url);
          return {
            title: issue.title,
            category: issue.kind,
            filedAt: issue.filedAt,
            url: issue.url,
            state: fact?.state ?? "unknown",
            version: fact?.version ?? null,
          };
        }),
      pending: status.pending,
      sync: this.forge.sync,
      detail: { panel: "cycles", cycles: status.cycles },
      notice: active?.notice ?? this.notice,
      error: this.startError ?? active?.lastError ?? null,
      timer: null,
      workers,
    };
  }

  async start(): Promise<AgentCommandResult> {
    if (this.starting) return { ok: true };
    // Any live worker of this family already serves new cycles, whichever
    // version started it; Start never duplicates one.
    if (this.owners().length > 0) {
      this.forge.requestSync();
      return { ok: true };
    }
    return this.spawn();
  }

  /**
   * Starts this version's worker when an older version's worker is live and
   * this process is the newest harness. The older worker is told to drain: it
   * finishes the cycle already in flight, starts no new one, and exits on its
   * own. Runs once per bridge lifetime; with no live worker nothing starts.
   */
  private async takeoverOldWorkers(): Promise<void> {
    if (this.takeoverDone) return;
    this.takeoverDone = true;
    const owners = this.owners();
    if (owners.length === 0) return;
    if (this.runningVersion === null) return;
    const newest = readHarnessVersion(hostHarnessDir(this.repoDir));
    if (newest === null || newest !== this.runningVersion) return;
    if (owners.some((owner) => owner.harnessVersion === this.runningVersion)) return;
    const started = await this.spawn();
    if (!started.ok) {
      this.log(`could not start the ${this.runningVersion} MCP optimizer worker: ${started.message}`);
      return;
    }
    for (const owner of owners) {
      if (owner.harnessVersion === this.runningVersion) continue;
      try {
        writeMcpOptimizerCommand(this.controlFor(owner), { type: "drain" });
      } catch (error) {
        this.log(
          `could not drain the ${owner.harnessVersion ?? "legacy"} MCP optimizer worker: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /** Spawns the newest harness's worker after the Start preflight. */
  private async spawn(): Promise<AgentCommandResult> {
    this.starting = true;
    // The proof measures the worker's own publication, so its clock starts
    // when the worker is spawned. The prerequisite check before that is a
    // forge round trip, not the worker, and must not be charged to it.
    this.startingSince = null;
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
      const argv = [
        process.execPath,
        join(this.harnessDir, "mcp-optimizer", "worker.ts"),
        "--root",
        this.repoDir,
        "--state-dir",
        this.stateDir,
      ];
      this.startingSince = this.now();
      const pid = this.spawnWorker(argv, {
        ...this.environment,
        REPO_DIR: this.repoDir,
      });
      if (pid === undefined) {
        this.starting = false;
        this.startingSince = null;
        this.startError = "the MCP optimizer worker could not be started";
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
      return { ok: false, message: "No MCP optimizer worker is running for this repository." };
    }
    const failures: string[] = [];
    for (const owner of owners) {
      try {
        writeMcpOptimizerCommand(this.controlFor(owner), { type: "stop" });
        this.stopRequested = true;
        this.scheduleStopProof(owner.pid);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.startError = null;
    if (failures.length > 0) {
      return { ok: false, message: `Could not reach every worker: ${failures.join("; ")}` };
    }
    return { ok: true };
  }

  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult {
    if (!isValidCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidLimit(maxPerHour) || !isValidLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    const settings = readMcpOptimizerSettings(this.mcpOptimizerDir);
    try {
      writeMcpOptimizerSettings(this.mcpOptimizerDir, {
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
    const failures: string[] = [];
    for (const owner of this.owners()) {
      try {
        writeMcpOptimizerCommand(this.controlFor(owner), {
          type: "settings",
          intervalMinutes: minutes,
          maxPerHour,
          maxPending,
        });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.startError = null;
    if (this.shouldPersistProjection()) this.persistProjection();
    if (failures.length > 0) {
      return { ok: false, message: `Could not reach every worker: ${failures.join("; ")}` };
    }
    return { ok: true };
  }

  private scheduleStopProof(pid: number): void {
    this.clearStopProof(pid);
    const timer = setTimeout(() => {
      this.stopping.delete(pid);
      this.escalateStop(pid);
    }, STOP_CYCLE_GRACE_MS);
    timer.unref?.();
    this.stopping.set(pid, timer);
  }

  private clearStopProof(pid?: number): void {
    if (pid === undefined) {
      for (const timer of this.stopping.values()) clearTimeout(timer);
      this.stopping.clear();
      return;
    }
    clearTimeout(this.stopping.get(pid));
    this.stopping.delete(pid);
  }

  private stopSettled(pid: number): boolean {
    if (!processAlive(pid)) return true;
    const state = this.allStates().find((candidate) => candidate.pid === pid);
    return state !== undefined && state.lifecycle === "stopped";
  }

  private escalateStop(pid: number): void {
    if (this.stopSettled(pid)) return;
    if (!this.provesWorker(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      this.stopping.delete(pid);
      if (this.stopSettled(pid)) return;
      if (!this.provesWorker(pid)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It exited between the proof and the signal.
      }
    }, STOP_KILL_GRACE_MS);
    timer.unref?.();
    this.stopping.set(pid, timer);
  }

  private provesWorker(pid: number): boolean {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
      return (
        argv.some((entry) => entry.endsWith(join("mcp-optimizer", "worker.ts"))) &&
        argv.includes(this.repoDir)
      );
    } catch {
      return false;
    }
  }
}

/**
 * MCP optimizer's Start preflight: a supported origin and a write-capable account for
 * the delivery. It names the missing fact, writes no state, and spawns nothing.
 */
export async function preflightMcpOptimizer(options: {
  repoDir: string;
  environment?: Record<string, string | undefined>;
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
      message: `MCP optimizer supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  if (remote.forge === "github") {
    if (findOnPath("gh", environment) === undefined) {
      return { ok: false, message: "missing prerequisite: gh is not on PATH" };
    }
    const run = options.run ?? ((argv: string[]) => ghCommand(argv, environment));
    const permission = await run(["api", `repos/${remote.project}`, "--jq", ".permissions.push"]);
    if (permission.code !== 0 || permission.stdout.trim() !== "true") {
      const detail =
        firstLineOf(permission.stderr) ||
        firstLineOf(permission.stdout) ||
        `gh exited with code ${permission.code}`;
      return {
        ok: false,
        message:
          `missing prerequisite: 'gh api repos/${remote.project} --jq .permissions.push' ` +
          `did not return true: ${detail}`,
      };
    }
    return { ok: true };
  }
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
  if (token === undefined) {
    return { ok: false, message: "missing prerequisite: GITEA_TOKEN is not set" };
  }
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
  return { ok: true };
}

export { mcpOptimizerDirectory };

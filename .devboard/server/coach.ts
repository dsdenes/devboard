import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ghCommand } from "../issues/scout/preflight";
import { findOnPath, rootProblem } from "../issues/repository";
import { configuredGiteaToken, giteaBaseUrl } from "../lib/forge";
import { giteaRepository } from "../lib/gitea";
import { originForge } from "../issues/repository";
import { coachDirectory, controlDirectory } from "../coach/paths";
import { writeCoachCommand } from "../coach/control";
import { readCoachStatus, type CoachStatus } from "../coach/status";
import {
  isValidCadence,
  isValidLimit,
  readCoachSettings,
  writeCoachSettings,
  type CoachSettings,
} from "../coach/settings";
import { readWorkerState, type CoachWorkerState } from "../coach/worker-state";
import { readProjection, writeProjection } from "../watchdog/projection";
import { createWatchdogGitHubReader, type WatchdogReader } from "./watchdog";
import type { AgentDescriptor, AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";

/**
 * The Coach page's server half and its background-agent adapter. It reads the
 * detached worker's state, overlays the forge projection that the filing caps
 * count, and starts or stops the worker. A page load, a reconnect, or a
 * dashboard restart only reads; it never starts a cycle.
 */

export const COACH_REFRESH_MS = 60_000;
export const COACH_STALE_MS = 120_000;

export interface CoachActivityOptions {
  descriptor: AgentDescriptor;
  repoDir: string;
  /** This dashboard's STATE_DIR; Coach files live under its `coach/`. */
  stateDir: string;
  harnessDir: string;
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  /** Test seam; production derives it from the state directory. */
  coachDir?: string;
  reader?: WatchdogReader;
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

export class CoachActivity implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly coachDir: string;
  private readonly harnessDir: string;
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly reader: WatchdogReader;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly environment: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly preflight: NonNullable<CoachActivityOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<CoachActivityOptions["spawnWorker"]>;

  private readonly facts = new Map<string, { state: "pending" | "implemented"; version: string | null }>();
  private lastStarted: number | null = null;
  private lastSuccess: number | null = null;
  private lastFailure: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: Timer | undefined;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private stopping: { pid: number; timer: Timer } | undefined;

  constructor(options: CoachActivityOptions) {
    this.descriptor = options.descriptor;
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.coachDir = resolve(options.coachDir ?? coachDirectory(this.stateDir));
    this.harnessDir = options.harnessDir;
    this.send = options.send;
    this.reader =
      options.reader ??
      createWatchdogGitHubReader({
        repoDir: this.repoDir,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1, options.intervalMs ?? COACH_REFRESH_MS);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? COACH_STALE_MS);
    this.environment = options.environment ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.preflight = options.preflight ?? ((request) => preflightCoach(request));
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
            `could not start the Coach worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      });
  }

  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.schedule(), Math.max(50, Math.min(this.intervalMs, 1_000)));
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearStopProof();
  }

  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  replay(_target: { send(data: string): unknown }): void {
    // Coach detail is the retained cycle history carried by the snapshot.
  }

  private schedule(): void {
    if (this.inFlight !== null) return;
    const now = this.now();
    if (this.lastStarted !== null && now - this.lastStarted < this.intervalMs) return;
    this.lastStarted = now;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
  }

  private async refresh(): Promise<void> {
    const status = readCoachStatus(this.coachDir);
    try {
      const urls = status.issues.map((issue) => issue.url);
      const facts = urls.length === 0 ? [] : await this.reader.project(urls);
      const next = new Map<string, { state: "pending" | "implemented"; version: string | null }>();
      for (const fact of facts) next.set(fact.url, { state: fact.state, version: fact.version });
      this.facts.clear();
      for (const [url, fact] of next) this.facts.set(url, fact);
      this.lastSuccess = this.now();
      this.lastFailure = null;
    } catch (error) {
      this.lastFailure = firstLineOf(error instanceof Error ? error.message : String(error));
    }
    if (this.shouldPersistProjection()) this.persistProjection();
  }

  private shouldPersistProjection(): boolean {
    if (readWorkerState(this.coachDir) !== undefined) return true;
    const settings = readCoachSettings(this.coachDir);
    return settings.maxPerHour !== null || settings.maxPending !== null;
  }

  private persistProjection(): void {
    const sync = this.sync();
    try {
      writeProjection(this.coachDir, {
        version: 1,
        state: sync.state,
        at: sync.at,
        error: sync.error,
        issues: [...this.facts.entries()].map(([url, fact]) => ({
          url,
          state: fact.state,
          version: fact.version,
        })),
      });
    } catch (error) {
      this.log(
        `could not persist the Coach projection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private sync(): { state: "ok" | "error" | "stale"; at: string | null; error: string | null } {
    const now = this.now();
    const at = this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString();
    if (this.lastFailure !== null) return { state: "error", at, error: this.lastFailure };
    if (this.lastSuccess === null) return { state: "stale", at: null, error: null };
    if (now - this.lastSuccess > this.staleAfterMs) return { state: "stale", at, error: null };
    return { state: "ok", at, error: null };
  }

  private worker(): CoachWorkerState | undefined {
    return readWorkerState(this.coachDir);
  }

  private attached(worker: CoachWorkerState | undefined): boolean {
    return worker !== undefined && worker.lifecycle !== "stopped" && processAlive(worker.pid);
  }

  snapshot(): AgentSnapshotInput {
    this.schedule();
    const worker = this.worker();
    const attached = this.attached(worker);
    const owned = attached && resolve(worker?.stateDir ?? "") === this.stateDir;
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
      this.startError = "the Coach worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && !attached) this.stopRequested = false;
    if (!attached) this.clearStopProof();
    if (attached && !owned) {
      this.notice =
        `Coach is running for this repository from another dashboard ` +
        `(STATE_DIR ${worker?.stateDir ?? "unknown"}).`;
    } else if (this.notice !== null && this.notice.startsWith("Coach is running")) {
      this.notice = null;
    }

    const status: CoachStatus = readCoachStatus(this.coachDir);
    const settings: CoachSettings = readCoachSettings(this.coachDir);
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested || worker?.lifecycle === "stopping"
        ? "stopping"
        : attached
          ? worker?.lifecycle === "failed"
            ? "failed"
            : "running"
          : worker?.lifecycle === "failed"
            ? "failed"
            : "stopped";
    const projection = readProjection(this.coachDir);
    const facts = new Map(
      projection?.issues.map((issue) => [issue.url, issue] as const) ?? [],
    );
    return {
      lifecycle,
      enabled: attached && worker?.enabled === true && lifecycle !== "stopped",
      owned,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt: worker?.lastRunAt ?? status.cycle,
        nextRunAt: attached ? (worker?.nextRunAt ?? null) : null,
      },
      limits: {
        maxPerHour: settings.maxPerHour,
        maxPending: settings.maxPending,
      },
      issues: status.issues.map((issue) => ({
        title: `[coach] ${issue.category}: ${issue.line}`,
        category: issue.category,
        filedAt: issue.filedAt,
        url: issue.url,
        state:
          facts.get(issue.url)?.state === "implemented"
            ? "implemented"
            : facts.get(issue.url)?.state === "pending"
              ? "pending"
              : "unknown",
        version:
          facts.get(issue.url)?.state === "implemented"
            ? (facts.get(issue.url)?.version ?? null)
            : null,
      })),
      pending: status.pending,
      sync: this.sync(),
      detail: { panel: "cycles", cycles: status.cycles },
      notice: worker?.notice ?? this.notice,
      error: this.startError ?? worker?.lastError ?? null,
      timer: null,
    };
  }

  async start(): Promise<AgentCommandResult> {
    if (this.starting) return { ok: true };
    const worker = this.worker();
    if (this.attached(worker)) {
      if (worker !== undefined && resolve(worker.stateDir) !== this.stateDir) {
        this.notice =
          `Coach is running for this repository from another dashboard ` +
          `(STATE_DIR ${worker.stateDir}).`;
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
      const argv = [
        process.execPath,
        join(this.harnessDir, "coach", "worker.ts"),
        "--root",
        this.repoDir,
        "--state-dir",
        this.stateDir,
      ];
      const pid = this.spawnWorker(argv, {
        ...this.environment,
        REPO_DIR: this.repoDir,
      });
      if (pid === undefined) {
        this.starting = false;
        this.startingSince = null;
        this.startError = "the Coach worker could not be started";
        return { ok: false, message: this.startError };
      }
      this.lastStarted = null;
      this.schedule();
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
    const worker = this.worker();
    if (!this.attached(worker) || worker === undefined) {
      return { ok: false, message: "No Coach worker is running for this repository." };
    }
    if (resolve(worker.stateDir) !== this.stateDir) {
      return {
        ok: false,
        message:
          `Coach is running from another dashboard (STATE_DIR ${worker.stateDir}); ` +
          `this dashboard cannot stop it.`,
      };
    }
    try {
      writeCoachCommand(controlDirectory(this.coachDir), { type: "stop" });
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach the worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.stopRequested = true;
    this.startError = null;
    this.scheduleStopProof(worker.pid);
    return { ok: true };
  }

  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult {
    if (!isValidCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidLimit(maxPerHour) || !isValidLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    const settings = readCoachSettings(this.coachDir);
    try {
      writeCoachSettings(this.coachDir, {
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
    const worker = this.worker();
    if (
      worker !== undefined &&
      processAlive(worker.pid) &&
      resolve(worker.stateDir) === this.stateDir
    ) {
      try {
        writeCoachCommand(controlDirectory(this.coachDir), {
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

  private scheduleStopProof(pid: number): void {
    this.clearStopProof();
    const timer = setTimeout(() => {
      this.stopping = undefined;
      this.escalateStop(pid);
    }, STOP_CYCLE_GRACE_MS);
    timer.unref?.();
    this.stopping = { pid, timer };
  }

  private clearStopProof(): void {
    if (this.stopping !== undefined) clearTimeout(this.stopping.timer);
    this.stopping = undefined;
  }

  private stopSettled(pid: number): boolean {
    if (!processAlive(pid)) return true;
    const worker = this.worker();
    return worker !== undefined && worker.pid === pid && worker.lifecycle === "stopped";
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
      this.stopping = undefined;
      if (this.stopSettled(pid)) return;
      if (!this.provesWorker(pid)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It exited between the proof and the signal.
      }
    }, STOP_KILL_GRACE_MS);
    timer.unref?.();
    this.stopping = { pid, timer };
  }

  private provesWorker(pid: number): boolean {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
      return (
        argv.some((entry) => entry.endsWith(join("coach", "worker.ts"))) &&
        argv.includes(this.repoDir)
      );
    } catch {
      return false;
    }
  }
}

/**
 * Coach's Start preflight: a supported origin and a write-capable account for
 * the delivery. It names the missing fact, writes no state, and spawns nothing.
 */
export async function preflightCoach(options: {
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
      message: `Coach supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
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

export { coachDirectory };

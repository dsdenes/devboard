import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ghCommand } from "../issues/scout/preflight";
import { findOnPath, rootProblem } from "../issues/repository";
import { configuredGiteaToken, giteaBaseUrl, type ForgeRemote } from "../lib/forge";
import { ForgeReadRetry, classifyForgeReadFailure } from "../lib/forge-read-retry";
import {
  giteaJson,
  giteaListReleases,
  giteaOrigin,
  giteaRepository,
  repoPath,
  type FetchLike,
  type GiteaTarget,
} from "../lib/gitea";
import { createGiteaVersionClient } from "../lib/gitea-release";
import { originForge } from "../issues/repository";
import {
  createRepositoryGitHub,
  shippedVersion,
  type GitHubCommandRunner,
  type GitHubRelease,
  type RepositoryGitHub,
} from "../lib/github-release";
import type { WatchdogCycle } from "../watchdog/history";
import { readWatchdogStatus, type WatchdogIssue } from "../watchdog/status";
import { writeWatchdogCommand } from "../watchdog/control";
import { readProjection, writeProjection } from "../watchdog/projection";
import {
  controlDirectory,
  watchdogDirectory,
} from "../watchdog/paths";
import {
  readWatchdogSettings,
  writeWatchdogSettings,
  type WatchdogSettings,
} from "../watchdog/settings";
import { readWorkerState, type WatchdogWorkerState } from "../watchdog/worker-state";
import type { AgentDescriptor, AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";

/**
 * The Issues-mode watchdog page's server half. It reads the watchdog's local
 * facts on every request and overlays a GitHub projection that is refreshed in
 * the background at most once per interval. A request is never held open for
 * `gh`, and a failed read keeps the last known state and version for every
 * issue instead of inventing one.
 */

export type WatchdogIssueState = "pending" | "implemented";
export type WatchdogSyncState = "ok" | "error" | "stale";

export interface WatchdogSync {
  state: WatchdogSyncState;
  /** The last successful GitHub read, or null before one. */
  at: string | null;
  /** Why the last read failed, or null after a success. */
  error: string | null;
}

export interface WatchdogIssueRow extends WatchdogIssue {
  /** `null` until a GitHub read has answered for this issue. */
  state: WatchdogIssueState | null;
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
  sync: WatchdogSync;
}

export interface WatchdogFacts {
  url: string;
  state: WatchdogIssueState;
  version: string | null;
}

/** Reads every issue's GitHub facts; rejection means the read failed. */
export interface WatchdogReader {
  project(urls: string[]): Promise<WatchdogFacts[]>;
}

/** At most one GitHub projection refresh starts per interval. */
export const WATCHDOG_REFRESH_MS = 60_000;
/** A success older than this, with no later failure, reads as stale. */
export const WATCHDOG_STALE_MS = 120_000;

/** One issue URL, split into the repository it belongs to and its number. */
export function issueLocator(url: string): { repository: string; number: number } | null {
  const match =
    /^https?:\/\/([^/?#]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([0-9]+)(?:[/?#].*)?$/.exec(
      url.trim(),
    );
  if (match === null) return null;
  const host = (match[1] ?? "").toLowerCase();
  if (host.includes("gitlab")) return null;
  const number = Number(match[4]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repository: `${match[2]}/${match[3]}`, number };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

export interface WatchdogGitHubReaderOptions {
  /** The checkout that resolves commits and release containment locally. */
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /** Injectable forge command; defaults to the operator's `gh`. */
  run?: GitHubCommandRunner;
  /** Injectable transport for the Gitea API. */
  fetchImpl?: FetchLike;
}

/**
 * Whether a ledger URL belongs to the issues the Gitea reader can serve:
 * another forge's URL is skipped instead of read by number.
 */
function servedBy(value: string, baseUrl: string): boolean {
  const issue = giteaOrigin(value);
  return issue !== undefined && issue === giteaOrigin(baseUrl);
}

function createWatchdogGiteaReader(
  options: WatchdogGitHubReaderOptions,
  remote: ForgeRemote,
): WatchdogReader {
  const environment = options.environment ?? process.env;
  const baseUrl = giteaBaseUrl(remote, environment);
  const token = configuredGiteaToken(environment);

  return {
    async project(urls: string[]): Promise<WatchdogFacts[]> {
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new Error("the watchdog activity needs DEVBOARD_GITEA_URL for a Gitea origin");
      }
      const facts: WatchdogFacts[] = [];
      // Releases are a per-repository read: one scan serves every closed issue
      // of that repository, and a second repository gets its own scan.
      const releases = new Map<string, GitHubRelease[]>();
      for (const url of urls) {
        // An issue filed through another forge cannot be read here; the row
        // stays without a state instead of failing the whole projection.
        if (!servedBy(url, baseUrl)) continue;
        const locator = issueLocator(url);
        if (locator === null) throw new Error(`not a supported issue URL: ${url}`);
        const target: GiteaTarget = {
          baseUrl,
          project: locator.repository,
          ...(token === undefined ? {} : { token }),
        };
        const issue = await giteaJson<unknown>(
          target,
          `${repoPath(target)}/issues/${locator.number}`,
          undefined,
          options.fetchImpl,
        );
        const state =
          typeof issue === "object" && issue !== null && "state" in issue
            ? issue.state
            : undefined;
        if (state !== "closed") {
          facts.push({ url, state: "pending", version: null });
          continue;
        }
        let published = releases.get(locator.repository);
        if (published === undefined) {
          published = await giteaListReleases(target, options.fetchImpl);
          releases.set(locator.repository, published);
        }
        const version = await shippedVersion(
          { number: locator.number, state: "closed" },
          createGiteaVersionClient(target, options.repoDir, options.fetchImpl),
          published,
        );
        facts.push({ url, state: "implemented", version });
      }
      return facts;
    },
  };
}

/**
 * The live reader. Each issue's repository is taken from its own URL, so the
 * page stays correct when the ledger names issues outside the host origin.
 */
export function createWatchdogGitHubReader(
  options: WatchdogGitHubReaderOptions,
): WatchdogReader {
  const remote = originForge(options.repoDir, options.environment);
  if (remote?.forge === "gitea") return createWatchdogGiteaReader(options, remote);
  const run = options.run ?? ((argv, environment) => ghCommand(argv, environment));
  const clients = new Map<string, RepositoryGitHub>();

  function client(repository: string): RepositoryGitHub {
    const existing = clients.get(repository);
    if (existing !== undefined) return existing;
    const created = createRepositoryGitHub({
      repository,
      repoDir: options.repoDir,
      run,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    clients.set(repository, created);
    return created;
  }

  return {
    async project(urls: string[]): Promise<WatchdogFacts[]> {
      const releases = new Map<string, GitHubRelease[]>();
      const facts: WatchdogFacts[] = [];
      for (const url of urls) {
        const locator = issueLocator(url);
        if (locator === null) {
          throw new Error(`not a GitHub issue URL: ${url}`);
        }
        const github = client(locator.repository);
        const state = await github.issueState(locator.number);
        if (state === "open") {
          facts.push({ url, state: "pending", version: null });
          continue;
        }
        let published = releases.get(locator.repository);
        if (published === undefined) {
          published = await github.listReleases();
          releases.set(locator.repository, published);
        }
        const version = await shippedVersion(
          { number: locator.number, state: "closed" },
          github,
          published,
        );
        facts.push({ url, state: "implemented", version });
      }
      return facts;
    },
  };
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
  send: (event: unknown, except?: { send(data: string): unknown }) => void;
  reader?: WatchdogReader;
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
  private readonly send: (event: unknown, except?: { send(data: string): unknown }) => void;
  private readonly reader: WatchdogReader;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly environment: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly preflight: NonNullable<WatchdogActivityOptions["preflight"]>;
  private readonly spawnWorker: NonNullable<WatchdogActivityOptions["spawnWorker"]>;
  private readonly systemctl: NonNullable<WatchdogActivityOptions["systemctl"]>;

  private readonly facts = new Map<string, { state: WatchdogIssueState; version: string | null }>();
  private lastStarted: number | null = null;
  private lastSuccess: number | null = null;
  private lastFailure: string | null = null;
  /** When the next projection read is due; null means the normal cadence. */
  private nextAttemptAt: number | null = null;
  /** The consecutive transient failures of the projection read. */
  private readonly retry = new ForgeReadRetry();
  private inFlight: Promise<void> | null = null;
  private timer: Timer | undefined;
  private timerGate: AgentSnapshotInput["timer"] = null;
  private timerReadAt = 0;
  private timerReading = false;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;
  private notice: string | null = null;
  private stopping: { pid: number; timer: Timer } | undefined;

  constructor(options: WatchdogActivityOptions) {
    this.descriptor = options.descriptor;
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.watchdogDir = resolve(options.watchdogDir ?? watchdogDirectory(this.repoDir));
    this.harnessDir = options.harnessDir;
    this.send = options.send;
    this.reader =
      options.reader ??
      createWatchdogGitHubReader({
        repoDir: this.repoDir,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1, options.intervalMs ?? WATCHDOG_REFRESH_MS);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? WATCHDOG_STALE_MS);
    this.environment = options.environment ?? process.env;
    this.log = options.log ?? (() => undefined);
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
      this.schedule();
      void this.refreshTimer(false);
    }, Math.max(50, Math.min(this.intervalMs, 1_000)));
    void this.refreshTimer(true);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearStopProof();
  }

  /** Awaits the background projection refresh a snapshot scheduled. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  replay(_target: { send(data: string): unknown }): void {
    // Watchdog activity is the retained cycle history carried by the snapshot.
  }

  private schedule(): void {
    if (this.inFlight !== null) return;
    const now = this.now();
    if (this.lastStarted !== null) {
      const due = this.nextAttemptAt ?? this.lastStarted + this.intervalMs;
      if (now < due) return;
    }
    this.lastStarted = now;
    this.nextAttemptAt = null;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
  }

  private async refresh(): Promise<void> {
    const status = readWatchdogStatus(this.watchdogDir);
    try {
      const urls = status.issues.map((issue) => issue.url);
      const facts = urls.length === 0 ? [] : await this.reader.project(urls);
      const next = new Map<string, { state: WatchdogIssueState; version: string | null }>();
      for (const fact of facts) {
        const previous = this.facts.get(fact.url);
        const version =
          fact.state === "implemented"
            ? fact.version ?? (previous?.state === "implemented" ? previous.version : null)
            : null;
        next.set(fact.url, { state: fact.state, version });
      }
      this.facts.clear();
      for (const [url, value] of next) this.facts.set(url, value);
      this.lastSuccess = this.now();
      this.lastFailure = null;
      this.nextAttemptAt = null;
      this.retry.succeed();
    } catch (error) {
      const reason = firstLineOf(error instanceof Error ? error.message : String(error));
      const kind = classifyForgeReadFailure(reason);
      const delay = this.retry.record(kind);
      if (kind === "transient" && delay !== null) {
        // The retry window is not an alert: the last known rows and read time
        // stay, and the sync reads `stale` with no reason.
        this.lastFailure = null;
        this.nextAttemptAt = this.now() + delay;
      } else {
        this.lastFailure = reason;
        this.nextAttemptAt = null;
      }
    }
    if (this.shouldPersistProjection()) this.persistProjection();
  }

  /**
   * A fresh host writes no watchdog file until a worker has run or a cap is
   * set, so a reset never stages a projection the operator did not create.
   */
  private shouldPersistProjection(): boolean {
    if (readWorkerState(this.watchdogDir) !== undefined) return true;
    const settings = readWatchdogSettings(this.watchdogDir);
    return settings.maxPerHour !== null || settings.maxPending !== null;
  }

  /** The worker enforces caps from this file; a failed read keeps the rows. */
  private persistProjection(): void {
    const sync = this.sync();
    try {
      writeProjection(this.watchdogDir, {
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
        `could not persist the watchdog projection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private sync(): WatchdogSync {
    const now = this.now();
    const at = this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString();
    if (this.lastFailure !== null) {
      return { state: "error", at, error: this.lastFailure };
    }
    if (this.retry.failures > 0) return { state: "stale", at, error: null };
    if (this.lastSuccess === null) return { state: "stale", at: null, error: null };
    if (now - this.lastSuccess > this.staleAfterMs) {
      return { state: "stale", at, error: null };
    }
    return { state: "ok", at, error: null };
  }

  snapshot(): AgentSnapshotInput {
    this.schedule();
    const worker = readWorkerState(this.watchdogDir);
    const attached =
      worker !== undefined && worker.lifecycle !== "stopped" && processAlive(worker.pid);
    const owned = attached && resolve(worker.stateDir) === this.stateDir;
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
    if (attached && !owned) {
      this.notice =
        `Watchdog is running for this root from another dashboard ` +
        `(STATE_DIR ${worker?.stateDir ?? "unknown"}).`;
    } else if (this.notice !== null && this.notice.startsWith("Watchdog is running")) {
      this.notice = null;
    }

    const status = readWatchdogStatus(this.watchdogDir);
    const settings = readWatchdogSettings(this.watchdogDir);
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
    const issues: WatchdogIssueRow[] = status.issues.map((issue) => ({
      ...issue,
      state: this.facts.get(issue.url)?.state ?? null,
      version:
        this.facts.get(issue.url)?.state === "implemented"
          ? (this.facts.get(issue.url)?.version ?? null)
          : null,
    }));
    const lastRunAt = worker?.lastRunAt ?? status.cycle;
    return {
      lifecycle,
      enabled: attached && worker?.enabled === true && lifecycle !== "stopped",
      owned,
      attached,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt,
        nextRunAt: attached ? (worker?.nextRunAt ?? null) : null,
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
      sync: this.sync(),
      detail: { panel: "cycles", cycles: status.cycles },
      notice: worker?.notice ?? this.notice,
      error: this.startError ?? worker?.lastError ?? null,
      timer: this.timerGate,
    };
  }

  async start(): Promise<AgentCommandResult> {
    if (this.starting) return { ok: true };
    const worker = readWorkerState(this.watchdogDir);
    const attached =
      worker !== undefined && worker.lifecycle !== "stopped" && processAlive(worker.pid);
    if (attached) {
      if (resolve(worker.stateDir) !== this.stateDir) {
        this.notice =
          `Watchdog is running for this root from another dashboard ` +
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
        join(this.harnessDir, "watchdog", "worker.ts"),
        "--root",
        this.repoDir,
        "--state-dir",
        this.watchdogDir,
        "--owner-state-dir",
        this.stateDir,
      ];
      const pid = this.spawnWorker(argv, {
        ...this.environment,
        REPO_DIR: this.repoDir,
      });
      if (pid === undefined) {
        this.starting = false;
        this.startingSince = null;
        this.startError = "the Watchdog worker could not be started";
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
    const worker = readWorkerState(this.watchdogDir);
    const attached =
      worker !== undefined && worker.lifecycle !== "stopped" && processAlive(worker.pid);
    if (!attached || worker === undefined) {
      return { ok: false, message: "No Watchdog worker is running for this root." };
    }
    if (resolve(worker.stateDir) !== this.stateDir) {
      return {
        ok: false,
        message:
          `Watchdog is running from another dashboard (STATE_DIR ${worker.stateDir}); ` +
          `this dashboard cannot stop it.`,
      };
    }
    try {
      writeWatchdogCommand(controlDirectory(this.watchdogDir), { type: "stop" });
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
    const worker = readWorkerState(this.watchdogDir);
    if (worker !== undefined && processAlive(worker.pid) && resolve(worker.stateDir) === this.stateDir) {
      try {
        writeWatchdogCommand(controlDirectory(this.watchdogDir), {
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

  /** True when the worker published stopped or is no longer alive. */
  private stopSettled(pid: number): boolean {
    if (!processAlive(pid)) return true;
    const worker = readWorkerState(this.watchdogDir);
    return worker !== undefined && worker.pid === pid && worker.lifecycle === "stopped";
  }

  /**
   * The grace ended without a stopped state. Signal only a process the table
   * proves is this root's worker, then give its handler the kill grace.
   */
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

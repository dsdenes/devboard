import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../../server/acp";
import {
  createWorkerProviderEnvironment,
  type WorkerProviderEnvironment,
} from "../../server/providers/worker-environment";
import { readHarnessVersion } from "../../server/version";
import { acquireLock, liveLockOwner, liveLockOwners, versionLockPath } from "../lock";
import { originForge, originRepository } from "../repository";
import { appendActivityLine, writeActivity } from "../state";
import { readAuditInput, type AuditInput } from "./audit";
import { takeCommands, type ApiStandardsCommand } from "./control";
import { createApiStandardsForge, isForgeRateLimited, type ApiStandardsForgeClient } from "./forge";
import { giteaBaseUrl } from "../../lib/forge";
import { ForgeReadRetry, classifyForgeReadFailure } from "../../lib/forge-read-retry";
import {
  CYCLE_ISSUE_LIMIT,
  SYNC_INTERVAL_MS,
  apiStandardsConfig,
  controlDirectory,
  cycleClaimPath,
  lockPath,
  settingsPath,
  statePath,
  cycleDirectory,
  versionedControlDirectory,
  versionedStatePath,
  type ApiStandardsConfig,
} from "./paths";
import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  capacityFor,
  emptyState,
  isValidCadence,
  isValidLimit,
  loadState,
  readSettings,
  writeSettings,
  writeState,
  type ApiStandardsIssueRow,
  type ApiStandardsSettings,
  type ApiStandardsState,
} from "./state";
import {
  createCycleDirectory,
  promptFor,
  readFindings,
  validateFinding,
  writeCycle,
} from "./scan";
import type { AcpPeer, IssuesPeerOptions } from "../worker";
import { readToolLog, toolValueNumber, toolValueString } from "../../lib/tool-log";

/**
 * The detached worker for one repository's API Standards agent. It owns the
 * audit cadence, the ACP peer, the repository lock, and the recorded decisions,
 * so it outlives any dashboard process. At most one audit cycle runs at a
 * time. It never edits the checkout and never files an issue itself: the turn's
 * only forge write is `issue_create`, and the worker records every decision.
 */

const TICK_MS = 100;
const DEFAULT_AGENT_COMMAND = "omp acp";
const FIRST_LINE_MAX = 400;
const READ_TIMEOUT_MS = 30_000;
const CYCLE_TIMEOUT_MS = 20 * 60_000;

export interface ApiStandardsWorkerOptions {
  repoDir: string;
  stateDir: string;
  agentCommand?: string;
  environment?: Record<string, string | undefined>;
  syncMs?: number;
  cadenceMs?: number;
  /** Test seam: the ticker interval; production ticks every 100 ms. */
  tickMs?: number;
  readTimeoutMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  connect?: (options: IssuesPeerOptions) => AcpPeer;
  /** Resolves each cycle's provider environment; re-reads the store per cycle. */
  providerEnvironment?: WorkerProviderEnvironment;
  forge?: ApiStandardsForgeClient;
  harnessVersion?: string | null;
  config?: ApiStandardsConfig;
  /** Test seam: only an explicit `beginCycle()` call starts a cycle. */
  manualCycles?: boolean;
  log?: (line: string) => void;
  onStopped?: () => void;
}

interface ActiveCycle {
  cycleId: string;
  directory: string;
  activity: string[];
  peer: AcpPeer;
  startedAt: string;
  timer: Timer | undefined;
  firstLine: string | null;
  finished: boolean;
  /** The exact surface and skill the turn read, for evidence validation. */
  input: AuditInput;
}

interface ForgeRead {
  issues: ApiStandardsIssueRow[];
  openTitles: string[];
}

function boundedLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? "";
  return line.length <= FIRST_LINE_MAX ? line : `${line.slice(0, FIRST_LINE_MAX - 1)}…`;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newestFirst(rows: ApiStandardsIssueRow[]): ApiStandardsIssueRow[] {
  return [...rows].sort((left, right) => {
    const leftAt = Date.parse(left.createdAt);
    const rightAt = Date.parse(right.createdAt);
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
      return rightAt - leftAt;
    }
    return right.number - left.number;
  });
}

function limitLabel(value: number | null): string {
  return value === null ? "unlimited" : String(value);
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/** The normalized title dedupe compares: lowercased, whitespace collapsed, trimmed. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

export class ApiStandardsWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly syncMs: number;
  readonly readTimeoutMs: number;
  readonly timeoutMs: number;
  private readonly cadenceOverrideMs: number | undefined;
  private readonly tickMs: number;
  private readonly agentCommand: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly connect: NonNullable<ApiStandardsWorkerOptions["connect"]>;
  private readonly providerEnvironment: WorkerProviderEnvironment;
  private readonly injectedForge: ApiStandardsForgeClient | undefined;
  private readonly harnessVersion: string | null;
  private readonly log: (line: string) => void;
  private readonly onStopped: (() => void) | undefined;
  private readonly manualCycles: boolean;
  readonly config: ApiStandardsConfig;

  private state: ApiStandardsState;
  private forge: ApiStandardsForgeClient | undefined;
  private active: ActiveCycle | undefined;
  private starting = false;
  private stopping = false;
  private consuming = false;
  private syncing = false;
  private cycling = false;
  /** The consecutive transient failures of the periodic read. */
  private readonly retry = new ForgeReadRetry();
  private openTitles: string[] = [];
  private ticker: Timer | undefined;
  private lock: { release: () => void } | undefined;
  /** The checkout-wide lease for the cycle this worker started. */
  private cycleClaim: { release: () => void } | undefined;
  /** Set by `drain`; no unit starts after it, and the worker exits when idle. */
  private draining = false;
  private lastSaved = "";
  private nextSyncAt = 0;
  private cycleDone: Promise<void> = Promise.resolve();
  private settleCycle: (() => void) | undefined;
  /** The one stop in flight, so a command and a signal share its wait. */
  private stopDone: Promise<void> | undefined;

  constructor(options: ApiStandardsWorkerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.syncMs = Math.max(1000, options.syncMs ?? SYNC_INTERVAL_MS);
    this.cadenceOverrideMs =
      options.cadenceMs === undefined ? undefined : Math.max(0, options.cadenceMs);
    this.tickMs = Math.max(1, options.tickMs ?? TICK_MS);
    this.readTimeoutMs = Math.max(1, options.readTimeoutMs ?? READ_TIMEOUT_MS);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? CYCLE_TIMEOUT_MS);
    this.environment = options.environment ?? process.env;
    this.agentCommand =
      options.agentCommand ??
      this.environment.AGENT_COMMAND ??
      process.env.AGENT_COMMAND ??
      DEFAULT_AGENT_COMMAND;
    this.clock = options.now ?? (() => new Date());
    this.connect =
      options.connect ?? ((peerOptions) => new AcpConnection(peerOptions) as unknown as AcpPeer);
    this.providerEnvironment =
      options.providerEnvironment ??
      createWorkerProviderEnvironment(this.stateDir, this.environment);
    this.injectedForge = options.forge;
    this.harnessVersion =
      options.harnessVersion ??
      process.env.DEVBOARD_HARNESS_VERSION ??
      readHarnessVersion(resolve(import.meta.dir, "..", ".."));
    this.config = options.config ?? apiStandardsConfig();
    this.manualCycles = options.manualCycles === true;
    this.log = options.log ?? (() => undefined);
    this.onStopped = options.onStopped;
    this.state = emptyState({ repo: "", root: this.repoDir, now: this.clock() });
  }

  get currentState(): ApiStandardsState {
    return this.state;
  }

  get cyclingNow(): boolean {
    return this.active !== undefined;
  }

  /** Takes the repository lock and publishes a fresh `idle` cycle. */
  start(repository: string): boolean {
    const lockResult = acquireLock(versionLockPath(lockPath(this.repoDir), this.harnessVersion), {
      repo: this.repoDir,
      stateDir: this.stateDir,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
    });
    if (!lockResult.acquired) {
      this.log(
        `already running for ${this.repoDir} on ${this.harnessVersion ?? "an unknown version"}`,
      );
      return false;
    }
    this.lock = lockResult;
    const previous =
      loadState(versionedStatePath(this.stateDir, this.repoDir, this.harnessVersion)) ??
      loadState(statePath(this.stateDir, this.repoDir));
    const now = this.clock();
    const settings: ApiStandardsSettings =
      readSettings(settingsPath(this.stateDir, this.repoDir)) ?? {
        ...(previous?.limits ?? DEFAULT_LIMITS),
        intervalMinutes: previous?.intervalMinutes ?? DEFAULT_SETTINGS.intervalMinutes,
      };
    this.state = {
      ...emptyState({
        repo: repository,
        root: this.repoDir,
        limit: settings,
        intervalMinutes: settings.intervalMinutes,
        now,
      }),
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: process.pid,
        startedAt: now.toISOString(),
        stateDir: this.stateDir,
        harnessVersion: this.harnessVersion,
        argv: [...process.argv],
      },
      limits: { maxPerHour: settings.maxPerHour, maxPending: settings.maxPending },
      intervalMinutes: settings.intervalMinutes,
      lastCycleStartedAt: previous?.lastCycleStartedAt ?? null,
      issues: previous?.issues ?? [],
      sync: previous?.sync ?? { state: "stale", at: null, error: null },
      newestCycleId: previous?.newestCycleId ?? null,
      lastError: null,
      notice: previous?.notice ?? null,
      updatedAt: now.toISOString(),
    };
    this.forge =
      this.injectedForge ??
      createApiStandardsForge({
        repository,
        repoDir: this.repoDir,
        environment: this.environment,
        timeoutMs: this.readTimeoutMs,
        ...this.forgeOptions(),
      });
    this.nextSyncAt = 0;
    this.publish();
    this.startTicker();
    return true;
  }

  private publish(): void {
    this.state.updatedAt = this.clock().toISOString();
    const text = JSON.stringify(this.state);
    if (text === this.lastSaved) return;
    try {
      writeState(versionedStatePath(this.stateDir, this.repoDir, this.harnessVersion), this.state);
      this.lastSaved = text;
    } catch (error) {
      this.log(`could not write state: ${detailOf(error)}`);
    }
  }

  private startTicker(): void {
    if (this.ticker !== undefined) return;
    this.ticker = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    await this.consumeCommands();
    if (this.stopping || !this.state.enabled) return;
    if (this.draining) {
      if (this.active === undefined && !this.cycling && !this.starting) await this.stop();
      return;
    }
    this.markStale();
    if (this.syncing || this.cycling) return;
    if (this.clock().getTime() >= this.nextSyncAt) {
      await this.refresh();
      if (this.stopping || !this.state.enabled) return;
    }
    if (this.active !== undefined || this.starting) return;
    if (this.state.sync.state !== "ok") return;
    if (this.manualCycles || this.cadenceRemaining()) return;
    await this.beginCycle();
  }

  private markStale(): void {
    // Age while an audit is running says nothing about the read: the cycle
    // already holds the rows a successful read produced, and it must file them.
    if (this.cycling) return;
    if (this.state.sync.state !== "ok") return;
    const at = this.state.sync.at;
    if (at === null) return;
    const last = Date.parse(at);
    if (!Number.isFinite(last)) return;
    if (this.clock().getTime() - last <= 2 * this.syncMs) return;
    this.state.sync = {
      state: "stale",
      at,
      error: `no forge read has succeeded for more than ${Math.round((2 * this.syncMs) / 1000)} seconds`,
    };
    this.publish();
  }

  private cadenceRemaining(): boolean {
    const last = this.state.lastCycleStartedAt;
    if (last === null) return false;
    const started = Date.parse(last);
    if (!Number.isFinite(started)) return false;
    return this.clock().getTime() < started + this.cadenceMs();
  }

  private cadenceMs(): number {
    return this.cadenceOverrideMs ?? this.state.intervalMinutes * 60_000;
  }

  private cadenceReadyAt(now: Date): string | null {
    const last = this.state.lastCycleStartedAt;
    if (last === null) return null;
    const started = Date.parse(last);
    if (!Number.isFinite(started)) return null;
    const ready = started + this.cadenceMs();
    return ready > now.getTime() ? new Date(ready).toISOString() : null;
  }

  private async consumeCommands(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;
    try {
      const directories = [
        versionedControlDirectory(this.stateDir, this.repoDir, this.harnessVersion),
      ];
      // The legacy directory belongs to a live pre-version worker while it
      // runs; a newer worker reading it could steal that worker's drain.
      const legacyLive = liveLockOwners(lockPath(this.repoDir)).some(
        (owner) => owner.harnessVersion === null && owner.pid !== process.pid,
      );
      if (!legacyLive) directories.push(controlDirectory(this.stateDir, this.repoDir));
      for (const directory of new Set(directories)) {
        for (const command of takeCommands(directory)) {
          if (this.stopping) return;
          await this.apply(command);
        }
      }
    } finally {
      this.consuming = false;
    }
  }

  private async apply(command: ApiStandardsCommand): Promise<void> {
    switch (command.type) {
      case "stop":
        await this.stop();
        return;
      case "drain": {
        // A newer version owns new work. Finish the in-flight cycle, then exit.
        this.draining = true;
        this.state.draining = true;
        this.state.lastError = null;
        this.state.notice = "Draining: this worker exits after its in-flight cycle.";
        this.publish();
        return;
      }
      case "limits": {
        if (!isValidLimit(command.maxPerHour) || !isValidLimit(command.maxPending)) {
          this.state.lastError =
            "API Standards limits must be empty or integers from 1 through 100.";
          this.publish();
          return;
        }
        this.state.limits = { maxPerHour: command.maxPerHour, maxPending: command.maxPending };
        this.persistSettings();
        this.state.lastError = null;
        this.state.notice =
          `Limits saved: ${limitLabel(this.state.limits.maxPerHour)} per hour, ` +
          `${limitLabel(this.state.limits.maxPending)} open.`;
        this.publish();
        return;
      }
      case "cadence": {
        if (!isValidCadence(command.intervalMinutes)) {
          this.state.lastError = "API Standards cadence must be 1 through 1440 minutes.";
          this.publish();
          return;
        }
        this.state.intervalMinutes = command.intervalMinutes;
        this.persistSettings();
        this.state.lastError = null;
        this.state.notice = `Cadence saved: every ${command.intervalMinutes} minute(s).`;
        this.publish();
        return;
      }
      case "settings": {
        if (
          !isValidCadence(command.intervalMinutes) ||
          !isValidLimit(command.maxPerHour) ||
          !isValidLimit(command.maxPending)
        ) {
          this.state.lastError =
            "API Standards settings must be 1 through 1440 minutes and nullable 1..100 caps.";
          this.publish();
          return;
        }
        this.state.intervalMinutes = command.intervalMinutes;
        this.state.limits = {
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        this.persistSettings();
        this.state.lastError = null;
        this.state.notice = "Settings saved.";
        this.publish();
        return;
      }
    }
  }

  private persistSettings(): void {
    try {
      writeSettings(settingsPath(this.stateDir, this.repoDir), {
        maxPerHour: this.state.limits.maxPerHour,
        maxPending: this.state.limits.maxPending,
        intervalMinutes: this.state.intervalMinutes,
      });
    } catch (error) {
      this.log(`could not persist settings: ${detailOf(error)}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Capacity                                                            */
  /* ------------------------------------------------------------------ */

  private capacity(now: Date = this.clock()) {
    return capacityFor(this.state.issues, this.state.limits, now);
  }

  /* ------------------------------------------------------------------ */
  /* Forge reads                                                         */
  /* ------------------------------------------------------------------ */

  private forgeOptions(): { forge?: "github" | "gitlab" | "gitea"; baseUrl?: string } {
    const remote = originForge(this.repoDir, this.environment);
    if (remote === undefined) return {};
    return {
      forge: remote.forge,
      ...(remote.forge === "gitea" ? { baseUrl: giteaBaseUrl(remote, this.environment) } : {}),
    };
  }

  private async readForge(): Promise<ForgeRead> {
    const forge = this.forge;
    if (forge === undefined) throw new Error("no forge client is configured");
    const [issues, openTitles] = await Promise.all([
      forge.listIssues(),
      forge.listOpenIssueTitles(),
    ]);
    return {
      issues: newestFirst(
        issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          createdAt: issue.createdAt,
          state: issue.state === "closed" ? "implemented" : "pending",
          category:
            this.state.issues.find((row) => row.number === issue.number)?.category ??
            categoryFromBody(issue.body),
          version: null,
        })),
      ),
      openTitles,
    };
  }

  private async readForgeWithinDeadline(): Promise<ForgeRead> {
    const timedOut = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timedOut.reject(new Error(`the forge read did not finish within ${this.readTimeoutMs} ms`));
    }, this.readTimeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([this.readForge(), timedOut.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async refresh(): Promise<void> {
    if (this.stopping || !this.state.enabled || this.syncing || this.cycling) return;
    this.syncing = true;
    try {
      let read: ForgeRead;
      try {
        read = await this.readForgeWithinDeadline();
      } catch (error) {
        this.recordSyncFailure(detailOf(error));
        return;
      }
      this.applyRead(read);
      this.retry.succeed();
      this.nextSyncAt = this.clock().getTime() + this.syncMs;
      this.publish();
    } finally {
      this.syncing = false;
    }
  }

  private recordSyncFailure(detail: string): void {
    const kind = classifyForgeReadFailure(detail);
    if (kind === "transient") {
      const delay = this.retry.record(kind);
      if (delay !== null) {
        // The retry window is not an alert: the last successful rows and
        // time stay, and the state reads `stale` with no reason.
        this.state.sync = { state: "stale", at: this.state.sync.at, error: null };
        this.nextSyncAt = this.clock().getTime() + delay;
        this.publish();
        return;
      }
    } else {
      this.retry.record(kind);
    }
    this.state.sync = { state: "error", at: this.state.sync.at, error: detail };
    this.state.lastError =
      kind === "rate-limit" || isForgeRateLimited(detail) ? null : detail;
    this.state.notice = `Could not read the forge: ${detail}`;
    this.nextSyncAt = this.clock().getTime() + this.syncMs;
    this.publish();
  }

  private applyRead(read: ForgeRead): void {
    this.state.issues = read.issues;
    this.openTitles = read.openTitles;
    this.state.sync = { state: "ok", at: this.clock().toISOString(), error: null };
    if (!isForgeRateLimited(this.state.lastError ?? "")) this.state.lastError = null;
  }

  /* ------------------------------------------------------------------ */
  /* One cycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Resolves when the cycle that is running now reaches a terminal state. */
  waitForCycle(): Promise<void> {
    return this.cycleDone;
  }

  /** Test seam: one tick against the injected clock, without the ticker. */
  async tickNow(): Promise<void> {
    await this.tick();
  }

  async beginCycle(): Promise<void> {
    if (this.stopping || this.active !== undefined || this.cycling) return;
    if (!this.state.enabled) return;
    // One cycle at a time for the checkout, whatever version started the
    // other worker. The lease is released when this cycle reaches a terminal
    // state, so the replacement takes the next unit only after this one ends.
    const claim = acquireLock(cycleClaimPath(this.repoDir), {
      repo: this.repoDir,
      stateDir: this.stateDir,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
    });
    if (!claim.acquired) return;
    this.cycleClaim = claim;
    this.starting = true;
    this.cycling = true;
    const done = Promise.withResolvers<void>();
    this.cycleDone = done.promise;
    this.settleCycle = done.resolve;
    try {
      const now = this.clock();
      this.state.lastCycleStartedAt = now.toISOString();
      let input: AuditInput;
      try {
        input = readAuditInput(this.repoDir, this.config);
      } catch (error) {
        this.state.lifecycle = "idle";
        this.state.lastError = detailOf(error);
        this.state.notice = `Audit failed: ${detailOf(error)}`;
        this.state.nextAttemptAt = new Date(now.getTime() + this.syncMs).toISOString();
        this.publish();
        this.cycling = false;
        this.releaseCycleClaim();
        this.settleCycle?.();
        this.settleCycle = undefined;
        if (this.draining) void this.stop();
        return;
      }
      const { cycleId, directory } = createCycleDirectory(this.repoDir, now);
      const capacity = this.capacity(now);
      const knownTitles = [
        ...this.state.issues.map((issue) => issue.title),
        ...this.openTitles,
      ];
      writeCycle(directory, {
        cycleId,
        repository: this.state.repo,
        repoDir: this.repoDir,
        input,
        config: this.config,
        knownTitles,
        issueRoom: Number.isFinite(capacity.batch) ? capacity.batch : CYCLE_ISSUE_LIMIT,
        now,
      });
      const prompt = promptFor(directory);
      writeActivity(directory, []);
      const activity: string[] = [];

      const record = (line: string): void => {
        const active = this.active;
        if (active !== undefined && !active.finished) {
          appendActivityLine(active.activity, line, false);
          this.armTimer(active);
          try {
            writeActivity(active.directory, active.activity);
          } catch {
            // Activity is diagnostic; the next entry retries.
          }
          return;
        }
        activity.push(line);
        try {
          writeActivity(directory, activity);
        } catch {
          // The published state is the contract.
        }
      };
      record(
        `cycle ${cycleId}: audited ${input.routes.length} route(s) and ` +
          `${input.sources.length} source file(s); ${input.skill.rules.length} rule(s) from ` +
          `${input.skill.skillPath} and ${input.skill.rulesPath}; room ${capacity.batch}`,
      );

      let peer: AcpPeer;
      try {
        const environment = await this.providerEnvironment();
        peer = this.connect({
          command: this.agentCommand,
          cwd: directory,
          env: {
            ...environment,
            REPO_DIR: this.repoDir,
            STATE_DIR: this.stateDir,
            DEVBOARD_TOOL_LOG: join(directory, "tool-log.jsonl"),
          },
          onActivity: (entry: AcpActivity) => this.recordActivity(entry),
          onSessionUpdate: () => this.notePeerUpdate(),
          onQuestion: (question) => this.answerQuestion(question),
          onStderr: (text) => this.recordStderr(text),
        });
      } catch (error) {
        const detail = detailOf(error);
        this.state.newestCycleId = cycleId;
        this.state.lifecycle = "idle";
        this.state.lastError = detail;
        this.state.notice = `Audit failed: ${detail}`;
        this.state.nextAttemptAt = new Date(now.getTime() + this.syncMs).toISOString();
        this.publish();
        this.cycling = false;
        this.releaseCycleClaim();
        this.settleCycle?.();
        this.settleCycle = undefined;
        if (this.draining) void this.stop();
        return;
      }

      const active: ActiveCycle = {
        cycleId,
        directory,
        activity,
        peer,
        startedAt: now.toISOString(),
        timer: undefined,
        firstLine: null,
        finished: false,
        input,
      };
      this.active = active;
      this.state.newestCycleId = cycleId;
      this.state.lifecycle = "auditing";
      this.state.lastError = null;
      this.state.nextAttemptAt = null;
      this.publish();
      this.armTimer(active);

      void peer
        .run(prompt)
        .then(() => this.completeCycle(active))
        .catch((error: unknown) => {
          const detail = detailOf(error).length > 0 ? detailOf(error) : "the agent failed";
          this.failCycle(active, detail);
        });
    } finally {
      this.starting = false;
    }
  }

  private recordActivity(entry: AcpActivity): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    appendActivityLine(active.activity, entry.text, entry.append);
    this.armTimer(active);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // A write failure must not end the cycle.
    }
  }

  private notePeerUpdate(): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    this.armTimer(active);
  }

  private armTimer(active: ActiveCycle): void {
    clearTimeout(active.timer);
    active.timer = undefined;
    if (active.finished || this.active !== active) return;
    active.timer = setTimeout(() => {
      this.failCycle(active, "the audit timed out");
    }, this.timeoutMs);
    active.timer.unref?.();
  }

  private recordStderr(text: string): void {
    const active = this.active;
    if (active === undefined || active.finished || active.firstLine !== null) return;
    const line = boundedLine(text);
    if (line.length > 0) active.firstLine = line;
  }

  private answerQuestion(question: AcpQuestion): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    appendActivityLine(active.activity, `question: ${question.message}`, false);
    const option = question.options.find((entry) => entry.recommended) ?? question.options[0];
    const value = option?.label ?? "";
    const answered = active.peer.answer(question.id, value);
    appendActivityLine(
      active.activity,
      answered ? `answer: ${value.length === 0 ? "(no options offered)" : value}` : "answer: failed",
      false,
    );
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // Activity is diagnostic.
    }
    this.publish();
  }

  private failCycle(active: ActiveCycle, detail: string): void {
    if (active.finished) return;
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.closePeer(active);
    const error = active.firstLine ?? detail;
    appendActivityLine(active.activity, `failed: ${error}`, false);
    try {
      writeActivity(active.directory, active.activity);
    } catch {
      // Activity is diagnostic.
    }
    this.active = undefined;
    this.cycling = false;
    this.releaseCycleClaim();
    this.settleCycle?.();
    this.settleCycle = undefined;
    if (this.stopping) return;
    // A failed cycle leaves the continuous worker running: the reason is in
    // lastError/agent-error, and the next cadence tick retries.
    this.state.lifecycle = "idle";
    this.state.lastError = error;
    this.state.notice = `Audit failed: ${error}`;
    this.state.nextAttemptAt = new Date(this.clock().getTime() + this.syncMs).toISOString();
    this.publish();
    if (this.draining) void this.stop();
  }

  private closePeer(active: ActiveCycle): void {
    try {
      active.peer.close();
    } catch {
      // The peer already exited.
    }
  }

  /** The cycle's whole terminal path: the tool record and the findings answer. */
  private async completeCycle(active: ActiveCycle): Promise<void> {
    if (active.finished || this.active !== active) return;
    active.finished = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    this.closePeer(active);

    const record = (line: string): void => {
      appendActivityLine(active.activity, line, false);
      try {
        writeActivity(active.directory, active.activity);
      } catch {
        // Activity is diagnostic.
      }
    };

    // Every await after `active.finished = true` sits inside this guard so a
    // thrown findings read or forge read still settles the cycle instead of
    // leaving it active forever with no recorded reason.
    let error: string | null = null;
    try {
      const filed = new Map<string, { number: number; url: string; title: string }>();
      for (const entry of readToolLog(join(active.directory, "tool-log.jsonl"))) {
        if (entry.tool !== "issue_create") continue;
        const number = toolValueNumber(entry.value, "number");
        const title = toolValueString(entry.value, "title");
        const url = toolValueString(entry.value, "url");
        if (entry.ok === true && number !== undefined && title !== undefined) {
          filed.set(normalizeTitle(title), { number, url: url ?? "", title });
          continue;
        }
        const detail =
          typeof entry.error === "string" && entry.error.length > 0
            ? entry.error
            : "the issue-creation tool failed";
        if (error === null) error = detail;
        record(`failed: ${detail}`);
      }

      const answer = readFindings(active.directory);
      const claim = new Map<string, { number: number; url: string }>();
      if (answer === undefined) {
        if (filed.size === 0) record("finished without a findings answer");
      } else {
        const sources = new Map<string, string>(
          active.input.sources.map((file) => [file.path, file.text]),
        );
        const rules = active.input.skill.rules;
        for (const finding of answer.findings) {
          const key = normalizeTitle(finding.title);
          if (finding.decision === "skipped") {
            const reason = finding.reason ?? "skipped";
            record(
              `skipped (${reason}) rule ${finding.ruleId.length > 0 ? finding.ruleId : "—"} ` +
                `${finding.level.length > 0 ? finding.level : "—"}: ${finding.title}`,
            );
            continue;
          }
          const problem = validateFinding(finding, { rules, sources });
          if (!problem.ok) {
            record(
              `dropped (${problem.reason}): ${finding.title.length > 0 ? finding.title : "(no title)"} — ${problem.detail}`,
            );
            continue;
          }
          const created = filed.get(key);
          if (created === undefined) {
            record(`failed: no issue was created for “${finding.title}”`);
            if (error === null) error = `the issue-creation tool recorded no filing for “${finding.title}”`;
            continue;
          }
          claim.set(key, created);
          record(
            `admissible rule ${problem.rule.id} ${problem.rule.level} · ${problem.rule.chapter}: ` +
              `${created.title}`,
          );
          record(`filed #${created.number} ${created.url}`);
        }
        for (const [key, created] of filed) {
          if (claim.has(key)) continue;
          record(`filed #${created.number} ${created.url} “${created.title}”`);
        }
      }

      // The agent filed its findings; re-read the forge so the filed-issue
      // table shows the created rows immediately. A failed read keeps the
      // last-known rows and the periodic read retries.
      if (filed.size > 0 || this.state.issues.length > 0) {
        try {
          this.applyRead(await this.readForgeWithinDeadline());
          this.publish();
        } catch (failure) {
          record(`could not re-read the forge: ${detailOf(failure)}`);
        }
      }
    } catch (failure) {
      const detail = detailOf(failure).length > 0 ? detailOf(failure) : "the cycle failed";
      record(`failed: ${detail}`);
      error = detail;
    } finally {
      this.finishCycle(active, error);
    }
  }

  private releaseCycleClaim(): void {
    this.cycleClaim?.release();
    this.cycleClaim = undefined;
  }

  private finishCycle(active: ActiveCycle, error: string | null): void {
    this.active = undefined;
    this.cycling = false;
    this.releaseCycleClaim();
    this.settleCycle?.();
    this.settleCycle = undefined;
    if (this.stopping) return;
    const now = this.clock();
    this.state.lifecycle = "idle";
    this.state.lastError = error;
    this.state.notice = error === null ? this.state.notice : `API Standards cycle failed: ${error}`;
    const cadenceAt = this.cadenceReadyAt(now);
    const cooldownAt = new Date(now.getTime() + this.syncMs).toISOString();
    this.state.nextAttemptAt = latest(cadenceAt, cooldownAt);
    this.publish();
    if (this.draining) void this.stop();
  }

  /** Stop: end the peer, keep the rows, limits, and last read. */
  async stop(): Promise<void> {
    if (this.stopDone !== undefined) return this.stopDone;
    const done = Promise.withResolvers<void>();
    this.stopDone = done.promise;
    try {
      this.stopping = true;
      const active = this.active;
      if (active !== undefined) {
        active.finished = true;
        clearTimeout(active.timer);
        active.timer = undefined;
        this.closePeer(active);
        appendActivityLine(active.activity, "stopped", false);
        try {
          writeActivity(active.directory, active.activity);
        } catch {
          // Activity is diagnostic.
        }
        this.active = undefined;
      }
      this.cycling = false;
      this.releaseCycleClaim();
      this.settleCycle?.();
      this.settleCycle = undefined;
      this.state.enabled = false;
      this.state.lifecycle = "stopped";
      this.state.nextAttemptAt = null;
      this.state.lastError = null;
      this.state.notice = this.draining ? "Drained: exited after its in-flight cycle." : null;
      this.publish();
      if (this.ticker !== undefined) {
        clearInterval(this.ticker);
        this.ticker = undefined;
      }
      this.lock?.release();
      this.lock = undefined;
      this.onStopped?.();
    } finally {
      done.resolve();
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}

function parseArguments(
  args: string[],
): { repoDir: string; stateDir: string; syncMs?: number } | undefined {
  let repoDir: string | undefined;
  let stateDir: string | undefined;
  let syncMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "--state-dir" || argument === "--sync") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) return undefined;
      if (argument === "--repo") repoDir = value;
      else if (argument === "--state-dir") stateDir = value;
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 1000) syncMs = parsed;
      }
    }
  }
  if (repoDir === undefined || stateDir === undefined) return undefined;
  return { repoDir, stateDir, ...(syncMs === undefined ? {} : { syncMs }) };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    console.error("usage: worker.ts --repo <checkout> --state-dir <dir> [--sync <ms>]");
    process.exit(2);
  }
  const repoDir = resolve(parsed.repoDir);
  const stateDir = resolve(parsed.stateDir);
  const repository = originRepository(repoDir) ?? "";
  if (repository.length === 0) {
    console.error("api-standards worker: the checkout's origin does not name a repository");
    process.exit(2);
  }
  const workerVersion =
    process.env.DEVBOARD_HARNESS_VERSION ??
    readHarnessVersion(resolve(import.meta.dir, "..", ".."));
  if (liveLockOwner(versionLockPath(lockPath(repoDir), workerVersion)) !== undefined) {
    console.error(
      "api-standards worker: this checkout already has a live api-standards agent for this version",
    );
    process.exit(0);
  }
  const worker = new ApiStandardsWorker({
    repoDir,
    stateDir,
    harnessVersion: workerVersion,
    ...(parsed.syncMs === undefined ? {} : { syncMs: parsed.syncMs }),
    log: (line) => console.error(`api-standards: ${line}`),
    onStopped: () => process.exit(0),
  });
  if (!worker.start(repository)) process.exit(0);
  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`api-standards: received ${signal}`);
    void worker.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  await main();
}

/** The `## Chapter` line of an api-standards issue body, for adopted rows. */
function categoryFromBody(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === "## chapter");
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value.length === 0) continue;
    if (value.startsWith("#")) return null;
    return value.length <= 200 ? value : null;
  }
  return null;
}

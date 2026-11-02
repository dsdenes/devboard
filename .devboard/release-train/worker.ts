import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../server/acp";
import { readHarnessVersion } from "../server/version";
import {
  createWorkerProviderEnvironment,
  type WorkerProviderEnvironment,
} from "../server/providers/worker-environment";
import { acquireLock, liveLockOwners, type LockOwner } from "../issues/lock";
import type { AcpPeer } from "../issues/worker";
import { originForge } from "../issues/repository";
import { releaseVersionAt } from "../lib/commit-gate";
import { lowestReleaseVersion } from "../lib/release";
import { giteaReleaseByTag, giteaTarget, type GiteaTarget } from "../lib/gitea";
import {
  checkReleaseTrain,
  type ReleaseTrainCommit,
  type ReleaseTrainGate,
  type ReleaseTrainNothing,
  type ReleaseTrainUnreleased,
} from "../lib/release-train-gate";
import { takeCommands, type ReleaseTrainCommand } from "./control";
import {
  lockPath,
  releaseTrainDirectory,
  requestPath,
  runDirectory,
  runLockPath,
  runsDirectory,
  settingsPath,
  versionedControlDirectory,
  versionedLockPath,
  versionedWorkerDirectory,
  versionedWorkerStatePath,
  workerStateDirectories,
} from "./paths";
import {
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  type ReleaseTrainSettings,
} from "./settings";
import {
  appendActivity,
  emptyState,
  readState,
  readWorkerState,
  recordRun,
  writeState,
  writeWorkerState,
  type ReleaseTrainFailure,
  type ReleaseTrainGateRecord,
  type ReleaseTrainRelease,
  type ReleaseTrainRun,
  type ReleaseTrainState,
  type ReleaseTrainWorkerRecord,
} from "./state";

/**
 * The detached Release Train worker. One worker exists per repository and
 * harness version; every tick runs one deterministic gate and starts exactly
 * one `omp acp` run only when the gate finds a non-merge commit after the
 * newest release tag. The worker never starts a run while another is active,
 * and a failed release leaves its range unreleased for the next due tick.
 */

const TICK_MS = 1_000;
const DEFAULT_AGENT_COMMAND = "omp acp";
const RUN_TIMEOUT_MS = 60 * 60_000;
const RUN_BUSY_NOTICE = "Another Release Train run is active; this tick starts nothing.";
const NPM_PACKAGE = "@dsdenes/devboard";

export interface ReleaseTrainRequest {
  format: 1;
  runId: string;
  range: string;
  target: string;
  version: string;
  previous: string | null;
  commits: ReleaseTrainCommit[];
  releaseCommits: ReleaseTrainCommit[];
}

export interface ReleaseRunInput {
  request: ReleaseTrainRequest;
  /** Appends one line to the run's and the family's activity. */
  activity: (line: string) => void;
  /** The worker's stop flag; a run that sees it must fail rather than release. */
  stopping: () => boolean;
  /** The peer the worker closes when Stop arrives. */
  registerPeer: (peer: AcpPeer) => void;
  /** The absolute run directory the agent reads and answers into. */
  runDir: string;
}

export type ReleaseRunResult =
  | { ok: true; version: string; url: string }
  | { ok: false; detail: string };

export type RunRelease = (input: ReleaseRunInput) => Promise<ReleaseRunResult>;

export interface ReleaseTrainWorkerOptions {
  repoDir: string;
  stateDir: string;
  ownerStateDir?: string;
  harnessVersion?: string | null;
  environment?: Record<string, string | undefined>;
  agentCommand?: string;
  /** Test seam: the ticker interval; production ticks every second. */
  tickMs?: number;
  /** Test seam: no ticker; the caller drives `tickNow`. */
  manual?: boolean;
  now?: () => Date;
  gate?: (repoDir: string) => ReleaseTrainGate | Promise<ReleaseTrainGate>;
  runRelease?: RunRelease;
  providerEnvironment?: WorkerProviderEnvironment;
  log?: (line: string) => void;
  onStopped?: () => void;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function git(repoDir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync({
    cmd: ["git", "-C", repoDir, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode ?? 1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

/** The run agent's outcome document, at the `<run-dir>/result.json` the prompt names. */
export function readResult(runDir: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRunActivity(runDir: string, lines: string[]): void {
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "activity.json"),
      `${JSON.stringify(lines.slice(-200))}\n`,
    );
  } catch {
    // Activity is diagnostic; the next line retries.
  }
}

/** Verifies the release the train expects, from Git, npm, and Gitea. */
async function verifyShipped(options: {
  repoDir: string;
  target: string;
  environment: Record<string, string | undefined>;
  stateDir: string;
  activity: (line: string) => void;
}): Promise<ReleasesResult> {
  const fetched = git(options.repoDir, ["fetch", "--quiet", "--tags", "origin"]);
  if (fetched.code !== 0) {
    return {
      ok: false,
      detail: `could not fetch the release tags: ${firstLine(fetched.stderr || fetched.stdout)}`,
    };
  }
  let version = releaseVersionAt(options.repoDir, options.target);
  if (version === undefined) {
    const contains = git(options.repoDir, ["tag", "--contains", options.target, "--list", "v*"]);
    if (contains.code !== 0) {
      return {
        ok: false,
        detail: `could not read the tags containing ${options.target.slice(0, 7)}: ` +
          firstLine(contains.stderr || contains.stdout),
      };
    }
    version = lowestReleaseVersion(
      contains.stdout
        .split("\n")
        .map((line) => /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(line.trim())?.[1])
        .filter((entry): entry is string => entry !== undefined),
    );
  }
  if (version === undefined) {
    return {
      ok: false,
      detail: `no release tag names or contains ${options.target.slice(0, 7)}`,
    };
  }
  const tag = `v${version}`;
  options.activity(`verified ${tag} names or contains ${options.target.slice(0, 7)}`);

  const npm = Bun.spawnSync({
    cmd: [
      "npm",
      "view",
      `${NPM_PACKAGE}@${version}`,
      "version",
      "--cache",
      join(options.stateDir, "npm-cache"),
      "--prefer-online",
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (npm.exitCode !== 0 || npm.stdout.toString().trim() !== version) {
    return {
      ok: false,
      detail:
        `${NPM_PACKAGE}@${version} is not visible on npmjs: ` +
        firstLine(npm.stderr.toString() || npm.stdout.toString()),
    };
  }

  const remote = originForge(options.repoDir, options.environment);
  let target: GiteaTarget | undefined;
  try {
    target = giteaTarget({ remote, environment: options.environment });
  } catch (error) {
    return { ok: false, detail: `the Gitea release could not be read: ${detailOf(error)}` };
  }
  if (target === undefined) {
    return { ok: false, detail: "the Gitea release could not be read: no Gitea origin" };
  }
  let release;
  try {
    release = await giteaReleaseByTag(target, tag);
  } catch (error) {
    return {
      ok: false,
      detail: `the Gitea release ${tag} could not be read: ${detailOf(error)}`,
    };
  }
  if (release === undefined) {
    return { ok: false, detail: `the Gitea release ${tag} does not exist` };
  }
  const names = new Set((release.assets ?? []).map((asset) => asset.name));
  for (const asset of [`devboard-${version}.tgz`, `devboard-${version}.tgz.sha256`]) {
    if (!names.has(asset)) {
      return { ok: false, detail: `the Gitea release ${tag} is missing ${asset}` };
    }
  }
  const url = `${target.baseUrl.replace(/\/+$/, "")}/${target.project}/releases/tag/${tag}`;
  options.activity(`verified ${NPM_PACKAGE}@${version} and the Gitea assets`);
  return { ok: true, version, url };
}

type ReleasesResult =
  | { ok: true; version: string; url: string }
  | { ok: false; detail: string };

export class ReleaseTrainWorker {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly ownerStateDir: string;
  readonly harnessVersion: string | null;
  private readonly environment: Record<string, string | undefined>;
  private readonly agentCommand: string;
  private readonly tickMs: number;
  private readonly manual: boolean;
  private readonly clock: () => Date;
  private readonly gate: (repoDir: string) => ReleaseTrainGate | Promise<ReleaseTrainGate>;
  private readonly runRelease: RunRelease;
  private readonly providerEnvironment: WorkerProviderEnvironment;
  private readonly log: (line: string) => void;
  private readonly onStopped: (() => void) | undefined;
  private readonly directory: string;
  private readonly versionDirectory: string;
  private readonly versionControlDirectory: string;
  private readonly versionWorkerPath: string;

  private shared: ReleaseTrainState;
  private settings: ReleaseTrainSettings;
  private worker: ReleaseTrainWorkerRecord | undefined;
  private lock: { release: () => void } | undefined;
  private timer: Timer | undefined;
  private controlTimer: Timer | undefined;
  private stopping = false;
  private paused = false;
  private ticking = false;
  private tickPromise: Promise<void> | undefined;
  private activeRun: ReleaseTrainRun | undefined;
  private activeActivity: string[] = [];
  private activePeer: AcpPeer | undefined;
  private nextRunAtMs = 0;
  private lastRunAt: string | null = null;

  constructor(options: ReleaseTrainWorkerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.ownerStateDir = resolve(options.ownerStateDir ?? options.stateDir);
    this.environment = options.environment ?? process.env;
    this.agentCommand =
      options.agentCommand ?? this.environment.AGENT_COMMAND ?? DEFAULT_AGENT_COMMAND;
    this.harnessVersion =
      options.harnessVersion === undefined
        ? (process.env.DEVBOARD_HARNESS_VERSION ??
          readHarnessVersion(resolve(import.meta.dir, "..")))
        : options.harnessVersion;
    this.tickMs = Math.max(20, options.tickMs ?? TICK_MS);
    this.manual = options.manual === true;
    this.clock = options.now ?? (() => new Date());
    this.gate = options.gate ?? ((repoDir) => checkReleaseTrain(repoDir));
    this.runRelease = options.runRelease ?? ((input) => this.executeRelease(input));
    this.providerEnvironment =
      options.providerEnvironment ?? createWorkerProviderEnvironment(this.stateDir, this.environment);
    this.log = options.log ?? ((line) => console.error(line));
    this.onStopped = options.onStopped;
    this.directory = releaseTrainDirectory(this.stateDir);
    this.versionDirectory = versionedWorkerDirectory(this.directory, this.harnessVersion);
    this.versionControlDirectory = versionedControlDirectory(this.directory, this.harnessVersion);
    this.versionWorkerPath = versionedWorkerStatePath(this.directory, this.harnessVersion);
    this.shared = emptyState({ repo: "", root: this.repoDir, now: this.clock() });
    this.settings = { ...DEFAULT_SETTINGS };
  }

  get currentState(): ReleaseTrainState {
    return this.shared;
  }

  get currentWorker(): ReleaseTrainWorkerRecord | undefined {
    return this.worker;
  }

  /** Takes this version's worker lock; false means another live worker owns it. */
  begin(startTicker = true): boolean {
    this.shared =
      readState(this.directory) ?? emptyState({ repo: "", root: this.repoDir, now: this.clock() });
    this.settings = readSettings(this.directory);
    const prior = readWorkerState(this.versionWorkerPath);
    this.lastRunAt = prior?.lastRunAt ?? null;
    const priorNext = prior?.nextRunAt === null || prior?.nextRunAt === undefined
      ? Number.NaN
      : Date.parse(prior.nextRunAt);
    this.nextRunAtMs = Number.isFinite(priorNext) ? priorNext : this.clock().getTime();
    const lock = acquireLock(versionedLockPath(this.directory, this.harnessVersion), {
      repo: this.repoDir,
      stateDir: this.ownerStateDir,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
    });
    if (!lock.acquired) {
      this.log(
        `release train worker: already running` +
          `${lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`}`,
      );
      return false;
    }
    this.lock = lock;
    this.worker = {
      version: 1,
      pid: process.pid,
      startedAt: this.clock().toISOString(),
      root: this.repoDir,
      stateDir: this.ownerStateDir,
      lifecycle: "running",
      enabled: true,
      paused: false,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
      lastRunAt: this.lastRunAt,
      nextRunAt: new Date(this.nextRunAtMs).toISOString(),
      lastError: null,
      notice: null,
      activeRun: null,
      updatedAt: this.clock().toISOString(),
    };
    this.publishWorker();
    this.controlTimer = setInterval(() => this.consume(), 250);
    this.controlTimer.unref?.();
    if (startTicker && !this.manual) {
      this.timer = setInterval(() => void this.guardTick(), this.tickMs);
      this.timer.unref?.();
    }
    return true;
  }

  /** Runs until Stop or a drain ends the worker. */
  async run(): Promise<number> {
    if (!this.begin(false)) return 0;
    try {
      while (!this.stopping) {
        await this.guardTick();
        if (this.stopping) break;
        await Bun.sleep(this.tickMs);
      }
    } finally {
      this.finish();
    }
    return 0;
  }

  /** Test seam: one forced tick against the injected gate. */
  async tickNow(): Promise<void> {
    await this.tick(true);
  }

  /** Stops this worker and closes any active peer. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.activePeer?.close();
    if (this.tickPromise !== undefined) {
      try {
        await this.tickPromise;
      } catch {
        // The failure is already recorded by the tick.
      }
    }
    this.finish();
  }

  private async guardTick(): Promise<void> {
    try {
      await this.tick(false);
    } catch (error) {
      this.log(`release train tick: ${detailOf(error)}`);
    }
  }

  private async tick(force: boolean): Promise<void> {
    if (this.stopping || this.paused || this.activeRun !== undefined || this.ticking) return;
    const now = this.clock();
    if (!force && now.getTime() < this.nextRunAtMs) return;
    this.ticking = true;
    const promise = this.runTick(now).finally(() => {
      this.ticking = false;
      this.tickPromise = undefined;
    });
    this.tickPromise = promise;
    await promise;
  }

  private async runTick(now: Date): Promise<void> {
    const lease = acquireLock(runLockPath(this.directory), {
      repo: this.repoDir,
      stateDir: this.ownerStateDir,
      harnessVersion: this.harnessVersion,
      argv: [...process.argv],
    });
    if (!lease.acquired) {
      this.setNotice(RUN_BUSY_NOTICE);
      this.nextRunAtMs = now.getTime() + Math.min(5_000, Math.max(this.tickMs, 1_000));
      this.publishWorker();
      return;
    }
    try {
      const verdict = await this.gate(this.repoDir);
      this.recordGate(verdict, now);
      if (verdict.state === "error") {
        this.activity(`release check failed: ${verdict.detail}`);
        this.setNotice(verdict.detail);
        if (this.worker !== undefined) this.worker.lastError = verdict.detail;
        this.finishTick(now);
        return;
      }
      if (verdict.state === "nothing") {
        const retry = this.retryVerdict(verdict);
        if (retry !== undefined) {
          this.activity(`retrying the failed release of ${verdict.target.slice(0, 7)}`);
          await this.execute(retry, now);
          return;
        }
        this.activity(
          `nothing to release: ${verdict.target.slice(0, 7)} is covered by ` +
            `${verdict.previous?.tag ?? "no release tag"}`,
        );
        this.setNotice("nothing to release");
        if (this.worker !== undefined) this.worker.lastError = null;
        this.finishTick(now);
        return;
      }
      await this.execute(verdict, now);
    } finally {
      lease.release();
    }
  }

  /** A failed range whose tag now exists is retried until a run verifies it. */
  private retryVerdict(nothing: ReleaseTrainNothing): ReleaseTrainUnreleased | undefined {
    const failure = this.shared.failure;
    if (failure === null || failure.version === null) return undefined;
    if (failure.sha !== nothing.target) return undefined;
    return {
      state: "unreleased",
      target: nothing.target,
      previous: nothing.previous,
      range: failure.range,
      version: failure.version,
      commits: [],
      releaseCommits: [],
    };
  }

  private async execute(gate: ReleaseTrainUnreleased, now: Date): Promise<void> {
    const runId = `${now.getTime()}-${randomUUID().slice(0, 8)}`;
    const run: ReleaseTrainRun = {
      id: runId,
      startedAt: now.toISOString(),
      endedAt: null,
      state: "running",
      range: gate.range,
      target: gate.target,
      version: gate.version,
      url: null,
      detail: null,
      // A retry verdict verifies an already-tagged range and carries no list.
      commits: gate.releaseCommits.length > 0 ? gate.releaseCommits.length : null,
    };
    this.activeRun = run;
    this.activeActivity = [];
    this.shared.runs = recordRun(this.shared.runs, run);
    if (this.worker !== undefined) {
      this.worker.activeRun = runId;
      this.worker.lifecycle = "running";
      this.worker.notice = `releasing ${gate.range}`;
      this.publishWorker();
    }
    this.activity(
      `releasing ${gate.range}: ${gate.releaseCommits.length} non-merge commit(s), ` +
        `version ${gate.version}`,
    );
    const runDir = runDirectory(this.directory, runId);
    mkdirSync(runDir, { recursive: true });
    const request: ReleaseTrainRequest = {
      format: 1,
      runId,
      range: gate.range,
      target: gate.target,
      version: gate.version,
      previous: gate.previous?.tag ?? null,
      commits: gate.commits,
      releaseCommits: gate.releaseCommits,
    };
    writeFileSync(requestPath(this.directory, runId), `${JSON.stringify(request, null, 2)}\n`);
    writeRunActivity(runDir, this.activeActivity);

    let result: ReleaseRunResult;
    try {
      result = await this.runRelease({
        request,
        activity: (line) => this.activity(line),
        stopping: () => this.stopping,
        registerPeer: (peer) => {
          this.activePeer = peer;
        },
        runDir,
      });
    } catch (error) {
      result = { ok: false, detail: detailOf(error) };
    } finally {
      this.activePeer = undefined;
    }

    const endedAt = this.clock().toISOString();
    run.endedAt = endedAt;
    if (result.ok) {
      const release: ReleaseTrainRelease = {
        version: result.version,
        url: result.url,
        at: endedAt,
        sha: gate.target,
        range: gate.range,
      };
      this.shared.release = release;
      this.shared.failure = null;
      run.state = "released";
      run.version = result.version;
      run.url = result.url;
      this.activity(`released v${result.version}: ${result.url}`);
      this.setNotice(`released v${result.version}`);
      if (this.worker !== undefined) {
        this.worker.lifecycle = "running";
        this.worker.lastError = null;
      }
    } else {
      const failure: ReleaseTrainFailure = {
        at: endedAt,
        detail: result.detail,
        sha: gate.target,
        range: gate.range,
        version: gate.version,
      };
      this.shared.failure = failure;
      run.state = "failed";
      run.detail = result.detail;
      this.activity(`release failed: ${result.detail}`);
      this.setNotice(`release failed: ${result.detail}`);
      if (this.worker !== undefined) {
        this.worker.lifecycle = "failed";
        this.worker.lastError = result.detail;
      }
    }
    this.shared.runs = recordRun(this.shared.runs, run);
    this.activeRun = undefined;
    if (this.worker !== undefined) this.worker.activeRun = null;
    this.finishTick(now);
  }

  private recordGate(verdict: ReleaseTrainGate, now: Date): void {
    this.shared.gate = {
      at: now.toISOString(),
      state: verdict.state,
      detail: verdict.state === "error" ? verdict.detail : null,
      target: verdict.state === "error" ? null : verdict.target,
      range: verdict.state === "error" ? null : verdict.range,
      version: verdict.state === "unreleased" ? verdict.version : null,
    };
  }

  private finishTick(now: Date): void {
    this.lastRunAt = now.toISOString();
    this.nextRunAtMs = now.getTime() + Math.max(60_000, this.settings.intervalMinutes * 60_000);
    if (this.worker !== undefined) {
      this.worker.lastRunAt = this.lastRunAt;
      this.worker.nextRunAt = new Date(this.nextRunAtMs).toISOString();
      this.worker.lifecycle =
        this.worker.lastError === null ? (this.worker.paused ? "stopped" : "running") : "failed";
      this.publishWorker();
    }
    this.persistShared();
  }

  private setNotice(notice: string | null): void {
    if (this.worker !== undefined) this.worker.notice = notice;
    this.publishWorker();
  }

  private activity(line: string): void {
    this.shared.activity = appendActivity(this.shared.activity, line);
    if (this.activeRun !== undefined) {
      this.activeActivity = appendActivity(this.activeActivity, line);
      writeRunActivity(runDirectory(this.directory, this.activeRun.id), this.activeActivity);
    }
    this.persistShared();
  }

  private persistShared(): void {
    this.shared.updatedAt = this.clock().toISOString();
    try {
      writeState(this.directory, this.shared);
    } catch (error) {
      this.log(`could not write the Release Train state: ${detailOf(error)}`);
    }
  }

  private publishWorker(): void {
    if (this.worker === undefined) return;
    this.worker.updatedAt = this.clock().toISOString();
    try {
      writeWorkerState(this.versionWorkerPath, this.worker);
    } catch (error) {
      this.log(`could not write the Release Train worker state: ${detailOf(error)}`);
    }
  }

  private finish(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.controlTimer !== undefined) {
      clearInterval(this.controlTimer);
      this.controlTimer = undefined;
    }
    if (this.worker !== undefined) {
      this.worker.lifecycle = "stopped";
      this.worker.enabled = false;
      this.worker.notice = null;
      this.publishWorker();
    }
    this.lock?.release();
    this.lock = undefined;
    this.onStopped?.();
  }

  /** Consumes the dashboard's control files between ticks. */
  consume(): void {
    for (const command of takeCommands(this.versionControlDirectory)) {
      this.apply(command);
    }
  }

  private apply(command: ReleaseTrainCommand): void {
    switch (command.type) {
      case "stop":
        void this.stop();
        return;
      case "drain":
        if (this.worker !== undefined) this.worker.notice = "draining after the active run";
        this.stopping = true;
        return;
      case "pause":
        this.paused = true;
        if (this.worker !== undefined) this.worker.paused = true;
        this.setNotice("paused");
        this.publishWorker();
        return;
      case "resume":
        this.paused = false;
        this.nextRunAtMs = this.clock().getTime();
        if (this.worker !== undefined) this.worker.paused = false;
        this.setNotice("resumed");
        this.publishWorker();
        return;
      case "check":
        this.nextRunAtMs = this.clock().getTime();
        this.setNotice("check requested");
        return;
      case "settings":
        this.settings = {
          ...readSettings(this.directory),
          intervalMinutes: command.intervalMinutes,
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        writeSettings(this.directory, this.settings);
        this.nextRunAtMs = Math.min(
          this.nextRunAtMs,
          this.clock().getTime() + this.settings.intervalMinutes * 60_000,
        );
        if (this.worker !== undefined) {
          this.worker.nextRunAt = new Date(this.nextRunAtMs).toISOString();
        }
        this.setNotice(`settings saved: every ${command.intervalMinutes} minute(s)`);
        return;
    }
  }

  /** The default run: one `omp acp` peer, then independent release verification. */
  private async executeRelease(input: ReleaseRunInput): Promise<ReleaseRunResult> {
    const environment = await this.providerEnvironment();
    const runDir = input.runDir;
    let peer: AcpPeer;
    try {
      peer = new AcpConnection({
        command: this.agentCommand,
        cwd: this.repoDir,
        env: {
          ...environment,
          REPO_DIR: this.repoDir,
          STATE_DIR: this.stateDir,
          DEVBOARD_RELEASE_RUN_DIR: runDir,
        },
        onActivity: (entry: AcpActivity) => input.activity(entry.text),
        onSessionUpdate: () => undefined,
        onQuestion: (question: AcpQuestion) => {
          const choice = question.options.find((option) => option.recommended) ?? question.options[0];
          if (choice !== undefined) peer.answer(question.id, choice.label);
        },
        onStderr: (text) => {
          const line = firstLine(text);
          if (line !== "no diagnostic") input.activity(line);
        },
      }) as AcpPeer;
    } catch (error) {
      return { ok: false, detail: `could not start the release agent: ${detailOf(error)}` };
    }
    input.registerPeer(peer);
    let agentError: string | null = null;
    try {
      if (input.stopping()) return { ok: false, detail: "stopped before the release agent started" };
      input.activity(`starting ${this.agentCommand} for ${input.request.range}`);
      const timedOut = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        timedOut.reject(new Error("the release agent did not finish within 60 minutes"));
      }, RUN_TIMEOUT_MS);
      timer.unref?.();
      try {
        await Promise.race([peer.run(`/release-train ${runDir}`), timedOut.promise]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      agentError = detailOf(error);
    } finally {
      peer.close();
    }
    if (input.stopping()) return { ok: false, detail: "stopped during the release run" };
    const result = readResult(runDir);
    const verified = await verifyShipped({
      repoDir: this.repoDir,
      target: input.request.target,
      environment,
      stateDir: this.stateDir,
      activity: input.activity,
    });
    if (verified.ok) {
      if (agentError !== null) {
        input.activity(`the agent ended with: ${agentError}; the release is verified`);
      }
      return verified;
    }
    const reported =
      result !== undefined &&
      result.ok === false &&
      typeof result.detail === "string" &&
      result.detail.trim().length > 0
        ? result.detail.trim()
        : null;
    const detail = [agentError, reported, verified.detail]
      .filter((entry): entry is string => entry !== null && entry.length > 0)
      .join("; ");
    return { ok: false, detail };
  }
}

/** Live owners of the family's shared lock, across every harness version. */
export function releaseTrainOwners(directory: string): LockOwner[] {
  return liveLockOwners(lockPath(directory));
}

/** One version's worker records, newest first by update time. */
export function releaseTrainWorkerStates(directory: string): ReleaseTrainWorkerRecord[] {
  const states: ReleaseTrainWorkerRecord[] = [];
  for (const workerDirectory of workerStateDirectories(directory)) {
    const state = readWorkerState(join(workerDirectory, "worker.json"));
    if (state !== undefined) states.push(state);
  }
  return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export { runsDirectory, settingsPath };

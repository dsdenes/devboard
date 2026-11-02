import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "../server/acp";
import { readHarnessVersion } from "../server/version";
import {
  createWorkerProviderEnvironment,
  type WorkerProviderEnvironment,
} from "../server/providers/worker-environment";
import { acquireLock, liveLockOwners, type LockOwner, type LockResult } from "../issues/lock";
import type { AcpPeer } from "../issues/worker";
import { originForge } from "../issues/repository";
import { releaseTags, releaseVersionAt } from "../lib/commit-gate";
import { lowestReleaseVersion } from "../lib/release";
import {
  giteaReleaseByTag,
  giteaTarget,
  type GiteaReleaseDocument,
  type GiteaTarget,
} from "../lib/gitea";
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
  mergeState,
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
  /**
   * The worker's stop flag; a release never starts after it is set, and a run
   * that has already ended is verified regardless of it.
   */
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
  /** Test seam: the independent release verification; defaults to `verifyShipped`. */
  verify?: typeof verifyShipped;
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

/** The part of a release the verification read, for a failure that names it. */
export type ReleaseVerificationPhase = "tag" | "npm" | "gitea";

export type ReleaseVerification =
  | { ok: true; version: string; url: string }
  | { ok: false; phase: ReleaseVerificationPhase; version: string; detail: string };

/**
 * npm's normal propagation lag: a version the publish accepted minutes ago can
 * still answer E404 from a different registry edge. The verification retries
 * inside this window before it calls the release failed, so a healthy publish
 * is never recorded as a failure.
 */
export const NPM_VISIBILITY_WINDOW_MS = 10 * 60_000;
export const NPM_VISIBILITY_POLL_MS = 15_000;

export interface ReleaseVerificationOptions {
  repoDir: string;
  /** The commit the run released. */
  target: string;
  /** The version the gate asked this run to release. */
  version: string;
  environment: Record<string, string | undefined>;
  stateDir: string;
  activity: (line: string) => void;
  /** Refreshes the checkout's tags; the default fetches the origin's. */
  refresh?: (repoDir: string) => { code: number; stdout: string; stderr: string };
  /** Reads one npm version; the default shells out to `npm view`. */
  npmView?: (version: string) => { code: number; stdout: string; stderr: string };
  /** Reads one Gitea release and its page URL; the default uses the origin's forge. */
  readRelease?: (
    tag: string,
  ) => Promise<{ release: GiteaReleaseDocument | undefined; url: string }>;
  sleep?: (ms: number) => Promise<void>;
  /** Bounds the npm retry; tests shrink it. */
  npmWindowMs?: number;
  npmPollMs?: number;
}

/** Verifies the release the train expects, from Git, npm, and Gitea. */
export async function verifyShipped(
  options: ReleaseVerificationOptions,
): Promise<ReleaseVerification> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const refresh =
    options.refresh ?? ((repoDir: string) => git(repoDir, ["fetch", "--quiet", "--tags", "origin"]));
  const fetched = refresh(options.repoDir);
  if (fetched.code !== 0) {
    return {
      ok: false,
      phase: "tag",
      version: options.version,
      detail:
        `tag binding: could not refresh the release tags for v${options.version}: ` +
        firstLine(fetched.stderr || fetched.stdout),
    };
  }
  const contains = git(options.repoDir, ["tag", "--contains", options.target, "--list", "v*"]);
  if (contains.code !== 0) {
    return {
      ok: false,
      phase: "tag",
      version: options.version,
      detail:
        `tag binding: could not read the tags containing ${options.target.slice(0, 7)} ` +
        `for v${options.version}: ${firstLine(contains.stderr || contains.stdout)}`,
    };
  }
  const version =
    releaseVersionAt(options.repoDir, options.target) ??
    lowestReleaseVersion(
      contains.stdout
        .split("\n")
        .map((line) => /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(line.trim())?.[1])
        .filter((entry): entry is string => entry !== undefined),
    );
  if (version === undefined) {
    return {
      ok: false,
      phase: "tag",
      version: options.version,
      detail:
        `tag binding: no release tag names or contains ${options.target.slice(0, 7)} ` +
        `for v${options.version}`,
    };
  }
  const tag = `v${version}`;
  options.activity(`verified ${tag} names or contains ${options.target.slice(0, 7)}`);

  const npmView =
    options.npmView ??
    ((candidate: string) => {
      const child = Bun.spawnSync({
        cmd: [
          "npm",
          "view",
          `${NPM_PACKAGE}@${candidate}`,
          "version",
          "--cache",
          join(options.stateDir, "npm-cache"),
          "--prefer-online",
        ],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: child.exitCode ?? 1,
        stdout: child.stdout.toString().trim(),
        stderr: child.stderr.toString().trim(),
      };
    });
  const windowMs = options.npmWindowMs ?? NPM_VISIBILITY_WINDOW_MS;
  const pollMs = options.npmPollMs ?? NPM_VISIBILITY_POLL_MS;
  const deadline = Date.now() + windowMs;
  let lastDetail = "npm view answered nothing";
  let reads = 0;
  for (;;) {
    reads += 1;
    const read = npmView(version);
    if (read.code === 0 && read.stdout.trim() === version) break;
    lastDetail = firstLine(read.stderr || read.stdout);
    if (Date.now() >= deadline) {
      return {
        ok: false,
        phase: "npm",
        version,
        detail:
          `npm visibility: ${NPM_PACKAGE}@${version} is not visible on npmjs after ` +
          `${Math.round(windowMs / 1000)}s and ${reads} read(s): ${lastDetail}`,
      };
    }
    options.activity(`waiting for ${NPM_PACKAGE}@${version} on npmjs: ${lastDetail}`);
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  let read: { release: GiteaReleaseDocument | undefined; url: string };
  try {
    read = await (options.readRelease ?? defaultReleaseReader(options))(tag);
  } catch (error) {
    return {
      ok: false,
      phase: "gitea",
      version,
      detail: `Gitea release assets: the release ${tag} could not be read: ${detailOf(error)}`,
    };
  }
  if (read.release === undefined) {
    return {
      ok: false,
      phase: "gitea",
      version,
      detail: `Gitea release assets: the release ${tag} does not exist`,
    };
  }
  const names = new Set((read.release.assets ?? []).map((asset) => asset.name));
  for (const asset of [`devboard-${version}.tgz`, `devboard-${version}.tgz.sha256`]) {
    if (!names.has(asset)) {
      return {
        ok: false,
        phase: "gitea",
        version,
        detail: `Gitea release assets: the release ${tag} is missing ${asset}`,
      };
    }
  }
  options.activity(`verified ${NPM_PACKAGE}@${version} and the Gitea assets`);
  return { ok: true, version, url: read.url };
}

/** The origin forge's release reader and its page URL. */
function defaultReleaseReader(
  options: ReleaseVerificationOptions,
): (tag: string) => Promise<{ release: GiteaReleaseDocument | undefined; url: string }> {
  return async (tag) => {
    const remote = originForge(options.repoDir, options.environment);
    const target = giteaTarget({ remote, environment: options.environment });
    if (target === undefined) throw new Error("no Gitea origin");
    const release = await giteaReleaseByTag(target, tag);
    return {
      release,
      url: `${target.baseUrl.replace(/\/+$/, "")}/${target.project}/releases/tag/${tag}`,
    };
  };
}

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
  private readonly verify: typeof verifyShipped;
  private readonly providerEnvironment: WorkerProviderEnvironment;
  private readonly log: (line: string) => void;
  private readonly onStopped: (() => void) | undefined;
  private readonly directory: string;
  private readonly versionDirectory: string;
  private readonly versionControlDirectory: string;
  private readonly versionWorkerPath: string;

  private shared: ReleaseTrainState;
  /** Activity lines written since the last shared-state persist, for the merge. */
  private pendingActivity: string[] = [];
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
    this.verify = options.verify ?? verifyShipped;
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

  /** Test seam: one tick against the injected gate, forced unless `force` is false. */
  async tickNow(force = true): Promise<void> {
    await this.tick(force);
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
    let lease: LockResult | undefined;
    try {
      lease = acquireLock(runLockPath(this.directory), {
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
        if (await this.retryFailure(verdict, now)) return;
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
    } catch (error) {
      this.failTick(error, now);
    } finally {
      if (lease !== undefined && lease.acquired) lease.release();
    }
  }

  /**
   * A tick that throws settles like a failed run: the thrown detail reaches the
   * shared failure and the worker record, the run it opened is closed, and the
   * cadence moves a full interval ahead. Without that, the one-second loop
   * re-reads the gate forever and the page keeps the previous verdict.
   */
  private failTick(error: unknown, now: Date): void {
    const detail = detailOf(error);
    const at = this.clock().toISOString();
    const run = this.activeRun;
    this.activeRun = undefined;
    this.activeActivity = [];
    this.shared.failure = {
      at,
      detail,
      sha: run?.target ?? "",
      range: run?.range ?? "",
      version: run?.version ?? null,
    };
    if (run !== undefined) {
      run.endedAt = at;
      run.state = "failed";
      run.detail = detail;
      this.shared.runs = recordRun(this.shared.runs, run);
    }
    if (this.worker !== undefined) {
      this.worker.lifecycle = "failed";
      this.worker.lastError = detail;
      this.worker.activeRun = null;
    }
    this.activity(`release train tick failed: ${detail}`);
    this.setNotice(`release train tick failed: ${detail}`);
    this.finishTick(now);
  }

  /**
   * A recorded failure whose own version tag now exists needs no new agent:
   * the gate reports nothing because that tag covers the tip, so the release
   * shipped and only its record is missing. Verify it and record the outcome.
   */
  private async retryFailure(verdict: ReleaseTrainNothing, now: Date): Promise<boolean> {
    const failure = this.shared.failure;
    if (failure === null || failure.version === null) return false;
    if (!this.failureIsTagged(failure, verdict.target)) return false;
    const version = failure.version;
    const target = failure.sha;
    const runId = `${now.getTime()}-${randomUUID().slice(0, 8)}`;
    const run: ReleaseTrainRun = {
      id: runId,
      startedAt: now.toISOString(),
      endedAt: null,
      state: "running",
      range: failure.range,
      target,
      version,
      url: null,
      detail: null,
      commits: null,
    };
    this.activeRun = run;
    this.activeActivity = [];
    this.shared.runs = recordRun(this.shared.runs, run);
    if (this.worker !== undefined) {
      this.worker.activeRun = runId;
      this.worker.lifecycle = "running";
      this.worker.notice = `verifying ${failure.range}`;
      this.publishWorker();
    }
    this.activity(`verifying the failed release of ${failure.range} as v${version}`);
    let result: ReleaseRunResult;
    try {
      result = await this.verify({
        repoDir: this.repoDir,
        target,
        version,
        environment: await this.providerEnvironment(),
        stateDir: this.stateDir,
        activity: (line) => this.activity(line),
      });
    } catch (error) {
      result = { ok: false, detail: detailOf(error) };
    }
    this.settle(run, result, { target, range: failure.range, version }, now);
    return true;
  }

  /** Whether the failure's own version tag now exists at or after its commit. */
  private failureIsTagged(failure: ReleaseTrainFailure, tip: string): boolean {
    if (failure.version === null) return false;
    if (releaseVersionAt(this.repoDir, failure.sha) === failure.version) return true;
    return releaseTags(this.repoDir, tip).some((tag) => tag.version === failure.version);
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

    this.settle(run, result, { target: gate.target, range: gate.range, version: gate.version }, now);
  }

  /** Records one run's verified or failed outcome on the shared state. */
  private settle(
    run: ReleaseTrainRun,
    result: ReleaseRunResult,
    identity: { target: string; range: string; version: string | null },
    now: Date,
  ): void {
    const endedAt = this.clock().toISOString();
    run.endedAt = endedAt;
    if (result.ok) {
      const release: ReleaseTrainRelease = {
        version: result.version,
        url: result.url,
        at: endedAt,
        sha: identity.target,
        range: identity.range,
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
        sha: identity.target,
        range: identity.range,
        version: identity.version,
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
    // The cadence runs from the tick's end, not its start: a run that outlasts
    // the interval still earns a full gap before the next tick is due.
    const endedAtMs = this.clock().getTime();
    this.nextRunAtMs =
      endedAtMs + Math.max(60_000, this.settings.intervalMinutes * 60_000);
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
    this.pendingActivity = appendActivity(this.pendingActivity, line);
    if (this.activeRun !== undefined) {
      this.activeActivity = appendActivity(this.activeActivity, line);
      writeRunActivity(runDirectory(this.directory, this.activeRun.id), this.activeActivity);
    }
    this.persistShared();
  }

  /**
   * Writes this worker's shared state as a merge with a fresh read, so a newer
   * version's worker settling a release during a takeover is never erased by
   * the draining worker's snapshot, and the reverse. Every caller runs inside a
   * tick that holds the family's run lease, so the read and the write cannot
   * interleave with another worker's.
   */
  private persistShared(): void {
    this.shared.updatedAt = this.clock().toISOString();
    try {
      const disk = readState(this.directory);
      const next =
        disk === undefined ? this.shared : mergeState(this.shared, disk, this.pendingActivity);
      writeState(this.directory, next);
      this.shared = next;
      this.pendingActivity = [];
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
    // A stop or drain never skips the verification: the agent may already have
    // published, so the record must say whether the release actually shipped.
    const stopped = input.stopping();
    if (stopped) input.activity("stopped during the release run; verifying what it shipped");
    const result = readResult(runDir);
    const verified = await this.verify({
      repoDir: this.repoDir,
      target: input.request.target,
      version: input.request.version,
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
    const detail = [
      stopped ? "stopped during the release run" : null,
      agentError,
      reported,
      verified.detail,
    ]
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

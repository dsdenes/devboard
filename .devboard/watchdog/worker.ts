import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireWorkerLock, liveLockOwners, pidAlive } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import { runCycle } from "./coordinator";
import { claimCycle } from "./lock";
import { takeWatchdogCommands, type WatchdogCommand } from "./control";
import { loadRootEnvironment } from "./env";
import {
  controlDirectory,
  cycleClaimPath,
  lockPath,
  versionedControlDirectory,
  versionedWorkerDirectory,
  watchdogDirectory,
} from "./paths";
import {
  readWatchdogSettings,
  writeWatchdogSettings,
  type WatchdogSettings,
} from "./settings";
import {
  readNewestWorkerState,
  readWorkerState,
  writeWorkerState,
  type WatchdogWorkerState,
} from "./worker-state";

/**
 * The dashboard-started detached watchdog worker. One instance exists per
 * harness version per host root; a newer version's worker can run beside an
 * older one during a takeover, so the versioned lock plus the cycle lease are
 * what keep one unit from being claimed twice.
 */

const CONTROL_POLL_MS = 250;

export interface Parsed {
  root: string;
  stateDir?: string;
  ownerStateDir?: string;
}

function parseArguments(args: string[]): Parsed | undefined {
  let root: string | undefined;
  let stateDir: string | undefined;
  let ownerStateDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      root = args[index + 1];
      index += 1;
    } else if (argument === "--state-dir") {
      stateDir = args[index + 1];
      index += 1;
    } else if (argument === "--owner-state-dir") {
      ownerStateDir = args[index + 1];
      index += 1;
    }
  }
  if (root === undefined || root.length === 0) return undefined;
  return {
    root,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(ownerStateDir === undefined ? {} : { ownerStateDir }),
  };
}

function gitTopLevel(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", dirname(import.meta.dir), "rev-parse", "--show-toplevel"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const top = result.stdout.toString().trim();
  return result.exitCode === 0 && top.length > 0 ? top : undefined;
}

/** One cycle's observable outcome; the real coordinator supplies it. */
export type WatchdogCycleRunner = (options: {
  root: string;
  stateDir: string;
  providerStateDir: string;
  windowMs: number;
  settings: WatchdogSettings;
}) => Promise<{ report: { action: string; reason?: string } }>;

export interface WatchdogWorkerOptions {
  root: string;
  /** The machine-level watchdog directory. */
  stateDir: string;
  /** The dashboard STATE_DIR whose projection the worker refreshes. */
  ownerStateDir: string;
  harnessVersion: string | null;
  /** Test seam; production runs the real cycle. */
  cycle?: WatchdogCycleRunner;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WatchdogWorkerResult {
  /** False when a live worker of this version already holds the lock. */
  acquired: boolean;
  ownerPid?: number;
}

export async function runWorker(options: WatchdogWorkerOptions): Promise<WatchdogWorkerResult> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const ownerStateDir = resolve(options.ownerStateDir);
  const harnessVersion = options.harnessVersion;
  const cycle = options.cycle ?? runCycle;
  const pollMs = options.pollMs ?? CONTROL_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const directory = versionedWorkerDirectory(stateDir, harnessVersion);

  const lock = acquireWorkerLock(lockPath(stateDir), harnessVersion, {
    repo: root,
    stateDir: ownerStateDir,
    harnessVersion,
    argv: [...process.argv],
  });
  if (!lock.acquired) {
    return {
      acquired: false,
      ...(lock.owner === undefined ? {} : { ownerPid: lock.owner.pid }),
    };
  }

  // The predecessor's cadence is the family's cadence: a new version must not
  // start a second cycle for a window the old worker is already running.
  const previous = readNewestWorkerState(stateDir);
  const startedAt = new Date().toISOString();
  let settings: WatchdogSettings = readWatchdogSettings(stateDir);
  let stopping = false;
  let draining = false;
  let lastRunAt: string | null = previous?.lastRunAt ?? null;
  let nextRunAt: string | null = null;
  let lastError: string | null = null;
  let notice: string | null = null;

  const publish = (lifecycle: WatchdogWorkerState["lifecycle"], enabled: boolean): void => {
    writeWorkerState(directory, {
      version: 1,
      pid: process.pid,
      startedAt,
      root,
      stateDir: ownerStateDir,
      lifecycle,
      enabled,
      harnessVersion,
      argv: [...process.argv],
      lastRunAt,
      nextRunAt,
      lastError,
      notice,
      ...(draining ? { draining: true } : {}),
      updatedAt: new Date().toISOString(),
    });
  };

  const cadenceMs = (): number => Math.max(60_000, settings.intervalMinutes * 60_000);
  const recomputeNext = (): void => {
    if (lastRunAt === null) {
      nextRunAt = new Date().toISOString();
      return;
    }
    const started = Date.parse(lastRunAt);
    nextRunAt = Number.isFinite(started)
      ? new Date(started + cadenceMs()).toISOString()
      : new Date().toISOString();
  };
  recomputeNext();

  // The dashboard's Stop writes a control command; a signal is the same
  // request. Either way the running cycle finishes and the finally below
  // publishes stopped, releases the lock, and leaves the cycle's report.
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    publish("stopping", false);
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  /** A newer version owns new work; finish the in-flight cycle, then exit. */
  const requestDrain = (): void => {
    if (stopping) {
      draining = true;
      publish("stopping", false);
      return;
    }
    draining = true;
    notice = "Draining: the newer harness owns new cycles; finishing the in-flight cycle, then exiting.";
    requestStop();
  };

  const apply = (command: WatchdogCommand): void => {
    switch (command.type) {
      case "stop":
        requestStop();
        return;
      case "drain":
        requestDrain();
        return;
      case "settings":
        settings = {
          ...settings,
          intervalMinutes: command.intervalMinutes,
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        writeWatchdogSettings(stateDir, settings);
        recomputeNext();
        notice = `Settings saved: every ${command.intervalMinutes} minute(s).`;
        publish("running", true);
        return;
    }
  };

  // A versioned worker still consumes the legacy control directory an older
  // dashboard may write, so a rolling upgrade never strands a command. While a
  // pre-version worker is live, that directory is its channel: reading it here
  // would steal the drain meant for it.
  const legacyWorkerLive = (): boolean => {
    const lock = liveLockOwners(lockPath(stateDir)).some(
      (owner) => owner.harnessVersion === null && owner.pid !== process.pid,
    );
    if (lock) return true;
    const state = readWorkerState(stateDir);
    return (
      state !== undefined &&
      state.pid !== process.pid &&
      state.lifecycle !== "stopped" &&
      pidAlive(state.pid)
    );
  };
  const consume = (): void => {
    for (const command of takeWatchdogCommands(
      versionedControlDirectory(stateDir, harnessVersion),
    )) {
      apply(command);
    }
    if (!legacyWorkerLive() && existsSync(controlDirectory(stateDir))) {
      for (const command of takeWatchdogCommands(controlDirectory(stateDir))) apply(command);
    }
  };

  publish("running", true);
  const controlTimer = setInterval(consume, pollMs);

  try {
    while (!stopping) {
      consume();
      if (stopping) break;
      const now = Date.now();
      const next = nextRunAt === null ? now : Date.parse(nextRunAt);
      if (!Number.isFinite(next) || now >= next) {
        const claim = claimCycle(cycleClaimPath(stateDir), { harnessVersion });
        if (claim === undefined) {
          // Another version's in-flight cycle owns this unit. Adopt its
          // cadence so the family runs one cycle, not one per version.
          const winner = readNewestWorkerState(stateDir);
          if (winner !== undefined && winner.lastRunAt !== null) {
            lastRunAt = winner.lastRunAt;
            recomputeNext();
          }
          await sleep(pollMs);
          continue;
        }
        try {
          lastRunAt = new Date().toISOString();
          settings = readWatchdogSettings(stateDir);
          nextRunAt = new Date(Date.parse(lastRunAt) + cadenceMs()).toISOString();
          publish("running", true);
          try {
            const result = await cycle({
              root,
              stateDir,
              providerStateDir: ownerStateDir,
              windowMs: cadenceMs(),
              settings,
            });
            lastError = result.report.action === "failed" ? (result.report.reason ?? null) : null;
            notice = result.report.reason ?? null;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
          consume();
          if (stopping) break;
          settings = readWatchdogSettings(stateDir);
          recomputeNext();
          publish("running", true);
        } finally {
          claim.release();
        }
        continue;
      }
      await sleep(Math.min(pollMs, Math.max(1, next - now)));
    }
  } finally {
    clearInterval(controlTimer);
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    consume();
    publish("stopped", false);
    lock.release();
  }
  return { acquired: true };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const top = parsed?.root ?? gitTopLevel();
  if (top === undefined) {
    console.error("watchdog worker: the harness is not inside a git checkout");
    process.exit(2);
  }
  const root = resolve(top);
  if (!existsSync(join(root, ".devboard"))) {
    console.error(`watchdog worker: missing prerequisite: ${join(root, ".devboard")} does not exist`);
    process.exit(2);
  }
  loadRootEnvironment(root);
  const stateDir = resolve(parsed?.stateDir ?? watchdogDirectory(root));
  const ownerStateDir = resolve(parsed?.ownerStateDir ?? stateDir);
  const harnessVersion =
    process.env.DEVBOARD_HARNESS_VERSION ??
    readHarnessVersion(resolve(import.meta.dir, ".."));
  const result = await runWorker({ root, stateDir, ownerStateDir, harnessVersion });
  if (!result.acquired) {
    console.error(
      `watchdog worker: already running for this version${
        result.ownerPid === undefined ? "" : ` (pid ${result.ownerPid})`
      }`,
    );
    process.exit(0);
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}

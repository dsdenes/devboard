import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readHarnessVersion } from "../server/version";
import { runCycle } from "./coordinator";
import { takeWatchdogCommands, type WatchdogCommand } from "./control";
import { loadRootEnvironment } from "./env";
import { acquireLock } from "./lock";
import { controlDirectory, lockPath, watchdogDirectory } from "./paths";
import {
  readWatchdogSettings,
  writeWatchdogSettings,
  type WatchdogSettings,
} from "./settings";
import { writeWorkerState, type WatchdogWorkerState } from "./worker-state";

/**
 * The dashboard-started detached watchdog worker. One instance exists per host
 * root; it owns the machine lock and the cycle cadence, reads settings and
 * control files between cycles, and survives every dashboard restart.
 */

const CONTROL_POLL_MS = 250;

interface Parsed {
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
  const lock = acquireLock(lockPath(stateDir));
  if (!lock.acquired) {
    console.error(
      `watchdog worker: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner})`}`,
    );
    process.exit(0);
  }

  const harnessVersion = readHarnessVersion(resolve(import.meta.dir, ".."));
  const startedAt = new Date().toISOString();
  let settings: WatchdogSettings = readWatchdogSettings(stateDir);
  let stopping = false;
  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  let lastError: string | null = null;
  let notice: string | null = null;

  const publish = (lifecycle: WatchdogWorkerState["lifecycle"], enabled: boolean): void => {
    writeWorkerState(stateDir, {
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

  const apply = (command: WatchdogCommand): void => {
    switch (command.type) {
      case "stop":
        stopping = true;
        publish("stopping", false);
        return;
      case "limits":
        settings = {
          ...settings,
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        writeWatchdogSettings(stateDir, settings);
        notice = "Limits saved.";
        publish("running", true);
        return;
      case "cadence":
        settings = { ...settings, intervalMinutes: command.intervalMinutes };
        writeWatchdogSettings(stateDir, settings);
        recomputeNext();
        notice = `Cadence saved: every ${command.intervalMinutes} minute(s).`;
        publish("running", true);
        return;
    }
  };

  const consume = (): void => {
    for (const command of takeWatchdogCommands(controlDirectory(stateDir))) apply(command);
  };

  publish("running", true);
  const controlTimer = setInterval(consume, CONTROL_POLL_MS);

  try {
    while (!stopping) {
      consume();
      if (stopping) break;
      const now = Date.now();
      const next = nextRunAt === null ? now : Date.parse(nextRunAt);
      if (!Number.isFinite(next) || now >= next) {
        lastRunAt = new Date().toISOString();
        settings = readWatchdogSettings(stateDir);
        nextRunAt = new Date(Date.parse(lastRunAt) + cadenceMs()).toISOString();
        publish("running", true);
        try {
          const result = await runCycle({
            root,
            stateDir,
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
        continue;
      }
      await Bun.sleep(Math.min(CONTROL_POLL_MS, Math.max(1, next - now)));
    }
  } finally {
    clearInterval(controlTimer);
    consume();
    publish("stopped", false);
    lock.release();
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}

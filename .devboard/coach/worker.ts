import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import { runCycle } from "./coordinator";
import { takeCoachCommands, type CoachCommand } from "./control";
import { describeCycle } from "./coordinator";
import { coachDirectory, controlDirectory, lockPath } from "./paths";
import { readCoachSettings, writeCoachSettings, type CoachSettings } from "./settings";
import { writeWorkerState, type CoachWorkerState } from "./worker-state";

/**
 * The dashboard-started detached Coach worker. One instance exists per
 * repository state directory; it owns the lock and the cadence, reads settings
 * and control files between cycles, and survives every dashboard restart.
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
    console.error("coach worker: the harness is not inside a git checkout");
    process.exit(2);
  }
  const root = resolve(top);
  if (!existsSync(join(root, ".devboard"))) {
    console.error(`coach worker: missing prerequisite: ${join(root, ".devboard")} does not exist`);
    process.exit(2);
  }
  const stateDir = resolve(parsed?.stateDir ?? join(root, ".devboard", ".tmp"));
  const ownerStateDir = resolve(parsed?.ownerStateDir ?? stateDir);
  const coachDir = coachDirectory(stateDir);
  const harnessVersion = readHarnessVersion(resolve(import.meta.dir, ".."));
  const lock = acquireLock(lockPath(coachDir), {
    repo: root,
    stateDir: ownerStateDir,
    harnessVersion,
    argv: [...process.argv],
  });
  if (!lock.acquired) {
    console.error(
      `coach worker: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`}`,
    );
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  let settings: CoachSettings = readCoachSettings(coachDir);
  let stopping = false;
  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  let lastError: string | null = null;
  let notice: string | null = null;

  const publish = (lifecycle: CoachWorkerState["lifecycle"], enabled: boolean): void => {
    writeWorkerState(coachDir, {
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

  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    publish("stopping", false);
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  const apply = (command: CoachCommand): void => {
    switch (command.type) {
      case "stop":
        requestStop();
        return;
      case "settings": {
        // Read-modify-write against the file. The in-memory copy can predate a
        // dashboard save made since the last read, so writing it back would
        // replace the operator's allowlist and maxIssuesPerCycle with stale
        // values. Only the three cadence keys come from the command.
        settings = {
          ...readCoachSettings(coachDir),
          intervalMinutes: command.intervalMinutes,
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        writeCoachSettings(coachDir, settings);
        recomputeNext();
        notice = `Settings saved: every ${command.intervalMinutes} minute(s).`;
        publish("running", true);
        return;
      }
    }
  };

  const consume = (): void => {
    for (const command of takeCoachCommands(controlDirectory(coachDir))) apply(command);
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
        settings = readCoachSettings(coachDir);
        nextRunAt = new Date(Date.parse(lastRunAt) + cadenceMs()).toISOString();
        publish("running", true);
        try {
          const result = await runCycle({
            root,
            stateDir,
            now: new Date(),
            settings,
            environment: process.env,
          });
          lastError = result.report.action === "failed" ? (result.report.reason ?? null) : null;
          notice = result.report.reason ?? null;
          console.error(describeCycle(result));
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        consume();
        if (stopping) break;
        settings = readCoachSettings(coachDir);
        recomputeNext();
        publish("running", true);
        continue;
      }
      await Bun.sleep(Math.min(CONTROL_POLL_MS, Math.max(1, next - now)));
    }
  } finally {
    clearInterval(controlTimer);
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    consume();
    publish("stopped", false);
    lock.release();
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}

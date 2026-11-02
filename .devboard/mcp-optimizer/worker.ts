import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import { runCycle, describeCycle } from "./coordinator";
import { takeMcpOptimizerCommands, type McpOptimizerCommand } from "./control";
import {
  mcpOptimizerDirectory,
  controlDirectory,
  cycleLockPath,
  versionedControlDirectory,
  versionedLockPath,
  versionedWorkerDirectory,
} from "./paths";
import { readMcpOptimizerSettings, writeMcpOptimizerSettings, type McpOptimizerSettings } from "./settings";
import { readWorkerState, writeWorkerState, type McpOptimizerWorkerState } from "./worker-state";

/**
 * The dashboard-started detached MCP optimizer worker. One instance exists per
 * repository state directory and harness version; it owns that version's lock
 * and cadence, reads settings and control files between cycles, and survives
 * every dashboard restart. The versioned worker and cycle leases are what let a
 * newer harness take over: the drained worker finishes its in-flight cycle and
 * exits, and only then can the next version's worker claim a cycle.
 */

const CONTROL_POLL_MS = 250;
/** Published when another version's worker holds the one cycle lease. */
export const CYCLE_BUSY_NOTICE =
  "Another MCP optimizer worker is running a cycle; this worker retries shortly.";

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

export interface McpOptimizerWorkerOptions {
  /** The checkout the cycle reads. */
  root: string;
  /** The dashboard's STATE_DIR; MCP optimizer files live under its `coach/`. */
  stateDir: string;
  /** The STATE_DIR that decides ownership; defaults to `stateDir`. */
  ownerStateDir?: string;
  /** The harness version this worker runs; defaults to the source tree's. */
  harnessVersion?: string | null;
  /** Test seam: the cycle function, defaulting to the real cycle. */
  cycle?: typeof runCycle;
  /** Test seam: how often control files are consumed. */
  controlPollMs?: number;
  /** Test seam: replaces stderr reporting. */
  log?: (line: string) => void;
}

/**
 * Runs one detached worker until Stop, Drain, or a signal ends it. Returns the
 * process exit code; the caller owns the process.
 */
export async function runWorker(options: McpOptimizerWorkerOptions): Promise<number> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const ownerStateDir = resolve(options.ownerStateDir ?? stateDir);
  const mcpOptimizerDir = mcpOptimizerDirectory(stateDir);
  const harnessVersion =
    options.harnessVersion === undefined
      ? (process.env.DEVBOARD_HARNESS_VERSION ??
        readHarnessVersion(resolve(import.meta.dir, "..")))
      : options.harnessVersion;
  const cycle = options.cycle ?? runCycle;
  const log = options.log ?? ((line: string) => console.error(line));
  const controlPollMs = Math.max(10, options.controlPollMs ?? CONTROL_POLL_MS);
  const versionDirectory = versionedWorkerDirectory(mcpOptimizerDir, harnessVersion);
  const versionControlDirectory = versionedControlDirectory(mcpOptimizerDir, harnessVersion);

  // A worker of another version never holds this path, so a takeover can
  // start beside it; only the same version's live worker refuses this start.
  const lock = acquireLock(versionedLockPath(mcpOptimizerDir, harnessVersion), {
    repo: root,
    stateDir: ownerStateDir,
    harnessVersion,
    argv: [...process.argv],
  });
  if (!lock.acquired) {
    log(`mcp-optimizer worker: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`}`);
    return 0;
  }

  const prior = readWorkerState(versionDirectory) ?? readWorkerState(mcpOptimizerDir);
  const startedAt = new Date().toISOString();
  let settings: McpOptimizerSettings = readMcpOptimizerSettings(mcpOptimizerDir);
  let stopping = false;
  let draining = false;
  let lastRunAt: string | null = prior?.lastRunAt ?? null;
  let nextRunAt: string | null = prior?.nextRunAt ?? null;
  let lastError: string | null = null;
  let notice: string | null = null;

  const publish = (lifecycle: McpOptimizerWorkerState["lifecycle"], enabled: boolean): void => {
    writeWorkerState(versionDirectory, {
      version: 1,
      pid: process.pid,
      startedAt,
      root,
      stateDir: ownerStateDir,
      lifecycle,
      enabled,
      ...(draining ? { draining: true } : {}),
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

  const apply = (command: McpOptimizerCommand): void => {
    switch (command.type) {
      case "stop":
        requestStop();
        return;
      case "drain":
        // A newer version owns new work. The in-flight cycle, if any, keeps
        // running; the loop starts nothing new and exits once it is done.
        draining = true;
        notice = "Draining: this worker finishes its in-flight cycle, then exits.";
        publish("stopping", false);
        return;
      case "settings": {
        // Read-modify-write against the file. The in-memory copy can predate a
        // dashboard save made since the last read, so writing it back would
        // replace the operator's allowlist and maxIssuesPerCycle with stale
        // values. Only the three cadence keys come from the command.
        settings = {
          ...readMcpOptimizerSettings(mcpOptimizerDir),
          intervalMinutes: command.intervalMinutes,
          maxPerHour: command.maxPerHour,
          maxPending: command.maxPending,
        };
        writeMcpOptimizerSettings(mcpOptimizerDir, settings);
        recomputeNext();
        notice = `Settings saved: every ${command.intervalMinutes} minute(s).`;
        publish("running", true);
        return;
      }
    }
  };

  const consume = (): void => {
    // Settings and the legacy control directory are shared, so an operator
    // command written by an older dashboard is honoured alongside this
    // version's own control files.
    if (existsSync(controlDirectory(mcpOptimizerDir))) {
      for (const command of takeMcpOptimizerCommands(controlDirectory(mcpOptimizerDir))) apply(command);
    }
    for (const command of takeMcpOptimizerCommands(versionControlDirectory)) apply(command);
  };

  publish("running", true);
  if (nextRunAt === null) recomputeNext();
  const controlTimer = setInterval(consume, controlPollMs);

  try {
    while (!stopping && !draining) {
      consume();
      if (stopping || draining) break;
      const now = Date.now();
      const next = nextRunAt === null ? now : Date.parse(nextRunAt);
      if (!Number.isFinite(next) || now >= next) {
        settings = readMcpOptimizerSettings(mcpOptimizerDir);
        // One cycle at a time across every version: the lease is held only for
        // the cycle, so a drained worker's in-flight unit is never re-run by
        // its replacement.
        const lease = acquireLock(cycleLockPath(mcpOptimizerDir), {
          repo: root,
          stateDir: ownerStateDir,
          harnessVersion,
          argv: [...process.argv],
        });
        if (!lease.acquired) {
          notice = CYCLE_BUSY_NOTICE;
          nextRunAt = new Date(Date.now() + controlPollMs).toISOString();
          publish("running", true);
          continue;
        }
        lastRunAt = new Date().toISOString();
        nextRunAt = new Date(Date.parse(lastRunAt) + cadenceMs()).toISOString();
        notice = null;
        publish("running", true);
        try {
          const result = await cycle({
            root,
            stateDir,
            now: new Date(),
            settings,
            environment: process.env,
          });
          lastError = result.report.action === "failed" ? (result.report.reason ?? null) : null;
          notice = result.report.reason ?? null;
          log(describeCycle(result));
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        } finally {
          lease.release();
        }
        consume();
        if (stopping || draining) break;
        settings = readMcpOptimizerSettings(mcpOptimizerDir);
        recomputeNext();
        publish("running", true);
        continue;
      }
      await Bun.sleep(Math.min(controlPollMs, Math.max(1, next - now)));
    }
  } finally {
    clearInterval(controlTimer);
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    consume();
    publish("stopped", false);
    lock.release();
  }
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const top = parsed?.root ?? gitTopLevel();
  if (top === undefined) {
    console.error("mcp-optimizer worker: the harness is not inside a git checkout");
    process.exit(2);
  }
  const root = resolve(top);
  if (!existsSync(join(root, ".devboard"))) {
    console.error(`mcp-optimizer worker: missing prerequisite: ${join(root, ".devboard")} does not exist`);
    process.exit(2);
  }
  const stateDir = resolve(parsed?.stateDir ?? join(root, ".devboard", ".tmp"));
  const ownerStateDir = resolve(parsed?.ownerStateDir ?? stateDir);
  const code = await runWorker({ root, stateDir, ownerStateDir });
  process.exit(code);
}

if (import.meta.main) {
  await main();
}

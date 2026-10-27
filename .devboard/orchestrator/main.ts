import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IssueOrchestrator, dryRunReport } from "./coordinator";
import { acquireLock, lockPath } from "./lock";
import { readLedger } from "./ledger";
import {
  harnessDirectory,
  isRepositoryName,
  originRepository,
  rootProblem,
  topLevel,
} from "./repository";
import { agentArgv } from "./runner";
import { orchestratorDirectory, readStateFile, statePath } from "./state";
import { listOpenIssues } from "./tracker";

/**
 * The single-instance issue orchestrator. It polls the origin tracker, spawns
 * the operator's implement-all-issues command once per unhandled backlog, and
 * publishes the state the dashboard's status item reads. It never decides with
 * a model, never creates a worktree, commit, push, label, or issue, and never
 * needs a dashboard to be alive.
 */

const usage = `Usage: bun run orchestrator [options]

Polls the origin repository's open issues and runs the operator's
implement-all-issues command once per unhandled backlog.

  --root <path>        Canonical checkout root. Defaults to this checkout.
  --repo <owner/name>  Repository to poll. Defaults to the checkout's origin.
  --state-dir <path>   State, ledger, lock, and logs. Defaults to <root>/.devboard/.tmp.
  --interval <time>    Poll interval: 60, 90s, or 500ms. Defaults to 60 seconds.
  --once               Poll once, run once (and any follow-up), then exit.
  --dry-run            Print one JSON report and exit; write nothing.
  -h, --help           Show this text.
`;

interface Options {
  root: string;
  repository: string;
  stateDir: string;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
}

function fail(message: string): never {
  console.error(`orchestrator: ${message}`);
  process.exit(2);
}

/** `60` is seconds; `90s`, `1m`, and `500ms` are explicit. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "m" ? 60_000 : 1000;
  return Math.round(value * factor);
}

function parseArguments(args: string[]): Options | "help" {
  let rootOption: string | undefined;
  let repoOption: string | undefined;
  let stateDirOption: string | undefined;
  let intervalMs = 60_000;
  let once = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") return "help";
    if (argument === "--once") {
      once = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo" || argument === "--state-dir") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) fail(`${argument} needs a value`);
      if (argument === "--root") rootOption = value;
      else if (argument === "--repo") repoOption = value;
      else stateDirOption = value;
      continue;
    }
    if (argument === "--interval") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) fail("--interval needs a value");
      const parsed = parseDuration(value);
      if (parsed === undefined) fail(`--interval does not name a duration: ${value}`);
      intervalMs = parsed;
      continue;
    }
    fail(`unknown option ${argument}`);
  }

  const discovered = topLevel(dirname(import.meta.dir));
  if (rootOption === undefined && discovered === undefined) {
    fail("the harness is not inside a git checkout; pass --root");
  }
  const root = resolve(rootOption ?? discovered!);
  const problem = rootProblem(root);
  if (problem !== undefined) fail(problem.message);

  const origin = originRepository(root);
  if (repoOption !== undefined && !isRepositoryName(repoOption)) {
    fail(`--repo is not owner/name: ${repoOption}`);
  }
  if (repoOption !== undefined && origin !== undefined && repoOption !== origin) {
    fail(`--repo ${repoOption} is not the checkout's origin (${origin})`);
  }
  if (repoOption !== undefined && origin === undefined) {
    fail(`--repo ${repoOption} cannot be verified: the checkout has no origin remote`);
  }
  const repository = repoOption ?? origin;
  if (repository === undefined) {
    fail(`the checkout's origin does not name a repository; pass --repo`);
  }

  return {
    root,
    repository,
    stateDir: resolve(stateDirOption ?? join(root, ".devboard", ".tmp")),
    intervalMs,
    once: once || dryRun,
    dryRun,
  };
}

/** Appends the loop's own lines to `<state-dir>/orchestrator/orchestrator.log`. */
function logger(stateDir: string): (line: string) => void {
  const path = join(orchestratorDirectory(stateDir), "orchestrator.log");
  mkdirSync(dirname(path), { recursive: true });
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(`orchestrator: ${line}`);
    try {
      appendFileSync(path, `${stamped}\n`);
    } catch {
      // The journal still carries the line when the file cannot be written.
    }
  };
}

async function dryRun(options: Options): Promise<void> {
  try {
    const issues = await listOpenIssues({ repository: options.repository });
    const report = dryRunReport({
      repository: options.repository,
      issues,
      ledger: readLedger(options.stateDir),
      state: readStateFile(statePath(options.stateDir)),
      now: new Date(),
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    console.log(usage);
    return;
  }
  const options = parsed;

  if (options.dryRun) {
    await dryRun(options);
    return;
  }

  const lock = acquireLock(lockPath(options.stateDir));
  if (!lock.acquired) {
    const owner = lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`;
    console.log(`orchestrator: already running${owner}`);
    return;
  }

  const log = logger(options.stateDir);
  const argv = agentArgv();
  const orchestrator = new IssueOrchestrator({
    root: options.root,
    repository: options.repository,
    stateDir: options.stateDir,
    listIssues: () => listOpenIssues({ repository: options.repository }),
    argv,
    intervalMs: options.intervalMs,
    once: options.once,
    log,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, stopping`);
    void orchestrator
      .stop()
      .catch((error: unknown) => {
        log(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        lock.release();
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log(
    `watching ${options.repository} at ${options.root} every ${options.intervalMs}ms ` +
      `with ${argv.join(" ")}`,
  );
  try {
    await orchestrator.run();
  } catch (error) {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    lock.release();
    process.exit(1);
  }
  if (shuttingDown) {
    // The signal handler owns the exit: it releases the lock only after the
    // stop transition is on disk.
    await new Promise(() => undefined);
  }
  lock.release();
}

// `bun run orchestrator -- --help` exits 0 without touching anything on disk.
await main();
process.exit(0);

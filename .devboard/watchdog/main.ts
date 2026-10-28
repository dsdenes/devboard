import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCycle } from "./coordinator";
import { loadRootEnvironment } from "./env";
import { acquireLock } from "./lock";

/**
 * `bun run watchdog -- --once` runs one cycle; `--collect --dry-run` prints the
 * cycle's report and changes nothing. The systemd oneshot service runs the
 * former. Both respect the machine-wide lock.
 */

const usage = `Usage: bun run watchdog [options]

Runs one watchdog cycle over the last ten minutes of dashboard evidence and
files one GitHub issue per distinct signal.

  --once             Discover, collect, and file. The default.
  --collect          Collect and print the report; requires --dry-run.
  --dry-run          Print the report without filing, writing, or changing anything.
  --root <path>      Explicit canonical repository root.
  -h, --help         Show this text.
`;

const args = process.argv.slice(2);
let once = false;
let collect = false;
let dryRun = false;
let rootOption: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--once") once = true;
  else if (argument === "--collect") collect = true;
  else if (argument === "--dry-run") dryRun = true;
  else if (argument === "--root") {
    rootOption = args[index + 1];
    index += 1;
    if (rootOption === undefined) {
      console.error("watchdog: --root needs a path");
      process.exit(2);
    }
  } else if (argument === "-h" || argument === "--help") {
    console.log(usage);
    process.exit(0);
  } else {
    console.error(`watchdog: unknown option ${argument}`);
    console.error(usage);
    process.exit(2);
  }
}

if (collect && !dryRun) {
  console.error("watchdog: --collect runs with --dry-run");
  process.exit(2);
}

if (once && (collect || dryRun)) {
  console.error("watchdog: --once and --dry-run are exclusive");
  process.exit(2);
}

function gitTopLevel(): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", dirname(import.meta.dir), "rev-parse", "--show-toplevel"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const top = result.stdout.toString().trim();
  if (result.exitCode !== 0 || top.length === 0) {
    console.error("watchdog: the harness is not inside a git checkout");
    process.exit(2);
  }
  return top;
}

const root = resolve(rootOption ?? gitTopLevel());
if (!existsSync(join(root, ".devboard"))) {
  console.error(`watchdog: missing prerequisite: ${join(root, ".devboard")} does not exist`);
  process.exit(2);
}

// systemd starts this process in the harness directory with only PATH, so the
// host root's `.env` must be read here rather than relying on the working
// directory. Explicit values still win.
loadRootEnvironment(root);

const lock = acquireLock(join(root, ".devboard", ".tmp", "watchdog", "lock"));
if (!lock.acquired) {
  console.log(
    `watchdog: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner})`}`,
  );
  process.exit(0);
}

let exitCode = 0;
try {
  const result = await runCycle({ root, dryRun: dryRun || collect });
  if (dryRun || collect) {
    console.log(JSON.stringify(result.report, null, 2));
  }
  exitCode = result.exitCode;
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`watchdog: ${detail}`);
  exitCode = 1;
} finally {
  lock.release();
}

process.exit(exitCode);

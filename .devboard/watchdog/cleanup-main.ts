import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCleanup } from "./cleanup";
import { discoverInstances } from "./discovery";

/**
 * `bun run cleanup -- --dry-run` prints one week's retention plan for every
 * covered state directory; `--once` applies it. The watchdog cycle performs
 * the same sweep; this entry point exists for operators and verification.
 */

const usage = `Usage: bun run cleanup [options]

Removes entries older than seven days from every devboard state directory the
watchdog covers: the canonical checkout, its direct siblings, and live
dashboards. Journal retention stays with the journal.

  --once             Delete every eligible entry. The default is dry-run.
  --dry-run          Print the plan and change nothing.
  --root <path>      Canonical repository root. Defaults to this checkout.
  -h, --help         Show this text.
`;

const args = process.argv.slice(2);
let once = false;
let dryRun = false;
let rootOption: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--once") once = true;
  else if (argument === "--dry-run") dryRun = true;
  else if (argument === "--root") {
    rootOption = args[index + 1];
    index += 1;
    if (rootOption === undefined) {
      console.error("cleanup: --root needs a path");
      process.exit(2);
    }
  } else if (argument === "-h" || argument === "--help") {
    console.log(usage);
    process.exit(0);
  } else {
    console.error(`cleanup: unknown option ${argument}`);
    console.error(usage);
    process.exit(2);
  }
}

if (once && dryRun) {
  console.error("cleanup: --once and --dry-run are exclusive");
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
    console.error("cleanup: the harness is not inside a git checkout");
    process.exit(2);
  }
  return top;
}

const root = resolve(rootOption ?? gitTopLevel());
if (!existsSync(join(root, ".devboard"))) {
  console.error(`cleanup: missing prerequisite: ${join(root, ".devboard")} does not exist`);
  process.exit(2);
}

const instances = discoverInstances({ selfPids: new Set([process.pid]) });
const report = runCleanup({ root, instances, dryRun: dryRun || !once });
const effectiveDryRun = dryRun || !once;
const verb = effectiveDryRun ? "would remove" : "removed";
let errors = 0;

for (const entry of report.roots) {
  console.log(
    `cleanup: ${entry.stateDir}: ${verb} ${entry.files} file(s), ` +
      `${entry.directories} directory/directories, ${entry.bytes} byte(s)`,
  );
  if (effectiveDryRun) {
    for (const candidate of entry.candidates) {
      console.log(`  ${candidate.kind} ${candidate.path} ${candidate.bytes}`);
    }
  }
  for (const error of entry.errors) {
    errors += 1;
    console.error(`cleanup: ${entry.stateDir}: ${error}`);
  }
}

process.exit(errors === 0 ? 0 : 1);

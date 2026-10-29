import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock } from "../issues/lock";
import { describeCycle, runCycle, type CoachReport } from "./coordinator";
import { coachDirectory, lockPath } from "./paths";
import { readCoachSettings } from "./settings";

/**
 * The manual Coach entry point.
 *
 *   bun run coach -- --once --root <repo> --state-dir <state>
 *   bun run coach -- --collect --dry-run --root <repo> --state-dir <state>
 *
 * `--collect --dry-run` reads the evidence and prints the report without
 * writing a ledger, a run report, or an issue. `--once` runs one real cycle
 * under the worker's lock.
 */

interface Parsed {
  root: string;
  stateDir: string;
  dryRun: boolean;
  once: boolean;
  collect: boolean;
  json: boolean;
  now?: Date;
}

function usage(): never {
  console.error(
    "usage: coach --once|--collect [--dry-run] [--json] --root <checkout> " +
      "--state-dir <state> [--now <ISO>]",
  );
  process.exit(2);
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

function parseArguments(args: string[]): Parsed {
  let root: string | undefined;
  let stateDir: string | undefined;
  let dryRun = false;
  let once = false;
  let collect = false;
  let json = false;
  let now: Date | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      root = args[index + 1];
      index += 1;
    } else if (argument === "--state-dir") {
      stateDir = args[index + 1];
      index += 1;
    } else if (argument === "--now") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined || !Number.isFinite(Date.parse(value))) usage();
      now = new Date(Date.parse(value));
    } else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--once") once = true;
    else if (argument === "--collect") collect = true;
    else if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") usage();
    else usage();
  }
  const resolvedRoot = resolve(root ?? gitTopLevel() ?? process.cwd());
  if (!existsSync(join(resolvedRoot, ".devboard"))) {
    console.error(`coach: missing prerequisite: ${join(resolvedRoot, ".devboard")} does not exist`);
    process.exit(2);
  }
  const resolvedState = resolve(stateDir ?? join(resolvedRoot, ".devboard", ".tmp"));
  if (!once && !collect) usage();
  return {
    root: resolvedRoot,
    stateDir: resolvedState,
    dryRun: dryRun || collect,
    once,
    collect,
    json,
    ...(now === undefined ? {} : { now }),
  };
}

function packageVersion(root: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, ".devboard", "package.json"), "utf8"),
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof parsed.version === "string"
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const coachDir = coachDirectory(options.stateDir);
  if (options.dryRun) {
    const result = await runCycle({
      root: options.root,
      stateDir: options.stateDir,
      dryRun: true,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (options.json) {
      stdout(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      stdout(`${describeCycle(result)}\n`);
      stdout(`${reportLines(result.report).join("\n")}\n`);
    }
    return;
  }

  const lock = acquireLock(lockPath(coachDir), {
    repo: options.root,
    stateDir: options.stateDir,
    harnessVersion: packageVersion(options.root),
    argv: [...process.argv],
  });
  if (!lock.acquired) {
    console.error(
      `coach: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`}`,
    );
    return;
  }
  try {
    const result = await runCycle({
      root: options.root,
      stateDir: options.stateDir,
      settings: readCoachSettings(coachDir),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (options.json) {
      stdout(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      stdout(`${describeCycle(result)}\n`);
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } finally {
    lock.release();
  }
}

function stdout(text: string): void {
  process.stdout.write(text);
}

function reportLines(report: CoachReport): string[] {
  return [
    `window: ${report.window.start} .. ${report.window.end}`,
    `sessions: ${report.sessions} (selected ${report.sessionFiles}` +
      `${report.truncated ? ", truncated" : ""}, skipped ${report.skipped})`,
    `journal records: ${report.journalRecords}, malformed lines: ${report.malformed}`,
    ...report.findings.map(
      (finding) =>
        `finding: ${finding.category} ${finding.fingerprint} x${finding.count} — ${finding.line}`,
    ),
    ...(report.findings.length === 0 ? ["finding: none"] : []),
  ];
}

if (import.meta.main) {
  await main();
}

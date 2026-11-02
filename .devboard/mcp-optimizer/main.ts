import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock } from "../issues/lock";
import { describeCycle, runCycle, type McpOptimizerReport } from "./coordinator";
import { mcpOptimizerDirectory, cycleLockPath } from "./paths";
import { readMcpOptimizerSettings } from "./settings";

/**
 * The manual MCP optimizer entry point.
 *
 *   bun run mcp-optimizer -- --once --root <repo> --state-dir <state>
 *   bun run mcp-optimizer -- --collect --dry-run --root <repo> --state-dir <state>
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
    "usage: mcp-optimizer --once|--collect [--dry-run] [--json] --root <checkout> " +
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
    console.error(`mcp-optimizer: missing prerequisite: ${join(resolvedRoot, ".devboard")} does not exist`);
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
  const mcpOptimizerDir = mcpOptimizerDirectory(options.stateDir);
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

  // The same lease every worker takes for a cycle: a manual run never
  // overlaps another version's in-flight cycle.
  const lock = acquireLock(cycleLockPath(mcpOptimizerDir), {
    repo: options.root,
    stateDir: options.stateDir,
    harnessVersion: packageVersion(options.root),
    argv: [...process.argv],
  });
  if (!lock.acquired) {
    console.error(
      `mcp-optimizer: already running${lock.owner === undefined ? "" : ` (pid ${lock.owner.pid})`}`,
    );
    return;
  }
  try {
    const result = await runCycle({
      root: options.root,
      stateDir: options.stateDir,
      settings: readMcpOptimizerSettings(mcpOptimizerDir),
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

function reportLines(report: McpOptimizerReport): string[] {
  return [
    `window: ${report.window.start} .. ${report.window.end}`,
    `sessions: ${report.sessions} (selected ${report.sessionFiles}` +
      `${report.truncated ? ", truncated" : ""}, skipped ${report.skipped})`,
    `journal records: ${report.journalRecords}, malformed lines: ${report.malformed}`,
    `families: ${report.families}, selected: ${report.selected.length}, ` +
      `omitted: ${report.omitted}, ledger reset: ${report.ledgerReset}`,
    ...report.selected.map(
      (family) =>
        `family: ${family.key} (${family.kind}) score ${family.score} — ` +
        `${family.calls} call(s), ${family.sessions} session(s), ${family.days} day(s)`,
    ),
    ...(report.selected.length === 0 ? ["family: none"] : []),
  ];
}

if (import.meta.main) {
  await main();
}

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkReleaseTrain } from "../lib/release-train-gate";
import { ReleaseTrainWorker } from "./worker";

/**
 * The Release Train entry point.
 *
 *   bun run release-train/main.ts --root <repo> --state-dir <state>
 *   bun run release-train/main.ts --root <repo> --state-dir <state> --once
 *   bun run release-train/main.ts --root <repo> --check [--json]
 *
 * `--once` runs one forced tick and exits; `--check` prints the deterministic
 * gate without writing state or starting an agent. The dashboard starts the
 * plain worker and owns its lifecycle through the control files.
 */

interface Parsed {
  root: string;
  stateDir: string;
  once: boolean;
  check: boolean;
  json: boolean;
}

function usage(): never {
  console.error(
    "usage: release-train/main.ts --root <checkout> [--state-dir <state>] " +
      "[--once] [--check] [--json]",
  );
  process.exit(2);
}

function gitTopLevel(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", resolve(import.meta.dir, ".."), "rev-parse", "--show-toplevel"],
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
  let once = false;
  let check = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      root = args[index + 1];
      index += 1;
    } else if (argument === "--state-dir") {
      stateDir = args[index + 1];
      index += 1;
    } else if (argument === "--once") once = true;
    else if (argument === "--check") check = true;
    else if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") usage();
    else usage();
  }
  const resolvedRoot = resolve(root ?? gitTopLevel() ?? process.cwd());
  if (!existsSync(join(resolvedRoot, ".devboard"))) {
    console.error(
      `release-train: missing prerequisite: ${join(resolvedRoot, ".devboard")} does not exist`,
    );
    process.exit(2);
  }
  return {
    root: resolvedRoot,
    stateDir: resolve(stateDir ?? join(resolvedRoot, ".devboard", ".tmp")),
    once,
    check,
    json,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.check) {
    const gate = checkReleaseTrain(options.root);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(gate, null, 2)}\n`
        : `${gate.state}${gate.state === "error" ? `: ${gate.detail}` : ""}\n`,
    );
    process.exitCode = gate.state === "error" ? 1 : 0;
    return;
  }
  const worker = new ReleaseTrainWorker({
    repoDir: options.root,
    stateDir: options.stateDir,
  });
  if (options.once) {
    if (!worker.begin(false)) {
      process.stderr.write("release-train: another worker of this version is running\n");
      process.exitCode = 2;
      return;
    }
    try {
      await worker.tickNow();
    } finally {
      await worker.stop();
    }
    return;
  }
  process.exit(await worker.run());
}

if (import.meta.main) {
  await main();
}

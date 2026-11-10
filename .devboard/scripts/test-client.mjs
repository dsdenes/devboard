/**
 * Runs the client suite with one file per available core.
 *
 * Bun defaults to 20 files in flight, which leaves a larger host idle. This
 * entry point derives the concurrency from the host on every run, declares it
 * to `bun test`, and forwards any test paths the caller names. The declared
 * value is printed so a run proves what it used.
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

const concurrency = Math.max(1, availableParallelism());
console.log(`concurrency: ${concurrency}`);

const child = spawn(
  process.execPath,
  ["test", `--max-concurrency=${concurrency}`, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});

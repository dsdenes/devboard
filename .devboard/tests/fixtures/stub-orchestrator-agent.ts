/**
 * The stub agent the orchestrator tests spawn. It records each invocation,
 * writes the requested streams, sleeps, and exits as instructed, so a test can
 * observe the whole child lifetime without a model or a network.
 *
 *   bun tests/fixtures/stub-orchestrator-agent.ts --log=<path> --sleep=<ms>
 *     --exit=<code> --stdout=<text> --stderr=<text> --prompt=<text>
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const log = option("log");
const sleepMs = Number(option("sleep") ?? "0");
const exitCode = Number(option("exit") ?? "0");
const stdout = option("stdout") ?? "";
const stderr = option("stderr") ?? "";
const prompt = option("prompt");

function record(entry: Record<string, unknown>): void {
  if (log === undefined) return;
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

record({
  event: "start",
  argv: args,
  ...(prompt === undefined ? {} : { prompt }),
  cwd: process.cwd(),
  pid: process.pid,
  at: new Date().toISOString(),
});

if (stdout.length > 0) process.stdout.write(`${stdout}\n`);
if (stderr.length > 0) process.stderr.write(`${stderr}\n`);

if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((settle) => setTimeout(settle, sleepMs));
}

record({
  event: "end",
  pid: process.pid,
  exitCode: Number.isFinite(exitCode) ? exitCode : 0,
  at: new Date().toISOString(),
  cwd: process.cwd(),
});

process.exit(Number.isFinite(exitCode) ? exitCode : 0);

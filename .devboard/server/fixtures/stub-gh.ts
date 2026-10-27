/**
 * Deterministic `gh` substitute for the feedback endpoint tests.
 *
 * It records the arguments, working directory and stdin body, then either
 * prints an issue URL, fails, hangs, or answers late so timeout handling can be
 * exercised. `STUB_GH_RECORD` keeps the last call, `STUB_GH_RECORD_DIR`
 * appends every call to `calls.jsonl`, and `STUB_GH_MODE_FILE` lets a test
 * switch modes between calls without restarting the server.
 */

import { mkdirSync } from "node:fs";

const recordPath = process.env.STUB_GH_RECORD;
const recordDir = process.env.STUB_GH_RECORD_DIR;
const modeFile = process.env.STUB_GH_MODE_FILE;
const baseMode = process.env.STUB_GH_MODE ?? "ok";

let body = "";
for await (const chunk of Bun.stdin.stream()) {
  body += new TextDecoder().decode(chunk);
}

const record = { args: process.argv.slice(2), cwd: process.cwd(), body };

if (recordPath !== undefined) {
  await Bun.write(recordPath, JSON.stringify(record));
}

if (recordDir !== undefined) {
  mkdirSync(recordDir, { recursive: true });
  const logPath = `${recordDir}/calls.jsonl`;
  const log = Bun.file(logPath);
  const previous = (await log.exists()) ? await log.text() : "";
  await Bun.write(logPath, `${previous}${JSON.stringify(record)}\n`);
}

let mode = baseMode;
if (modeFile !== undefined && (await Bun.file(modeFile).exists())) {
  const requested = (await Bun.file(modeFile).text()).trim();
  if (requested.length > 0) mode = requested;
}

if (mode === "delay") {
  const delayMs = Number(process.env.STUB_GH_DELAY_MS ?? "");
  await Bun.sleep(Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1_500);
} else if (mode === "fail") {
  console.error("boom: not a git repository");
  process.exit(1);
} else if (mode === "hang") {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 60_000);
  await promise;
}

console.log("https://github.com/example/host/issues/42");

export {};

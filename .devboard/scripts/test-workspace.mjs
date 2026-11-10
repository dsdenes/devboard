/**
 * Runs the Rust workspace suite with one test binary per available core.
 *
 * `cargo test --workspace` builds every test binary and then runs them one at
 * a time, leaving the host idle between binaries. This runner builds the same
 * set, runs up to `availableParallelism()` of them at once, and prints one
 * summary for the whole suite. The concurrency is derived from the host on
 * every run, so the same entry point is correct on any machine.
 *
 * The doc tests keep their own cargo invocation; they are not test binaries
 * and produce no per-binary concurrency to raise.
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

const concurrency = Math.max(1, availableParallelism());
const cargo = process.env.CARGO ?? "cargo";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function buildDiagnostics(stdout) {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      continue;
    }
    if (message.reason === "compiler-message" && message.message?.rendered) {
      process.stdout.write(message.message.rendered);
    }
  }
}

function testBinaries(stdout) {
  const executables = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== "compiler-artifact") continue;
    if (!message.profile?.test) continue;
    if (!message.executable) continue;
    if (seen.has(message.executable)) continue;
    seen.add(message.executable);
    executables.push(message.executable);
  }
  return executables;
}

async function main() {
  console.log(`concurrency: ${concurrency}`);

  const build = await run(cargo, ["test", "--workspace", "--no-run", "--message-format=json"]);
  if (build.code !== 0) {
    buildDiagnostics(build.stdout);
    process.stderr.write(build.stderr);
    return build.code;
  }
  const executables = testBinaries(build.stdout);
  if (executables.length === 0) {
    console.error("test-workspace: cargo produced no test binary");
    return 1;
  }

  let next = 0;
  const totals = { passed: 0, failed: 0, ignored: 0 };
  const failedBinaries = [];

  async function worker() {
    while (next < executables.length) {
      const executable = executables[next++];
      const name = executable.split("/").pop();
      // A binary that never finishes is named here; its own output appears
      // only when it settles.
      console.log(`test-workspace: running ${name}`);
      // One test at a time inside each binary: the pool already runs one
      // binary per core, so the host-wide thread count is the core count
      // instead of one full thread pool per binary.
      const result = await run(executable, ["--test-threads=1"]);
      process.stdout.write(result.stdout);
      if (result.stderr) process.stdout.write(result.stderr);
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/);
        if (!match) continue;
        totals.passed += Number(match[1]);
        totals.failed += Number(match[2]);
        totals.ignored += Number(match[3]);
      }
      if (result.code !== 0) failedBinaries.push(name);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, executables.length) }, () => worker());
  await Promise.all(pool);

  const doc = await run(cargo, ["test", "--workspace", "--doc"]);
  process.stdout.write(doc.stdout);
  process.stderr.write(doc.stderr);

  console.log(
    `test-workspace: ${executables.length} test binaries, concurrency ${concurrency}, ` +
      `${totals.passed} passed, ${totals.failed} failed, ${totals.ignored} ignored`,
  );
  if (failedBinaries.length > 0) {
    console.log(`test-workspace: failing binaries: ${failedBinaries.join(", ")}`);
  }
  if (doc.code !== 0) console.log("test-workspace: the doc tests failed");
  const clean = totals.failed === 0 && failedBinaries.length === 0 && doc.code === 0;
  return clean ? 0 : 1;
}

process.exitCode = await main();

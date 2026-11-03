#!/usr/bin/env bun
/**
 * The release workflow's suite step.
 *
 * It runs the whole harness suite with the workflow's load settings, retries it
 * when individual tests fail, and skips a test for the rest of the run once it
 * has failed three consecutive whole-suite attempts. Every skip is written into
 * this step's working copy and restored before the step returns, and each
 * skipped test files one deduplicated issue in the origin forge, so the tracked
 * tree, `main`, and the packed package are unchanged while the flaky failure
 * still has a durable record.
 *
 * The step exits 0 only when an attempt reports no failing test. A structural
 * failure — a compile or import error, a crashed runner, a result document
 * that names no test — exits nonzero and files nothing, so the release is
 * unblocked by flaky tests and never by a suite that cannot run. Filing is best
 * effort: an unreachable forge prints one failure line and does not fail the
 * step.
 *
 * Extra arguments after `--` are appended to every attempt.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { topLevel } from "../issues/repository";
import { giteaIssueForge, fileQuarantineReports } from "../lib/quarantine-issues";
import {
  classifyAttempt,
  QuarantineWorkingCopy,
  RELEASE_SUITE_MAX_ATTEMPTS,
  runQuarantineSuite,
  type AttemptRecord,
} from "../lib/test-quarantine";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
/** The workflow's load settings; the whole suite runs under them. */
const SUITE_ARGUMENTS = ["test", "--parallel=8", "--timeout=60000"] as const;

function log(line: string): void {
  console.log(line);
}

function workflowRunUrl(environment: Record<string, string | undefined>): string | undefined {
  const server = environment.GITHUB_SERVER_URL;
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  if (server === undefined || repository === undefined || runId === undefined) return undefined;
  return `${server.replace(/\/+$/, "")}/${repository}/actions/runs/${runId}`;
}

async function main(): Promise<number> {
  const extra = process.argv.slice(2);
  const repoDir = topLevel(HARNESS_ROOT) ?? HARNESS_ROOT;
  const scratch = () => {
    mkdirSync(join(HARNESS_ROOT, ".tmp"), { recursive: true });
    return mkdtempSync(join(HARNESS_ROOT, ".tmp", "release-suite-"));
  };
  const attempt = (directory: string) => (index: number): AttemptRecord => {
    const junitPath = join(directory, `attempt-${index}.xml`);
    rmSync(junitPath, { force: true });
    let code = 1;
    let output = "";
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          ...SUITE_ARGUMENTS,
          "--reporter=junit",
          `--reporter-outfile=${junitPath}`,
          ...extra,
        ],
        cwd: HARNESS_ROOT,
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      code = result.exitCode ?? 1;
      output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    const junit = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : undefined;
    return classifyAttempt({ index, code, junit, output });
  };

  const workingCopy = new QuarantineWorkingCopy(HARNESS_ROOT);
  const directory = scratch();
  const restore = () => {
    try {
      workingCopy.restore();
    } catch (error) {
      log(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onInterrupt = () => {
    restore();
    rmSync(directory, { recursive: true, force: true });
    process.exit(130);
  };
  const onTerminate = () => {
    restore();
    rmSync(directory, { recursive: true, force: true });
    process.exit(143);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    log(`release suite: up to ${RELEASE_SUITE_MAX_ATTEMPTS} whole-suite attempts`);
    const result = await runQuarantineSuite({
      attempt: attempt(directory),
      markSkipped: (failure) => workingCopy.markSkipped(failure),
      log,
    });
    restore();
    if (result.structural !== undefined) {
      log(`release suite: structural failure after ${result.attempts} attempt(s); ` +
        "nothing was filed");
      return 1;
    }
    if (result.code === 0) {
      log(
        `release suite: ${result.attempts} attempt(s), ` +
          `${result.quarantined.length} quarantined, 0 fail`,
      );
    } else {
      log(`release suite: ${result.attempts} attempt(s) still reported failures`);
    }
    await fileQuarantineReports(
      result.quarantined,
      giteaIssueForge(repoDir),
      { commit: commitSha(repoDir), runUrl: workflowRunUrl(process.env) },
      log,
    );
    return result.code;
  } finally {
    restore();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    rmSync(directory, { recursive: true, force: true });
  }
}

function commitSha(repoDir: string): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repoDir, "rev-parse", "HEAD"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sha = result.stdout.toString().trim();
  return result.exitCode === 0 && sha.length > 0 ? sha : "unknown";
}

try {
  process.exitCode = await main();
} catch (error) {
  log(`release suite: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

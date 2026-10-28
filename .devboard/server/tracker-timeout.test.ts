import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findOpenEpics, TrackerAbortedError, TrackerTimeoutError } from "./tracker";

/** Every temporary host lives inside the worktree, never the system temp directory. */
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "tracker-timeout");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

/**
 * A host whose tracker answers authentication quickly and then stalls the epic
 * query, recording the stalled child's pid.
 */
async function stalledTrackerHost(): Promise<{ root: string; pidFile: string }> {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEST_ROOT, "host-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);

  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const pidFile = join(root, "child.pid");
  const script = `#!/bin/sh
case "$*" in
  "auth status --hostname github.com --json hosts") echo '{"hosts":{"github.com":[{"login":"reviewer","active":true,"state":"success"}]}}' ;;
  "auth token --hostname github.com --user reviewer") echo "gho_test" ;;
  "api --hostname github.com repos/owner/repo --jq .permissions") echo '{"admin":false,"maintain":false,"push":true,"triage":true,"pull":true}' ;;
  "label list --search epic --limit 100 --json name") echo $$ > "$TRACKER_PID_FILE"; exec sleep 300 ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, "gh"), script);
  await chmod(join(bin, "gh"), 0o755);
  return { root, pidFile };
}

/** Runs one read with the fake CLI first on PATH and the pid file configured. */
async function withStalledCli<T>(pidFile: string, run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  const previousPidFile = process.env.TRACKER_PID_FILE;
  process.env.PATH = `${join(dirname(pidFile), "bin")}:${previousPath ?? ""}`;
  process.env.TRACKER_PID_FILE = pidFile;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.TRACKER_PID_FILE;
    else process.env.TRACKER_PID_FILE = previousPidFile;
  }
}

async function recordedPid(pidFile: string, timeout = 5000): Promise<number> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await Bun.file(pidFile).text()).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The stalled child has not written its pid yet.
    }
    await Bun.sleep(25);
  }
  throw new Error(`the stalled tracker child never recorded its pid at ${pidFile}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && processAlive(pid)) await Bun.sleep(25);
  expect(processAlive(pid)).toBe(false);
}

/** One test per host: the pid file and PATH belong to that read alone. */

test(
  "kills the stalled tracker child at the deadline and rejects a retryable error",
  async () => {
    const { root, pidFile } = await stalledTrackerHost();
    const started = Date.now();
    const reading = withStalledCli(pidFile, async () => {
      const outcome = findOpenEpics(root, { timeoutMs: 3000 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const pid = await recordedPid(pidFile);
      return { pid, error: await outcome };
    });
    const { pid, error } = await reading;

    expect(error).toBeInstanceOf(TrackerTimeoutError);
    expect((error as TrackerTimeoutError).retryable).toBe(true);
    expect((error as Error).message).toContain("did not answer within 3000 ms");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    await waitForExit(pid);
  },
  20000,
);

test(
  "kills the stalled tracker child when the caller aborts the read",
  async () => {
    const { root, pidFile } = await stalledTrackerHost();
    const { pid, error } = await withStalledCli(pidFile, async () => {
      const controller = new AbortController();
      const outcome = findOpenEpics(root, { timeoutMs: 10_000, signal: controller.signal }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      const pid = await recordedPid(pidFile);
      controller.abort();
      return { pid, error: await outcome };
    });

    expect(error).toBeInstanceOf(TrackerAbortedError);
    await waitForExit(pid);
  },
  20000,
);

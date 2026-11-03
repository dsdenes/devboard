import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { processTable, type ProcessSnapshot } from "../../watchdog/discovery";
import { processStat, type SupervisionRecord } from "../../watchdog/supervision";
import { readSupervisionRecords } from "../../watchdog/supervision";

/**
 * Shared fixtures for the supervision proofs. Every directory lives under the
 * repository's `.devboard/.tmp`, and every process a test starts is disposable.
 */

export const harnessRoot = resolve(import.meta.dir, "..", "..");
export const repoRoot = resolve(harnessRoot, "..");
export const testRoot = join(harnessRoot, ".tmp");
export const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
export const treeFixture = join(import.meta.dir, "supervised-tree.ts");

const temporaryDirectories: string[] = [];

export async function scratch(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupScratch(): Promise<void> {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

export function recordOf(stateDir: string, pid: number): SupervisionRecord | undefined {
  return readSupervisionRecords(stateDir).find((record) => record.pid === pid);
}

/** Ends a fixture the test started, so a failure never leaks it. */
export function killFixture(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** A peer command that stays alive and ignores the `--no-skills` suffix. */
export async function idlePeer(directory: string): Promise<string> {
  const path = join(directory, "idle-peer.sh");
  writeFileSync(path, "#!/bin/sh\nsleep 120\n");
  chmodSync(path, 0o755);
  return path;
}

/** A process table limited to the pids under test, so a pass stays hermetic. */
export function snapshotOf(pids: number[]): ProcessSnapshot[] {
  const wanted = new Set(pids);
  return processTable().filter((process) => wanted.has(process.pid));
}

/**
 * A harness-shaped process with no record, reparented to PID 1: its launcher
 * exits immediately, exactly like a killed verification script.
 */
export async function spawnUnrecorded(
  directory: string,
  options: { scratch: boolean; marker: string },
): Promise<number> {
  const holdPath = join(directory, "server", "fixtures", "hold.ts");
  mkdirSync(dirname(holdPath), { recursive: true });
  writeFileSync(
    holdPath,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(process.env.MARKER ?? "", String(process.pid));\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const cwd = options.scratch ? directory : harnessRoot;
  const repoDir = options.scratch ? directory : repoRoot;
  const launcher =
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(holdPath)}], {\n` +
    `  detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",\n` +
    `  cwd: ${JSON.stringify(cwd)},\n` +
    `  env: { ...process.env, MARKER: ${JSON.stringify(options.marker)}, ` +
    `REPO_DIR: ${JSON.stringify(repoDir)} },\n` +
    `});\nchild.unref();\nprocess.exit(0);\n`;
  Bun.spawn([process.execPath, "-e", launcher], { stdout: "ignore", stderr: "ignore" });
  const pid = await waitFor(
    () => {
      try {
        const text = readFileSync(options.marker, "utf8").trim();
        return text.length === 0 ? undefined : Number(text);
      } catch {
        return undefined;
      }
    },
    "the unrecorded process",
  );
  await waitFor(
    () => (processStat(pid)?.ppid === 1 ? true : undefined),
    "the process to be reparented to PID 1",
  );
  return pid;
}

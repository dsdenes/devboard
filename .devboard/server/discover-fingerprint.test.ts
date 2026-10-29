import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostFacts } from "./discover";

/**
 * The host fingerprint stays bounded on the request path: it never reads a
 * special file, never holds a regular file in memory, and re-reads nothing on an
 * unchanged host.
 */

const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "fingerprint-tests");

mkdirSync(TEST_ROOT, { recursive: true });

const cleanup: (() => void)[] = [];

afterAll(() => {
  for (const action of cleanup.reverse()) action();
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Fingerprint Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function hostRepo(name: string): string {
  const root = join(
    TEST_ROOT,
    `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(join(root, "src", "app.ts"), "export const answer = 42;\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "chore: fixture base"]);
  cleanup.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Bytes this process has requested from any file, when the kernel reports it. */
function readCharacters(): number | undefined {
  try {
    const status = readFileSync("/proc/self/io", "utf8");
    const match = /^rchar: (\d+)$/m.exec(status);
    return match === null ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
}

describe("host fingerprint", () => {
  test("reads an unchanged host once and follows a content change", () => {
    const root = hostRepo("cache");
    const payload = join(root, "payload.bin");
    writeFileSync(payload, Buffer.alloc(4 * 1024 * 1024, 7));
    git(root, ["add", "payload.bin"]);
    git(root, ["commit", "-m", "chore: payload"]);

    const first = hostFacts(root);
    const before = readCharacters();
    const second = hostFacts(root);
    const after = readCharacters();

    expect(second.fingerprint).toBe(first.fingerprint);
    if (before !== undefined && after !== undefined) {
      // The second run stats every entry but reads no file content: anything
      // near the payload's 4 MiB means the cache was bypassed.
      expect(after - before).toBeLessThan(256 * 1024);
    }

    writeFileSync(payload, Buffer.alloc(4 * 1024 * 1024, 8));
    expect(hostFacts(root).fingerprint).not.toBe(first.fingerprint);
  }, 30000);

  test("never opens a tracked FIFO or a symlink to a device", () => {
    const root = hostRepo("special");
    const fifo = join(root, "events.pipe");
    const made = Bun.spawnSync({ cmd: ["mkfifo", fifo], stdout: "pipe", stderr: "pipe" });
    expect(made.exitCode).toBe(0);
    const zero = join(root, "zero");
    symlinkSync("/dev/zero", zero);
    git(root, ["add", "events.pipe", "zero"]);
    git(root, ["commit", "-m", "chore: special entries"]);

    const started = performance.now();
    const first = hostFacts(root);
    const elapsed = performance.now() - started;
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(elapsed).toBeLessThan(5000);
    expect(hostFacts(root).fingerprint).toBe(first.fingerprint);

    // The link target string is part of the fingerprint, so a retarget is a
    // host change even though neither target is ever read.
    unlinkSync(zero);
    symlinkSync("/dev/null", zero);
    expect(hostFacts(root).fingerprint).not.toBe(first.fingerprint);
  }, 15000);

  test("streams a large tracked file with bounded memory", () => {
    const root = hostRepo("large-file");
    const big = join(root, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024);
    git(root, ["add", "big.bin"]);

    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const first = hostFacts(root);
    const elapsed = performance.now() - started;
    const grown = process.memoryUsage().rss - rssBefore;

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(elapsed).toBeLessThan(30000);
    // Reading the file whole would allocate every byte; the chunked hash must
    // stay far below it.
    expect(grown).toBeLessThan(16 * 1024 * 1024);

    const before = readCharacters();
    expect(hostFacts(root).fingerprint).toBe(first.fingerprint);
    const after = readCharacters();
    if (before !== undefined && after !== undefined) {
      expect(after - before).toBeLessThan(1024 * 1024);
    }
  }, 60000);
});

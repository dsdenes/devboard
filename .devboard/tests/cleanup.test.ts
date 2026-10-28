import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CLEANUP_RETENTION_MS,
  coveredStateDirs,
  runCleanup,
  sweepStateDir,
} from "../watchdog/cleanup";
import { runCycle } from "../watchdog/coordinator";
import type { Instance } from "../watchdog/discovery";

/**
 * Every fixture lives under the repository's `.devboard/.tmp`. Fixture mtimes
 * sit near the real clock and the sweep clock is eight days ahead, so the
 * installed watchdog's own sweep can never mistake a fixture for old data.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const DAY = 24 * 60 * 60 * 1000;
const realNow = Date.now();
const sweepNow = new Date(realNow + 8 * DAY);
const cutoff = sweepNow.getTime() - CLEANUP_RETENTION_MS;
const old = new Date(realNow - 60_000);
const fresh = new Date(realNow + 2 * DAY);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "test-cleanup"): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAt(path: string, text: string, mtime: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, mtime, mtime);
}

function mkdirAt(path: string, mtime: Date): void {
  mkdirSync(path, { recursive: true });
  utimesSync(path, mtime, mtime);
}

function snapshot(directory: string): string[] {
  const lines: string[] = [];
  const walk = (path: string): void => {
    const info = lstatSync(path);
    lines.push(`${path} ${info.size} ${info.mtimeMs} ${info.mode}`);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  for (const name of readdirSync(directory).sort()) walk(join(directory, name));
  return lines;
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
  return result.pid ?? 999999;
}

describe("covered state directories", () => {
  test("finds the canonical checkout, direct siblings, and live instances once", async () => {
    const base = await temporaryDirectory();
    const home = join(base, "home");
    const canonical = join(home, "devboard");
    const canonicalTmp = join(canonical, ".devboard", ".tmp");
    await mkdir(canonicalTmp, { recursive: true });
    for (const name of ["ajv", "arbinv"]) {
      await mkdir(join(home, name, ".devboard", ".tmp"), { recursive: true });
    }
    await mkdir(join(home, "not-devboard", "src"), { recursive: true });
    const linkHost = join(home, "linkhost", ".devboard");
    await mkdir(linkHost, { recursive: true });
    symlinkSync(canonicalTmp, join(linkHost, ".tmp"), "dir");

    const installed = join(base, "elsewhere", "host");
    const installedState = join(installed, ".devboard", ".tmp");
    await mkdir(join(installedState, "journal"), { recursive: true });
    const installedHarness = join(
      installed,
      ".devboard",
      "node_modules",
      "@dsdenes",
      "devboard-harness",
    );
    const key = "a".repeat(24);
    const instance = {
      stateDir: installedState,
      journal: join(installedState, "journal", `${key}.jsonl`),
    };

    const covered = coveredStateDirs(canonical, [instance]);
    const paths = covered.map((entry) => entry.stateDir);
    expect(paths).toEqual([
      canonicalTmp,
      join(home, "ajv", ".devboard", ".tmp"),
      join(home, "arbinv", ".devboard", ".tmp"),
      installedState,
    ]);
    expect(paths).not.toContain(join(linkHost, ".tmp"));
    expect(new Set(paths).size).toBe(paths.length);
    expect(covered[0]?.source).toBe("canonical");
    expect(covered[1]?.source).toBe("sibling");
    expect(covered[3]?.source).toBe("instance");
    expect(covered.some((entry) => entry.stateDir.includes("node_modules"))).toBe(false);
  });

  test("skips missing directories and derives the state directory from the journal", () => {
    const covered = coveredStateDirs("/nonexistent/repo", [
      { journal: "/nonexistent/host/.devboard/.tmp/journal/bbbb.jsonl" },
    ]);
    expect(covered).toEqual([]);
  });
});

describe("sweepStateDir", () => {
  test("removes old files and keeps fresh ones at the exact boundary", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    await mkdir(stateDir, { recursive: true });
    writeAt(join(stateDir, "old.txt"), "old", old);
    writeAt(join(stateDir, "fresh.txt"), "fresh", fresh);
    writeAt(join(stateDir, "at-boundary.txt"), "boundary", new Date(cutoff));
    writeAt(join(stateDir, "past-boundary.txt"), "past", new Date(cutoff - 1000));

    const report = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });

    expect(existsSync(join(stateDir, "old.txt"))).toBe(false);
    expect(existsSync(join(stateDir, "past-boundary.txt"))).toBe(false);
    expect(existsSync(join(stateDir, "fresh.txt"))).toBe(true);
    expect(existsSync(join(stateDir, "at-boundary.txt"))).toBe(true);
    expect(report.files).toBe(2);
    expect(report.bytes).toBe(7);
  });

  test("judges files individually and removes only empty old directories", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    await mkdir(stateDir, { recursive: true });

    mkdirAt(join(stateDir, "old-empty"), old);
    writeAt(join(stateDir, "old-tree", "nested", "old.txt"), "old", old);
    utimesSync(join(stateDir, "old-tree", "nested"), old, old);
    utimesSync(join(stateDir, "old-tree"), old, old);
    writeAt(join(stateDir, "fresh-dir", "old.txt"), "old", old);
    utimesSync(join(stateDir, "fresh-dir"), fresh, fresh);
    writeAt(join(stateDir, "old-dir-fresh-file", "fresh.txt"), "fresh", fresh);
    utimesSync(join(stateDir, "old-dir-fresh-file"), old, old);

    sweepStateDir(stateDir, { now: sweepNow, dryRun: false });

    expect(existsSync(join(stateDir, "old-empty"))).toBe(false);
    expect(existsSync(join(stateDir, "old-tree"))).toBe(false);
    expect(existsSync(join(stateDir, "fresh-dir"))).toBe(true);
    expect(existsSync(join(stateDir, "fresh-dir", "old.txt"))).toBe(false);
    expect(existsSync(join(stateDir, "old-dir-fresh-file"))).toBe(true);
    expect(existsSync(join(stateDir, "old-dir-fresh-file", "fresh.txt"))).toBe(true);
  });

  test("unlinks old symlinks without following them", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    const target = join(base, "target");
    await mkdir(stateDir, { recursive: true });
    await mkdir(target, { recursive: true });
    writeAt(join(target, "keep.txt"), "keep", old);
    const link = join(stateDir, "old-link");
    symlinkSync(target, link, "dir");
    lutimesSync(link, old, old);

    sweepStateDir(stateDir, { now: sweepNow, dryRun: false });

    expect(existsSync(link)).toBe(false);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  test("protects state, journal, repo-scoped issues records, and live locks", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    await mkdir(stateDir, { recursive: true });

    writeAt(join(stateDir, "state", "project.json"), "{}", old);
    const journal = join(stateDir, "journal", `${"c".repeat(24)}.jsonl.1000-1`);
    writeAt(journal, "rotated", old);
    writeAt(join(stateDir, "watchdog", "state.json"), "{}", old);
    writeAt(join(stateDir, "watchdog", "latest.json"), "{}", old);
    writeAt(join(stateDir, "watchdog", "lock"), "", old);
    const startedAt = "2026-10-20T10:00:00.000Z";
    const activeRun = join(stateDir, "orchestrator", "runs", "2026-10-20T10-00-00-000Z");
    writeAt(join(activeRun, "stdout.log"), "running", old);
    utimesSync(activeRun, old, old);
    const inactiveRun = join(stateDir, "orchestrator", "runs", "2026-10-01T00-00-00-000Z");
    writeAt(join(inactiveRun, "stdout.log"), "done", old);
    utimesSync(inactiveRun, old, old);
    writeAt(
      join(stateDir, "orchestrator", "state.json"),
      JSON.stringify({
        version: 1,
        root: base,
        repo: "owner/repo",
        status: "running",
        startedAt,
        finishedAt: null,
        open: 1,
        issues: [],
        lastExitCode: null,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: startedAt,
      }),
      old,
    );
    writeAt(join(stateDir, "orchestrator", "ledger.json"), "{}", old);
    writeAt(join(stateDir, "orchestrator", "lock"), "{}", old);
    const issuesState = join(stateDir, "issues", "a".repeat(24), "state.json");
    writeAt(issuesState, "{}", old);
    const issuesRun = join(stateDir, "issues", "a".repeat(24), "runs", "2026-10-01T00-00-00-000Z");
    writeAt(join(issuesRun, "activity.json"), "[]", old);
    utimesSync(issuesRun, old, old);
    writeAt(join(stateDir, "issues", "lock"), "{}", old);
    const currentRun = join(stateDir, "watchdog", "runs", "2026-10-25T00-00-00-000Z");
    writeAt(join(currentRun, "coordinator.log"), "current", old);
    utimesSync(currentRun, old, old);
    const oldWatchdogRun = join(stateDir, "watchdog", "runs", "2026-10-01T00-00-00-000Z");
    writeAt(join(oldWatchdogRun, "coordinator.log"), "old", old);
    utimesSync(oldWatchdogRun, old, old);
    const liveLock = join(stateDir, `devboard-${process.pid}.lock`);
    writeAt(liveLock, "", old);
    const deadLock = join(stateDir, `devboard-${deadPid()}.lock`);
    writeAt(deadLock, "", old);

    const report = sweepStateDir(stateDir, {
      now: sweepNow,
      dryRun: false,
      watchdogRunDir: currentRun,
    });
    const removed = report.removed.map((candidate) => candidate.path);

    for (const protectedPath of [
      join(stateDir, "state", "project.json"),
      journal,
      join(stateDir, "watchdog", "state.json"),
      join(stateDir, "watchdog", "latest.json"),
      join(stateDir, "watchdog", "lock"),
      join(stateDir, "orchestrator", "state.json"),
      issuesState,
      join(issuesRun, "activity.json"),
      join(stateDir, "issues", "lock"),
      join(stateDir, "orchestrator", "ledger.json"),
      join(stateDir, "orchestrator", "lock"),
      join(currentRun, "coordinator.log"),
      liveLock,
    ]) {
      expect(existsSync(protectedPath)).toBe(true);
    }
    expect(existsSync(join(activeRun, "stdout.log"))).toBe(false);
    expect(existsSync(join(inactiveRun, "stdout.log"))).toBe(false);
    expect(existsSync(join(oldWatchdogRun, "coordinator.log"))).toBe(false);
    expect(existsSync(deadLock)).toBe(false);
    expect(removed).not.toContain(join(stateDir, "state"));
    expect(removed).not.toContain(join(stateDir, "journal"));
    expect(removed).not.toContain(currentRun);
    expect(removed).not.toContain(join(stateDir, "issues"));
  });

  test("a dry run reports candidates and changes nothing", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    await mkdir(stateDir, { recursive: true });
    writeAt(join(stateDir, "old.txt"), "old", old);
    mkdirAt(join(stateDir, "old-dir"), old);
    writeAt(join(stateDir, "fresh.txt"), "fresh", fresh);
    const before = snapshot(stateDir);

    const report = runCleanup({
      root: base,
      now: sweepNow,
      dryRun: true,
      covered: [{ stateDir, source: "canonical" }],
    });

    expect(snapshot(stateDir)).toEqual(before);
    expect(report.dryRun).toBe(true);
    expect(report.roots[0]?.removed).toEqual([]);
    expect(report.roots[0]?.candidates.map((candidate) => candidate.path)).toEqual([
      join(stateDir, "old-dir"),
      join(stateDir, "old.txt"),
    ]);
    expect(report.roots[0]?.bytes).toBe(3);
  });

  test("a second real run removes nothing", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    await mkdir(stateDir, { recursive: true });
    writeAt(join(stateDir, "old.txt"), "old", old);
    writeAt(join(stateDir, "old-dir", "old.txt"), "old", old);
    utimesSync(join(stateDir, "old-dir"), old, old);

    const first = runCleanup({
      root: base,
      now: sweepNow,
      covered: [{ stateDir, source: "canonical" }],
    });
    const second = runCleanup({
      root: base,
      now: sweepNow,
      covered: [{ stateDir, source: "canonical" }],
    });

    expect(first.roots[0]?.files).toBe(2);
    expect(first.roots[0]?.directories).toBe(1);
    expect(second.roots[0]?.files).toBe(0);
    expect(second.roots[0]?.directories).toBe(0);
    expect(second.roots[0]?.removed).toEqual([]);
  });
});

describe("watchdog cycle integration", () => {
  const gh = () => ({ code: 0, stdout: "", stderr: "" });
  const collect = () => ({ events: [], malformed: 0, unattributed: 0 });

  test("sweeps the canonical state directory and logs the result", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "repo");
    const canonicalTmp = join(root, ".devboard", ".tmp");
    await mkdir(canonicalTmp, { recursive: true });
    writeAt(join(canonicalTmp, "old-run", "stdout.log"), "old", old);
    utimesSync(join(canonicalTmp, "old-run"), old, old);

    const result = await runCycle({
      root,
      now: sweepNow,
      deps: { discover: () => [], collect, gh },
    });

    expect(existsSync(join(canonicalTmp, "old-run"))).toBe(false);
    expect(result.report.cleanup.roots.map((entry) => entry.stateDir)).toContain(canonicalTmp);
    expect(result.report.cleanup.roots[0]?.files).toBe(1);
    const log = readFileSync(join(result.runDir as string, "coordinator.log"), "utf8");
    expect(log).toContain(`cleanup ${canonicalTmp}: removed 1 file(s)`);
  });

  test("a dry-run cycle reports candidates and deletes nothing", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "repo");
    const canonicalTmp = join(root, ".devboard", ".tmp");
    await mkdir(canonicalTmp, { recursive: true });
    writeAt(join(canonicalTmp, "old-run", "stdout.log"), "old", old);
    const before = snapshot(canonicalTmp);

    const result = await runCycle({
      root,
      now: sweepNow,
      dryRun: true,
      deps: { discover: () => [], collect, gh },
    });

    expect(snapshot(canonicalTmp)).toEqual(before);
    expect(result.report.cleanup.dryRun).toBe(true);
    expect(result.report.cleanup.roots[0]?.candidates.map((entry) => entry.path)).toContain(
      join(canonicalTmp, "old-run", "stdout.log"),
    );
  });

  test("prunes an installed host's journal through its real state directory", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "repo");
    await mkdir(join(root, ".devboard", ".tmp"), { recursive: true });
    const host = join(base, "elsewhere", "host");
    const stateDir = join(host, ".devboard", ".tmp");
    const journal = join(stateDir, "journal", `${"d".repeat(24)}.jsonl.1000-1`);
    await mkdir(join(stateDir, "journal"), { recursive: true });
    writeAt(journal, "rotated", old);
    const harness = join(host, ".devboard", "node_modules", "@dsdenes", "devboard-harness");
    const instance: Instance = {
      pid: 1234,
      port: 47473,
      repoDir: host,
      host: "127.0.0.1",
      harness,
      stateDir,
      journal: join(stateDir, "journal", `${"d".repeat(24)}.jsonl`),
      instrumented: true,
    };

    const result = await runCycle({
      root,
      now: sweepNow,
      deps: { discover: () => [instance], collect, gh },
    });

    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(harness, ".tmp"))).toBe(false);
    expect(result.report.cleanup.roots.map((entry) => entry.stateDir)).toContain(stateDir);
  });
});

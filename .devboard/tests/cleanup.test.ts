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
import { acquireLock } from "../issues/lock";
import {
  designRoot as designStateRoot,
  repoStateDirectory as designRepoStateDirectory,
  settingsPath as designSettingsPath,
  statePath as designStatePath,
} from "../issues/design/paths";
import { emptyState as emptyDesignState } from "../issues/design/state";
import {
  repoStateDirectory,
  scoutRoot,
  settingsPath,
  statePath,
} from "../issues/scout/paths";
import { emptyState } from "../issues/scout/state";
import { ScoutWorker } from "../issues/scout/worker";
import { DesignBridge } from "../server/design";
import { agentRegistry } from "../server/agents/registry";
import {
  CLEANUP_RETENTION_MS,
  coveredStateDirs,
  runCleanup,
  sweepStateDir,
} from "../watchdog/cleanup";
import { runCycle } from "../watchdog/coordinator";
import type { Instance } from "../watchdog/discovery";
import { FlowController } from "../server/flow";
import { journalKey } from "../server/journal";

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
      "devboard",
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
    writeAt(join(stateDir, "watchdog", "worker.json"), "{}", old);
    writeAt(join(stateDir, "watchdog", "settings.json"), "{}", old);
    writeAt(join(stateDir, "watchdog", "projection.json"), "{}", old);
    writeAt(join(stateDir, "watchdog", "control", "0001.json"), "{}", old);
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
      join(stateDir, "watchdog", "worker.json"),
      join(stateDir, "watchdog", "settings.json"),
      join(stateDir, "watchdog", "projection.json"),
      join(stateDir, "watchdog", "control", "0001.json"),
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

  test("keeps a live dashboard's static snapshot and sweeps a dead one", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    const serving = join(stateDir, "serving");
    const liveSnapshot = join(serving, `${process.pid}-1.0.0`);
    const deadSnapshot = join(serving, `${deadPid()}-1.0.0`);
    writeAt(join(liveSnapshot, "index.html"), "<!doctype html><title>live</title>", old);
    utimesSync(liveSnapshot, old, old);
    writeAt(join(deadSnapshot, "index.html"), "<!doctype html><title>dead</title>", old);
    utimesSync(deadSnapshot, old, old);

    sweepStateDir(stateDir, { now: sweepNow, dryRun: false });

    expect(existsSync(join(liveSnapshot, "index.html"))).toBe(true);
    expect(existsSync(deadSnapshot)).toBe(false);
  });

  test("keeps a live scout lock and sweeps a dead owner's lock", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    const scoutDir = join(stateDir, "scout");
    const lock = join(scoutDir, "lock");
    mkdirSync(scoutDir, { recursive: true });
    const held = acquireLock(lock, {
      repo: base,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    if (!held.acquired) throw new Error("test lock was not acquired");
    utimesSync(lock, old, old);

    const scanDir = join(scoutDir, "scans", "2026-10-01T00-00-00-000Z");
    const staleScan = join(scanDir, "scan.json");
    writeAt(staleScan, "{}", old);
    utimesSync(scanDir, old, old);
    utimesSync(join(scoutDir, "scans"), old, old);

    const live = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });
    expect(existsSync(lock)).toBe(true);
    expect(live.removed.map((candidate) => candidate.path)).not.toContain(lock);
    expect(existsSync(staleScan)).toBe(false);

    // A lock recorded by a process that is gone proves nothing and is swept.
    held.release();
    writeAt(
      lock,
      JSON.stringify({
        pid: deadPid(),
        startedAt: new Date(realNow).toISOString(),
        repo: base,
        stateDir,
        harnessVersion: null,
        argv: [],
      }),
      old,
    );
    const dead = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });
    expect(existsSync(lock)).toBe(false);
    expect(dead.removed.map((candidate) => candidate.path)).toContain(lock);
  });

  test("keeps a stopped worker's Auto Scout settings and state while sweeping scan archives", async () => {
    const base = await temporaryDirectory();
    const repoDir = join(base, "repo");
    const stateDir = join(repoDir, ".devboard", ".tmp");
    const saved = { maxPerHour: 2, maxPending: 1, intervalMinutes: 720 };
    const settings = settingsPath(stateDir, repoDir);
    const state = statePath(stateDir, repoDir);
    await mkdir(repoDir, { recursive: true });
    writeAt(settings, JSON.stringify(saved), old);
    writeAt(
      state,
      JSON.stringify(
        emptyState({
          repo: "acme/fixture",
          root: repoDir,
          limit: { maxPerHour: saved.maxPerHour, maxPending: saved.maxPending },
          intervalMinutes: saved.intervalMinutes,
          now: old,
        }),
      ),
      old,
    );
    utimesSync(repoStateDirectory(stateDir, repoDir), old, old);
    utimesSync(scoutRoot(stateDir), old, old);
    const scanDir = join(scoutRoot(stateDir), "scans", "2026-10-01T00-00-00-000Z");
    const staleScan = join(scanDir, "scan.json");
    writeAt(staleScan, "{}", old);
    utimesSync(scanDir, old, old);
    utimesSync(join(scoutRoot(stateDir), "scans"), old, old);

    const report = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });
    const removed = report.removed.map((candidate) => candidate.path);

    expect(existsSync(settings)).toBe(true);
    expect(existsSync(state)).toBe(true);
    expect(removed).not.toContain(settings);
    expect(removed).not.toContain(state);
    expect(existsSync(staleScan)).toBe(false);
    expect(removed).toContain(staleScan);

    const worker = new ScoutWorker({
      repoDir,
      stateDir,
      syncMs: 900_000,
      cadenceMs: 900_000,
      now: () => new Date(sweepNow),
      github: {
        listIssues: async () => [],
        listOpenIssueTitles: async () => [],
        listReleases: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      connect: () => {
        throw new Error("a scan must not start");
      },
    });
    try {
      expect(worker.start("acme/fixture")).toBe(true);
      expect(worker.currentState.limits).toEqual({
        maxPerHour: saved.maxPerHour,
        maxPending: saved.maxPending,
      });
      expect(worker.currentState.intervalMinutes).toBe(saved.intervalMinutes);
    } finally {
      await worker.stop();
    }
  });

  test("keeps a stopped design worker's saved settings and state while sweeping cycle scratch", async () => {
    const base = await temporaryDirectory();
    const repoDir = join(base, "repo");
    const stateDir = join(repoDir, ".devboard", ".tmp");
    const saved = { maxPerHour: 2, maxPending: 1, intervalMinutes: 30 };
    const settings = designSettingsPath(stateDir, repoDir);
    const state = designStatePath(stateDir, repoDir);
    await mkdir(repoDir, { recursive: true });
    writeAt(settings, JSON.stringify(saved), old);
    writeAt(
      state,
      JSON.stringify(
        emptyDesignState({
          repo: "acme/fixture",
          root: repoDir,
          lifecycle: "stopped",
          limit: { maxPerHour: saved.maxPerHour, maxPending: saved.maxPending },
          intervalMinutes: saved.intervalMinutes,
          now: old,
        }),
      ),
      old,
    );
    utimesSync(designRepoStateDirectory(stateDir, repoDir), old, old);
    utimesSync(designStateRoot(stateDir), old, old);
    const cycleDir = join(designStateRoot(stateDir), "cycles", "2026-10-01T00-00-00-000Z");
    const staleCycle = join(cycleDir, "audit.json");
    writeAt(staleCycle, "{}", old);
    utimesSync(cycleDir, old, old);
    utimesSync(join(designStateRoot(stateDir), "cycles"), old, old);

    const report = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });
    const removed = report.removed.map((candidate) => candidate.path);

    expect(existsSync(settings)).toBe(true);
    expect(existsSync(state)).toBe(true);
    expect(removed).not.toContain(settings);
    expect(removed).not.toContain(state);
    expect(existsSync(staleCycle)).toBe(false);
    expect(removed).toContain(staleCycle);

    const bridge = new DesignBridge({
      descriptor: agentRegistry.require("design"),
      repoDir,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: null,
      harnessDir: harnessRoot,
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: () => undefined,
    });
    try {
      const shown = bridge.snapshot();
      expect(shown.cadence.minutes).toBe(saved.intervalMinutes);
      expect(shown.limits).toEqual({
        maxPerHour: saved.maxPerHour,
        maxPending: saved.maxPending,
      });
    } finally {
      bridge.dispose();
    }
  });

  test("protects Flow session records from the retention sweep", async () => {
    const base = await temporaryDirectory();
    const stateDir = join(base, ".tmp");
    const flowRoot = join(stateDir, "flow", "a".repeat(24));
    const sessionDir = join(flowRoot, "0123456789abcdef");
    const sessionFile = join(sessionDir, "session.json");
    const session = {
      id: "0123456789abcdef",
      baseRevision: null,
      worktree: join(base, "worktree"),
      branch: "flow/0123456789abcdef",
      status: "merged",
      goal: "Keep this session",
      decisions: "",
      steering: [],
      accepted: [],
      widgets: [],
      files: [],
      checkpoints: [],
      verification: null,
      blockers: [],
      pr: null,
      prError: null,
      leftover: null,
      pushedTip: null,
      prFailedTip: null,
      lastDiffHash: null,
      createdAt: new Date(realNow).toISOString(),
      updatedAt: new Date(realNow).toISOString(),
    };
    writeAt(sessionFile, JSON.stringify(session), old);
    utimesSync(sessionDir, old, old);
    utimesSync(flowRoot, old, old);
    writeAt(join(stateDir, "flow.json"), "unrelated", old);
    const unrelated = join(stateDir, "unrelated", "old.txt");
    writeAt(unrelated, "old", old);
    utimesSync(join(stateDir, "unrelated"), old, old);

    const report = sweepStateDir(stateDir, { now: sweepNow, dryRun: false });
    const candidatePaths = report.candidates.map((candidate) => candidate.path);
    const removedPaths = report.removed.map((candidate) => candidate.path);

    expect(candidatePaths).not.toContain(sessionDir);
    expect(candidatePaths).not.toContain(sessionFile);
    expect(removedPaths).not.toContain(sessionDir);
    expect(removedPaths).not.toContain(sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
    expect(existsSync(flowRoot)).toBe(true);
    expect(existsSync(unrelated)).toBe(false);
    expect(candidatePaths).toContain(unrelated);
  });

  test("leaves a merged Flow session readable by Flow restore", async () => {
    const base = await temporaryDirectory();
    const repoDir = join(base, "repo");
    const stateDir = join(base, ".tmp");
    const sessionId = "0123456789abcdef";
    const sessionDir = join(stateDir, "flow", journalKey(repoDir), sessionId);
    writeAt(
      join(sessionDir, "session.json"),
      JSON.stringify({
        id: sessionId,
        baseRevision: null,
        worktree: join(base, "worktree"),
        branch: `flow/${sessionId}`,
        status: "merged",
        goal: "Keep this session",
        decisions: "",
        steering: [],
        accepted: [],
        widgets: [],
        files: [],
        checkpoints: [],
        verification: null,
        blockers: [],
        pr: null,
        prError: null,
        leftover: null,
        pushedTip: null,
        prFailedTip: null,
        lastDiffHash: null,
        createdAt: new Date(realNow).toISOString(),
        updatedAt: new Date(realNow).toISOString(),
      }),
      old,
    );
    utimesSync(sessionDir, old, old);
    utimesSync(join(stateDir, "flow"), old, old);
    utimesSync(join(stateDir, "flow", journalKey(repoDir)), old, old);

    runCleanup({
      root: base,
      now: sweepNow,
      covered: [{ stateDir, source: "canonical" }],
    });

    const flow = new FlowController({
      repoDir,
      stateDir,
      agentCommand: "true",
      agentEnvironment: async () => ({}),
      broadcast: () => undefined,
    });
    try {
      // #restore is queued as a microtask from the constructor and completes
      // synchronously for a merged-only history.
      await Promise.resolve();
      expect(flow.snapshot().history.map((entry) => entry.sessionId)).toEqual([sessionId]);
    } finally {
      flow.dispose();
    }
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
    const harness = join(host, ".devboard", "node_modules", "@dsdenes", "devboard");
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

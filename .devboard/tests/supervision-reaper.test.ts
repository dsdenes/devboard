import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journalKey } from "../server/journal";
import { writeWatchdogCommand } from "../watchdog/control";
import { versionedControlDirectory, watchdogDirectory } from "../watchdog/paths";
import { runOrphanReaper } from "../watchdog/reaper";
import { writeWatchdogSettings } from "../watchdog/settings";
import {
  liveProcess,
  processStat,
  readSupervisionRecords,
  reapOrphans,
  startOrphanSupervisor,
  supervisedDetach,
  SUPERVISION_INTERVAL_MS,
} from "../watchdog/supervision";
import { runWorker } from "../watchdog/worker";
import { writeDetachedLease } from "../server/detached-run";
import {
  cleanupScratch,
  killFixture,
  recordOf,
  scratch,
  snapshotOf,
  spawnUnrecorded,
  treeFixture,
  waitFor,
} from "./fixtures/supervision-helpers";

/**
 * One reaper, two activations, two proofs. The interval is its own; a kill
 * needs either a record whose owner is dead and whose argv and start time
 * still match, or an unrecorded verification process reparented to PID 1.
 * Every doubt and every live lease, handoff, or worker lock leaves the process
 * alive.
 */

afterAll(cleanupScratch);

describe("orphan reaper cadence", () => {
  test("the reaper keeps one dedicated interval of at most one minute", () => {
    let scheduled: number | undefined;
    let passes = 0;
    const supervisor = startOrphanSupervisor({
      reap: () => {
        passes += 1;
      },
      setInterval: (_handler, ms) => {
        scheduled = ms;
        return { id: 1 };
      },
      clearInterval: () => undefined,
    });
    supervisor.stop();
    expect(SUPERVISION_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    expect(scheduled).toBe(SUPERVISION_INTERVAL_MS);
    // The pass at activation runs before any interval fires.
    expect(passes).toBe(1);
  });

  test("the watchdog worker starts the reaper on its own cadence, not the cycle's", async () => {
    const root = await scratch("supervision-reaper-worker");
    const stateDir = watchdogDirectory(root);
    const ownerStateDir = join(root, ".devboard", ".tmp");
    writeWatchdogSettings(stateDir, { intervalMinutes: 1440, maxPerHour: null, maxPending: null });
    let started: { root: string; stateDir: string; intervalMs: number } | undefined;
    let stops = 0;
    const worker = runWorker({
      root,
      stateDir,
      ownerStateDir,
      harnessVersion: "1.0.0",
      cycle: async () => ({ report: { action: "none" } }),
      pollMs: 10,
      supervisor: (options) => {
        started = options;
        return {
          stop: () => {
            stops += 1;
          },
        };
      },
    });
    await waitFor(() => started, "the reaper start");
    expect(started?.intervalMs).toBe(SUPERVISION_INTERVAL_MS);
    expect(started?.intervalMs).toBeLessThan(1440 * 60_000);
    writeWatchdogCommand(versionedControlDirectory(stateDir, "1.0.0"), { type: "stop" });
    await worker;
    expect(stops).toBe(1);
  }, 30_000);
});

describe("orphan reaper proofs", () => {
  test("reaps a recorded child whose owner is gone and removes the record", async () => {
    const scratchDir = await scratch("supervision-rule1");
    const stateDir = join(scratchDir, ".devboard", ".tmp");
    const marker = join(scratchDir, "tree");
    const ownerPid = supervisedDetach([process.execPath, treeFixture, stateDir, "owner", marker], {
      cwd: scratchDir,
      env: { ...process.env, STATE_DIR: stateDir },
      stateDir,
    });
    expect(ownerPid).toBeDefined();
    const peerPid = await waitFor(
      () => {
        try {
          const text = readFileSync(`${marker}.peer`, "utf8").trim();
          return text.length === 0 ? undefined : Number(text);
        } catch {
          return undefined;
        }
      },
      "the peer",
    );
    try {
      await waitFor(() => recordOf(stateDir, peerPid), "the peer record");
      process.kill(ownerPid!, "SIGKILL");
      const report = reapOrphans({
        scopes: [{ stateDir, repoDir: scratchDir }],
        processes: snapshotOf([peerPid]),
        killGraceMs: 500,
      });
      expect(report.killed).toContain(peerPid);
      expect(liveProcess(peerPid)).toBe(false);
      expect(recordOf(stateDir, peerPid)).toBeUndefined();
      expect(recordOf(stateDir, ownerPid!)).toBeUndefined();
    } finally {
      killFixture(ownerPid);
      killFixture(peerPid);
    }
  }, 30_000);

  test("never signals a recorded child whose owner is alive", async () => {
    const scratchDir = await scratch("supervision-rule2");
    const stateDir = join(scratchDir, ".devboard", ".tmp");
    const child = supervisedDetach([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      cwd: scratchDir,
      env: { ...process.env },
      stateDir,
    });
    try {
      const record = await waitFor(() => recordOf(stateDir, child!), "the child record");
      expect(record.ownerPid).toBe(process.pid);
      const report = reapOrphans({
        scopes: [{ stateDir, repoDir: scratchDir }],
        processes: snapshotOf([child!]),
        killGraceMs: 100,
      });
      expect(report.killed).not.toContain(child);
      expect(liveProcess(child!)).toBe(true);
      expect(recordOf(stateDir, child!)).toBeDefined();
    } finally {
      killFixture(child);
    }
  }, 30_000);

  test("reaps an unrecorded scratch process reparented to PID 1", async () => {
    const scratchDir = await scratch("supervision-rule3");
    const stateDir = join(scratchDir, ".devboard", ".tmp");
    const marker = join(scratchDir, "orphan.pid");
    const pid = await spawnUnrecorded(scratchDir, { scratch: true, marker });
    try {
      const report = reapOrphans({
        scopes: [{ stateDir, repoDir: scratchDir }],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 500,
      });
      expect(report.killed).toContain(pid);
      expect(report.decisions.some((entry) => entry.reason === "scratch")).toBe(true);
      expect(liveProcess(pid)).toBe(false);
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("never signals an unrecorded process outside verification scratch", async () => {
    const scratchDir = await scratch("supervision-rule4");
    const stateDir = join(scratchDir, ".devboard", ".tmp");
    const marker = join(scratchDir, "outside.pid");
    const pid = await spawnUnrecorded(scratchDir, { scratch: false, marker });
    try {
      const report = reapOrphans({
        scopes: [{ stateDir, repoDir: scratchDir }],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 100,
      });
      expect(report.killed).not.toContain(pid);
      expect(liveProcess(pid)).toBe(true);
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("never signals a detached run that holds a live lease", async () => {
    const host = await scratch("supervision-rule5");
    const stateDir = join(host, ".devboard", ".tmp");
    const marker = join(host, "leased.pid");
    const pid = await spawnUnrecorded(host, { scratch: true, marker });
    try {
      writeDetachedLease(stateDir, host, "supervision-test");
      const runDirectory = join(stateDir, "runs", journalKey(host), "lane", "record");
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(
        join(runDirectory, "state.json"),
        `${JSON.stringify({ owner: { pid }, peer: null, status: "running" })}\n`,
      );
      const report = runOrphanReaper({
        root: host,
        stateDir,
        instances: [],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 100,
      });
      expect(report.killed).not.toContain(pid);
      expect(
        report.decisions.some((entry) => entry.action === "skipped" && entry.pid === pid),
      ).toBe(true);
      expect(liveProcess(pid)).toBe(true);
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("never signals a run a fresh handoff is about to hand over", async () => {
    const host = await scratch("supervision-rule5-handoff");
    const stateDir = join(host, ".devboard", ".tmp");
    const marker = join(host, "handoff.pid");
    const pid = await spawnUnrecorded(host, { scratch: true, marker });
    try {
      const runRoot = join(stateDir, "runs", journalKey(host));
      mkdirSync(runRoot, { recursive: true });
      // The marker names the process that began the handoff, which has exited
      // by the time a replacement starts; its age is what proves the successor
      // is about to adopt the run.
      writeFileSync(
        join(runRoot, "handoff.json"),
        `${JSON.stringify({ at: Date.now(), pid: 999_999 })}\n`,
      );
      const runDirectory = join(runRoot, "lane", "handoff");
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(
        join(runDirectory, "state.json"),
        `${JSON.stringify({ owner: { pid }, peer: null, status: "running" })}\n`,
      );
      const report = runOrphanReaper({
        root: host,
        stateDir,
        instances: [],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 100,
      });
      expect(report.killed).not.toContain(pid);
      expect(
        report.decisions.some((entry) => entry.action === "skipped" && entry.pid === pid),
      ).toBe(true);
      expect(liveProcess(pid)).toBe(true);
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("never signals a live worker of an older harness version", async () => {
    const host = await scratch("supervision-rule6");
    const stateDir = join(host, ".devboard", ".tmp");
    const marker = join(host, "old-worker.pid");
    const pid = await spawnUnrecorded(host, { scratch: true, marker });
    try {
      mkdirSync(join(stateDir, "watchdog"), { recursive: true });
      writeFileSync(
        join(stateDir, "watchdog", "lock.0.0.1-old"),
        `${JSON.stringify({
          pid,
          startedAt: new Date().toISOString(),
          repo: host,
          stateDir,
          harnessVersion: "0.0.1-old",
          argv: ["worker.ts"],
          token: "older-version",
        })}\n`,
      );
      const report = runOrphanReaper({
        root: host,
        stateDir,
        instances: [],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 100,
      });
      expect(report.killed).not.toContain(pid);
      expect(
        report.decisions.some((entry) => entry.action === "skipped" && entry.pid === pid),
      ).toBe(true);
      expect(liveProcess(pid)).toBe(true);
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("journals a candidate it leaves alive", async () => {
    const host = await scratch("supervision-journal");
    const stateDir = join(host, ".devboard", ".tmp");
    const marker = join(host, "journalled.pid");
    const pid = await spawnUnrecorded(host, { scratch: true, marker });
    try {
      writeDetachedLease(stateDir, host, "supervision-test");
      const runDirectory = join(stateDir, "runs", journalKey(host), "lane", "journal");
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(
        join(runDirectory, "state.json"),
        `${JSON.stringify({ owner: { pid }, peer: null, status: "running" })}\n`,
      );
      runOrphanReaper({
        root: host,
        stateDir,
        instances: [],
        processes: snapshotOf([pid]),
        orphanGraceMs: 0,
        killGraceMs: 100,
      });
      const log = readFileSync(join(stateDir, "supervision", "reaped.jsonl"), "utf8");
      expect(log).toContain(`"pid":${pid}`);
      expect(log).toContain('"action":"skipped"');
    } finally {
      killFixture(pid);
    }
  }, 30_000);

  test("removes a record whose process is already gone", async () => {
    const scratchDir = await scratch("supervision-stale-record");
    const stateDir = join(scratchDir, ".devboard", ".tmp");
    const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await exited.exited;
    mkdirSync(join(stateDir, "supervision"), { recursive: true });
    writeFileSync(
      join(stateDir, "supervision", `${exited.pid}.json`),
      `${JSON.stringify({
        version: 1,
        pid: exited.pid,
        argv: ["gone"],
        cwd: scratchDir,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
        startTicks: 0,
        pgid: exited.pid,
      })}\n`,
    );
    const report = reapOrphans({ scopes: [{ stateDir, repoDir: scratchDir }], processes: [] });
    expect(report.removedRecords).toContain(exited.pid);
    expect(readSupervisionRecords(stateDir)).toEqual([]);
  }, 30_000);
});

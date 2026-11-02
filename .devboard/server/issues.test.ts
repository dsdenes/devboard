import { afterAll, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IssuesBridge } from "./issues";
import { acquireLock, versionLockPath } from "../issues/lock";
import {
  controlDirectory,
  drainMarkerPath,
  lockPath,
  runsDirectory,
  statePath,
  versionedStatePath,
} from "../issues/paths";
import {
  emptyState,
  readState,
  writeState,
  type IssuesAgent,
  type IssuesIssue,
  type IssuesState,
} from "../issues/state";
import { writeDrainMarker } from "../issues/control";
import { recordClosedByRun } from "../issues/self-close";
import { GITLAB_TRACKER_UNSUPPORTED } from "../issues/tracker";
import { createdDirectories, temporaryDirectory } from "../tests/fixtures/scout-helpers";

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function bridge(repoDir: string, stateDir: string): IssuesBridge {
  return new IssuesBridge({
    repoDir,
    stateDir,
    agentCommand: "stub",
    agentEnvironment: async () => ({}),
    runningVersion: "0.1.0",
    harnessDir: join(import.meta.dir, ".."),
    send: () => undefined,
    pollMs: 60_000,
    spawnWorker: () => undefined,
  });
}

describe("issues bridge commands", () => {
  test("a live lock with no state file receives Stop and pause", async () => {
    const root = await temporaryDirectory("issues-bridge-repo");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const subject = bridge(root, stateDir);
    try {
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });
      expect(subject.command({ type: "pause" })).toEqual({ ok: true });
      expect(
        subject.command({ type: "answer", id: 1, value: "yes", runId: "run-1" }),
      ).toEqual({ ok: false, message: "No agent is running for run run-1." });
      const files = await readdir(controlDirectory(stateDir, root));
      expect(files).toHaveLength(2);
      const commands = await Promise.all(
        files
          .sort()
          .map(async (name) =>
            JSON.parse(await readFile(join(controlDirectory(stateDir, root), name), "utf8")),
          ),
      );
      expect(commands).toEqual([{ type: "stop" }, { type: "pause" }]);
    } finally {
      subject.dispose();
      lock.release();
    }
  }, 10_000);

  test("deleting the attached worker's state still proves Stop and ends it", async () => {
    const root = await temporaryDirectory("issues-bridge-worker");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "issues", "worker.ts");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, "console.log('ready');\nsetInterval(() => undefined, 1000);\n");
    const worker = Bun.spawn({
      cmd: [process.execPath, script, root],
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const reader = worker.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const subject = bridge(root, stateDir);
    vi.useFakeTimers();
    try {
      writeState(statePath(stateDir, root), {
        ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" }),
        enabled: true,
        worker: {
          pid: worker.pid,
          startedAt: new Date().toISOString(),
          stateDir,
          harnessVersion: null,
          argv: [],
        },
      });
      await mkdir(dirname(lockPath(root)), { recursive: true });
      await writeFile(
        lockPath(root),
        JSON.stringify({
          pid: worker.pid,
          startedAt: new Date().toISOString(),
          repo: root,
          stateDir,
          harnessVersion: null,
          argv: [script, root],
        }),
      );
      expect(subject.snapshot().attached).toBe(true);

      await rm(statePath(stateDir, root), { force: true });
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });

      // The stop proof fires 3 s after the command; advance the clock instead
      // of waiting, then await the worker's own exit signal.
      vi.advanceTimersByTime(3000);
      const code = await worker.exited;
      expect(code).not.toBeNull();
    } finally {
      vi.useRealTimers();
      subject.dispose();
      worker.kill("SIGKILL");
      await rm(lockPath(root), { force: true });
      await worker.exited;
    }
  }, 20_000);

  test("Start after Stop waits for the stopping worker and spawns", async () => {
    const root = await temporaryDirectory("issues-bridge-stop-start");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "issues", "worker.ts");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(
      script,
      "process.on('SIGTERM', () => undefined);\n" +
        "console.log('ready');\nsetInterval(() => undefined, 1000);\n",
    );
    const worker = Bun.spawn({
      cmd: [process.execPath, script, root],
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const reader = worker.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    await mkdir(dirname(lockPath(root)), { recursive: true });
    await writeFile(
      lockPath(root),
      JSON.stringify({
        pid: worker.pid,
        startedAt: new Date().toISOString(),
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: [script, root],
      }),
    );
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    vi.useFakeTimers();
    try {
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });
      // The proof signals the worker, which ignores SIGTERM; the stop is still
      // pending through the grace, so Start must wait rather than attach.
      vi.advanceTimersByTime(3000);
      const starting = subject.start();
      expect(spawned).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      await worker.exited;
      vi.advanceTimersByTime(50);
      expect(await starting).toEqual({ ok: true, attached: false });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.join(" ")).toContain(join("issues", "worker.ts"));
    } finally {
      vi.useRealTimers();
      subject.dispose();
      worker.kill("SIGKILL");
      await worker.exited;
      await rm(lockPath(root), { force: true });
    }
  }, 20_000);

  test("Stop proves every live worker, not only the last one", async () => {
    const root = await temporaryDirectory("issues-bridge-two-owners");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "issues", "worker.ts");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(
      script,
      "process.on('SIGTERM', () => undefined);\n" +
        "console.log('ready');\nsetInterval(() => undefined, 1000);\n",
    );
    const spawnFixtureWorker = async () => {
      const worker = Bun.spawn({
        cmd: [process.execPath, script, root],
        cwd: root,
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const reader = worker.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      return worker;
    };
    const first = await spawnFixtureWorker();
    const second = await spawnFixtureWorker();
    const writeOwner = async (path: string, pid: number, version: string | null) => {
      await writeFile(
        path,
        JSON.stringify({
          pid,
          startedAt: new Date().toISOString(),
          repo: root,
          stateDir,
          harnessVersion: version,
          argv: [script, root],
        }),
      );
    };
    await mkdir(dirname(lockPath(root)), { recursive: true });
    await writeOwner(lockPath(root), first.pid, null);
    await writeOwner(versionLockPath(lockPath(root), "0.1.0"), second.pid, "0.1.0");
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    vi.useFakeTimers();
    try {
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });
      // Both workers ignore SIGTERM, so each proof must run its own grace and
      // both workers exit rather than only the last one scheduled.
      vi.advanceTimersByTime(3000);
      vi.advanceTimersByTime(2000);
      vi.useRealTimers();
      // SIGKILL delivery is the platform clock, not the fake one, so the wait
      // for both exits is bounded; the bound costs time only on failure.
      const exits = Promise.all([first.exited, second.exited]).then(() => "exited" as const);
      const { promise: timedOut, resolve: boundElapsed } = Promise.withResolvers<"alive">();
      const bound = setTimeout(() => boundElapsed("alive"), 5000);
      const outcome = await Promise.race([exits, timedOut]);
      clearTimeout(bound);
      expect(outcome).toBe("exited");
      expect(await subject.start()).toEqual({ ok: true, attached: false });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.join(" ")).toContain(join("issues", "worker.ts"));
    } finally {
      vi.useRealTimers();
      subject.dispose();
      first.kill("SIGKILL");
      second.kill("SIGKILL");
      await Promise.all([first.exited, second.exited]);
      await rm(lockPath(root), { force: true });
      await rm(versionLockPath(lockPath(root), "0.1.0"), { force: true });
    }
  }, 20_000);

  test("the stop proof signals a worker whose repository is reached through a symlink", async () => {
    const base = await temporaryDirectory("issues-bridge-symlink");
    const root = join(base, "repo");
    const link = join(base, "link");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "issues", "worker.ts");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(
      script,
      "process.on('SIGTERM', () => undefined);\n" +
        "console.log('ready');\nsetInterval(() => undefined, 1000);\n",
    );
    await symlink(root, link);
    const worker = Bun.spawn({
      cmd: [process.execPath, script, link],
      cwd: link,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const reader = worker.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    await mkdir(dirname(lockPath(link)), { recursive: true });
    await writeFile(
      lockPath(link),
      JSON.stringify({
        pid: worker.pid,
        startedAt: new Date().toISOString(),
        repo: link,
        stateDir,
        harnessVersion: null,
        argv: [script, link],
      }),
    );
    const subject = new IssuesBridge({
      repoDir: link,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: () => 4242,
    });
    vi.useFakeTimers();
    try {
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });
      // The proof matches the canonical cwd and signals a worker that ignores
      // SIGTERM; the grace escalates to SIGKILL.
      vi.advanceTimersByTime(3000);
      vi.advanceTimersByTime(2000);
      await worker.exited;
    } finally {
      vi.useRealTimers();
      subject.dispose();
      worker.kill("SIGKILL");
      await worker.exited;
      await rm(lockPath(link), { force: true });
    }
  }, 20_000);

  test("Start refuses while the stopping worker outlives the proof deadline", async () => {
    const root = await temporaryDirectory("issues-bridge-still-stopping");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    vi.useFakeTimers();
    try {
      expect(subject.command({ type: "stop" })).toEqual({ ok: true });
      const starting = subject.start();
      vi.advanceTimersByTime(5000);
      const result = await starting;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(`pid ${process.pid}`);
      expect(spawned).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      subject.dispose();
      lock.release();
    }
  });

  test("Start attaches to a live worker when no stop is pending", async () => {
    const root = await temporaryDirectory("issues-bridge-attach");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      expect(await subject.start()).toEqual({ ok: true, attached: true });
      expect(spawned).toHaveLength(0);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("concurrent Starts share one spawn", async () => {
    const root = await temporaryDirectory("issues-bridge-concurrent");
    const stateDir = join(root, "state");
    const gate = Promise.withResolvers<void>();
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => {
        await gate.promise;
        return { ok: true, repository: "acme/fixture" };
      },
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      const first = subject.start();
      const second = subject.start();
      gate.resolve();
      expect(await Promise.all([first, second])).toEqual([
        { ok: true, attached: false },
        { ok: true, attached: false },
      ]);
      expect(spawned).toHaveLength(1);
    } finally {
      subject.dispose();
    }
  });

  test("a stalled start preflight fails at the deadline and the next Start retries", async () => {
    const root = await temporaryDirectory("issues-bridge-preflight-deadline");
    const stateDir = join(root, "state");
    let calls = 0;
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflightTimeoutMs: 20,
      preflight: async () => {
        calls += 1;
        if (calls === 1) await new Promise<never>(() => undefined);
        return { ok: true, repository: "acme/fixture" };
      },
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      const started = Date.now();
      const first = await subject.start();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.message).toContain("did not finish within 20 ms");
      expect(calls).toBe(1);
      expect(spawned).toHaveLength(0);

      // The timed-out task cleared its memo: this Start runs the preflight
      // again and spawns the worker the runner now accepts.
      expect(await subject.start()).toEqual({ ok: true, attached: false });
      expect(calls).toBe(2);
      expect(spawned).toHaveLength(1);
    } finally {
      subject.dispose();
    }
  });

  test("a stale lock whose pid was reused lets Start spawn instead of attaching", async () => {
    const root = await temporaryDirectory("issues-bridge-stale");
    const stateDir = join(root, "state");
    await mkdir(dirname(lockPath(root)), { recursive: true });
    // The pid is alive (this test process); the recorded start cannot be its
    // own, which is what a killed worker's lock looks like after pid reuse.
    await writeFile(
      lockPath(root),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(0).toISOString(),
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: [],
      }),
    );
    const spawned: string[][] = [];
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      expect(subject.snapshot().attached).toBe(false);
      expect(await subject.start()).toEqual({ ok: true, attached: false });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.join(" ")).toContain(join("issues", "worker.ts"));
    } finally {
      subject.dispose();
    }
  });
});

function issue(number: number): IssuesIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://gitea.test/acme/fixture/issues/${number}`,
    createdAt: "2026-10-29T00:00:00Z",
    labels: [],
  };
}

function runningAgent(number: number, runId: string): IssuesAgent {
  return {
    runId,
    issueNumber: number,
    startedAt: "2026-01-01T00:00:00.000Z",
    question: null,
    acp: null,
  };
}

async function controlCommands(stateDir: string, root: string): Promise<unknown[]> {
  try {
    const files = await readdir(controlDirectory(stateDir, root));
    return await Promise.all(
      files.sort().map(async (name) => JSON.parse(await readFile(join(controlDirectory(stateDir, root), name), "utf8"))),
    );
  } catch {
    return [];
  }
}

/**
 * Records a worker poll at `at`. Called from a dashboard read, a time between
 * the read's start and its completion proves the worker's read is newer.
 */
function recordWorkerPoll(stateDir: string, root: string, at: string): void {
  const state = readState(statePath(stateDir, root));
  if (state === undefined) throw new Error("worker state vanished");
  writeState(statePath(stateDir, root), {
    ...state,
    poll: { ...state.poll, lastPollAt: at, error: null },
  });
}

/** A read clock: `start` for the read's begin, `finished` for its completion. */
function readClock(start: string, finished: string): () => Date {
  let calls = 0;
  return () => new Date(calls++ === 0 ? start : finished);
}

describe("dashboard tracker sync", () => {
  test("a stopped worker's stale queue is replaced by the live open list", async () => {
    const root = await temporaryDirectory("issues-sync-stopped");
    const stateDir = join(root, "state");
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root }),
      queue: [
        { ...issue(1), handled: false, runId: null, agentRunId: null },
        { ...issue(2), handled: false, runId: null, agentRunId: null },
      ],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [], etag: null }),
    });
    try {
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([1, 2]);
      await subject.syncNow();
      expect(subject.snapshot().queue).toEqual([]);
      expect(subject.snapshot().sync.lastSyncAt).not.toBeNull();
      expect(subject.snapshot().sync.error).toBeNull();
      expect(await controlCommands(stateDir, root)).toEqual([]);
    } finally {
      subject.dispose();
    }
  });

  test("a stopped worker's stale running markers never count as running", async () => {
    const root = await temporaryDirectory("issues-sync-stale-markers");
    const stateDir = join(root, "state");
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root }),
      queue: [
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
        { ...issue(6), handled: true, runId: "run-4", agentRunId: "run-6" },
      ],
    });
    const subject = bridge(root, stateDir);
    try {
      const snapshot = subject.snapshot();
      expect(snapshot.attached).toBe(false);
      expect(snapshot.agents).toEqual([]);
      // Handled and last-run markers are history; a running marker is not, so
      // it survives only while a live worker owns the state.
      expect(snapshot.queue).toEqual([
        { ...issue(5), handled: false, runId: null, agentRunId: null },
        { ...issue(6), handled: true, runId: "run-4", agentRunId: null },
      ]);
    } finally {
      subject.dispose();
    }
  });

  test("a stopped worker's running markers are dropped from the dashboard's open list", async () => {
    const root = await temporaryDirectory("issues-sync-stale-marker-list");
    const stateDir = join(root, "state");
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root }),
      queue: [
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
        { ...issue(6), handled: true, runId: "run-4", agentRunId: "run-6" },
      ],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [issue(5), issue(6)], etag: null }),
    });
    try {
      await subject.syncNow();
      expect(subject.snapshot().queue).toEqual([
        { ...issue(5), handled: false, runId: null, agentRunId: null },
        { ...issue(6), handled: true, runId: "run-4", agentRunId: null },
      ]);
    } finally {
      subject.dispose();
    }
  });

  test("an attached worker's running markers survive the dashboard's open list", async () => {
    const root = await temporaryDirectory("issues-sync-live-marker-list");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" }),
      enabled: true,
      agents: [runningAgent(5, "run-5")],
      queue: [{ ...issue(5), handled: false, runId: null, agentRunId: "run-5" }],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [issue(5)], etag: null }),
    });
    try {
      await subject.syncNow();
      const snapshot = subject.snapshot();
      expect(snapshot.attached).toBe(true);
      expect(snapshot.queue).toEqual([
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
      ]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a closed running issue receives one abandon command and leaves the queue", async () => {
    const root = await temporaryDirectory("issues-sync-abandon");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const state = {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" as const }),
      enabled: true,
      agents: [runningAgent(5, "run-5")],
      queue: [
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
        { ...issue(6), handled: false, runId: null, agentRunId: null },
      ],
    };
    await writeState(statePath(stateDir, root), state);
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [issue(6)], etag: null }),
    });
    try {
      expect(subject.snapshot().attached).toBe(true);
      await subject.syncNow();
      const snapshot = subject.snapshot();
      expect(snapshot.queue.map((entry) => entry.number)).toEqual([6]);
      expect(await controlCommands(stateDir, root)).toEqual([{ type: "abandon", number: 5 }]);

      // The same closure on the next read must not queue a second command.
      await subject.syncNow();
      expect(await controlCommands(stateDir, root)).toEqual([{ type: "abandon", number: 5 }]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a run that closed its own issue receives no abandon command", async () => {
    const root = await temporaryDirectory("issues-sync-self-close");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" as const }),
      enabled: true,
      agents: [runningAgent(5, "run-5")],
      queue: [{ ...issue(5), handled: false, runId: null, agentRunId: "run-5" }],
    });
    // The run closed #5 itself; its worker settles it as succeeded.
    recordClosedByRun(stateDir, root, 5, "run-5");
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [], etag: null }),
    });
    try {
      await subject.syncNow();
      expect(await controlCommands(stateDir, root)).toEqual([]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a failed abandon write is retried by the next fresh read", async () => {
    const root = await temporaryDirectory("issues-sync-abandon-retry");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" as const }),
      enabled: true,
      agents: [runningAgent(5, "run-5")],
      queue: [
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
        { ...issue(6), handled: false, runId: null, agentRunId: null },
      ],
    });
    // A file where the control directory belongs makes the abandon write fail.
    const control = controlDirectory(stateDir, root);
    await writeFile(control, "not a directory\n");
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [issue(6)], etag: null }),
    });
    try {
      await subject.syncNow();
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([6]);
      expect(await controlCommands(stateDir, root)).toEqual([]);

      await rm(control, { force: true });
      await subject.syncNow();
      expect(await controlCommands(stateDir, root)).toEqual([{ type: "abandon", number: 5 }]);

      // A successful write is not repeated on later reads.
      await subject.syncNow();
      expect(await controlCommands(stateDir, root)).toEqual([{ type: "abandon", number: 5 }]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a run younger than the read is neither hidden nor abandoned", async () => {
    const root = await temporaryDirectory("issues-sync-young-run");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" }),
      enabled: true,
      agents: [{ ...runningAgent(5, "run-5"), startedAt: "2099-01-01T00:00:00.000Z" }],
      queue: [
        { ...issue(5), handled: false, runId: null, agentRunId: "run-5" },
        { ...issue(6), handled: false, runId: null, agentRunId: null },
      ],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "issues", issues: [issue(6)], etag: null }),
    });
    try {
      await subject.syncNow();
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([5, 6]);
      expect(await controlCommands(stateDir, root)).toEqual([]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a worker poll that started after the dashboard read keeps its running issue", async () => {
    const root = await temporaryDirectory("issues-sync-worker-newer");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" }),
      enabled: true,
      agents: [runningAgent(5, "run-5")],
      queue: [{ ...issue(5), handled: false, runId: null, agentRunId: "run-5" }],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => {
        // The issue is reopened while this read is in flight: the worker's own
        // poll ran after the read began and still lists #5 open.
        recordWorkerPoll(stateDir, root, "2026-10-30T12:00:00.500Z");
        return { kind: "issues", issues: [issue(6)], etag: null };
      },
      now: readClock("2026-10-30T12:00:00.000Z", "2026-10-30T12:00:01.000Z"),
    });
    try {
      await subject.syncNow();
      expect(await controlCommands(stateDir, root)).toEqual([]);
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([5]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a worker poll that started after the read keeps the worker queue", async () => {
    const root = await temporaryDirectory("issues-sync-worker-queue");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root, lifecycle: "running" }),
      enabled: true,
      queue: [{ ...issue(7), handled: false, runId: null, agentRunId: null }],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => {
        recordWorkerPoll(stateDir, root, "2026-10-30T12:00:00.500Z");
        return { kind: "issues", issues: [issue(6)], etag: null };
      },
      now: readClock("2026-10-30T12:00:00.000Z", "2026-10-30T12:00:01.000Z"),
    });
    try {
      await subject.syncNow();
      expect(subject.snapshot().sync.lastSyncAt).not.toBeNull();
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([7]);
    } finally {
      subject.dispose();
      lock.release();
    }
  });

  test("a read failure keeps the worker's queue and publishes the error", async () => {
    const root = await temporaryDirectory("issues-sync-failed");
    const stateDir = join(root, "state");
    await writeState(statePath(stateDir, root), {
      ...emptyState({ repo: "acme/fixture", root }),
      queue: [{ ...issue(1), handled: false, runId: null, agentRunId: null }],
    });
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      syncRead: async () => ({ kind: "error", detail: "HTTP 502" }),
    });
    try {
      await subject.syncNow();
      expect(subject.snapshot().queue.map((entry) => entry.number)).toEqual([1]);
      expect(subject.snapshot().sync.error).toBe("HTTP 502");
    } finally {
      subject.dispose();
    }
  });

  test("no client means no tracker read", async () => {
    const root = await temporaryDirectory("issues-sync-idle");
    const stateDir = join(root, "state");
    let calls = 0;
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      hasClients: () => false,
      syncRead: async () => {
        calls += 1;
        return { kind: "issues", issues: [], etag: null };
      },
    });
    try {
      await subject.syncNow();
      expect(calls).toBe(0);
      expect(subject.snapshot().sync.lastSyncAt).toBeNull();
    } finally {
      subject.dispose();
    }
  });

  test("a GitLab checkout publishes the named state through the real reader", async () => {
    const root = await temporaryDirectory("issues-sync-gitlab-origin");
    const stateDir = join(root, "state");
    const git = (...args: string[]) => {
      const outcome = Bun.spawnSync({ cmd: ["git", "-C", root, ...args] });
      expect(outcome.exitCode).toBe(0);
    };
    git("init", "-q");
    git("remote", "add", "origin", "https://gitlab.com/group/project.git");
    await writeState(statePath(stateDir, root), emptyState({ repo: "group/project", root }));
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      environment: {},
    });
    try {
      await subject.syncNow();
      const error = subject.snapshot().sync.error;
      expect(error).toContain("GitLab");
      expect(subject.snapshot().sync.lastSyncAt).toBeNull();
    } finally {
      subject.dispose();
    }
  });

  test("a GitLab origin publishes the named state and stops the periodic sync", async () => {
    const root = await temporaryDirectory("issues-sync-gitlab");
    const stateDir = join(root, "state");
    await writeState(statePath(stateDir, root), emptyState({ repo: "group/project", root }));
    let calls = 0;
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      syncMs: 5,
      spawnWorker: () => undefined,
      syncRead: async () => {
        calls += 1;
        return { kind: "unsupported", detail: GITLAB_TRACKER_UNSUPPORTED };
      },
    });
    vi.useFakeTimers();
    try {
      subject.begin();
      vi.advanceTimersByTime(100);
      await subject.syncNow();
      expect(subject.snapshot().sync.error).toBe(GITLAB_TRACKER_UNSUPPORTED);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(60_000);
      await subject.syncNow();
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
      subject.dispose();
    }
  });
});

describe("issues bridge family view", () => {
  const OLD = "0.1.900";
  const NEW = "0.2.0";

  /** The kernel's start instant, exactly as the lock's owner check reads it. */
  function processStartedAt(pid: number): string {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const ticks = Number(stat.slice(close + 2).split(" ")[19]);
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return new Date(Date.now() - uptime * 1000 + ticks * 10).toISOString();
  }

  /** Two distinct live pids, so two owners never collapse into one state. */
  async function liveProcess(): Promise<{
    pid: number;
    startedAt: string;
    stop: () => void;
  }> {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setTimeout(() => undefined, 60000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        readFileSync(`/proc/${child.pid}/stat`, "utf8");
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("the fixture process never started");
        await Bun.sleep(20);
      }
    }
    return {
      pid: child.pid,
      startedAt: processStartedAt(child.pid),
      stop: () => child.kill("SIGKILL"),
    };
  }

  async function writeLiveLock(
    path: string,
    owner: { pid: number; startedAt: string; harnessVersion: string; stateDir: string },
    repo: string,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...owner, repo, argv: [] }));
  }

  async function writeRunRecord(
    stateDir: string,
    repo: string,
    runId: string,
    issueNumber: number,
    version: string,
    workerPid: number,
    status: "running" | "succeeded",
  ): Promise<void> {
    const directory = join(runsDirectory(stateDir, repo), runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify({
        version: 1,
        runId,
        repo: "acme/fixture",
        status,
        argv: ["omp", "acp"],
        cwd: repo,
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: status === "running" ? null : "2026-10-27T10:01:00.000Z",
        exitCode: status === "running" ? null : 0,
        issues: [
          {
            number: issueNumber,
            title: `Fixture issue ${issueNumber}`,
            url: `https://github.com/acme/fixture/issues/${issueNumber}`,
            createdAt: "2026-10-20T00:00:00Z",
            labels: [],
          },
        ],
        firstStderrLine: null,
        workerPid,
        harnessVersion: version,
      }),
    );
  }

  function ownerState(options: {
    root: string;
    stateDir: string;
    version: string;
    pid: number;
    startedAt: string;
    lifecycle: "running" | "pausing";
    paused: boolean;
    pauseSource?: "operator" | "drain" | null;
    runId: string;
    issueNumber: number;
    lastPollAt: string;
    summaryVersion?: string | null;
  }): IssuesState {
    const agent: IssuesAgent = {
      runId: options.runId,
      issueNumber: options.issueNumber,
      startedAt: "2026-10-27T10:00:00.000Z",
      question: null,
      acp: null,
    };
    const state: IssuesState = {
      ...emptyState({ repo: "acme/fixture", root: options.root }),
      lifecycle: options.lifecycle,
      enabled: true,
      paused: options.paused,
      worker: {
        pid: options.pid,
        startedAt: options.startedAt,
        stateDir: options.stateDir,
        harnessVersion: options.version,
        argv: ["bun", "issues/worker.ts"],
      },
      poll: {
        intervalMs: 10_000,
        lastPollAt: options.lastPollAt,
        nextPollAt: null,
        etag: null,
        notModified: false,
        rateLimitedUntil: null,
        error: null,
      },
      queue: [
        {
          number: options.issueNumber,
          title: `Fixture issue ${options.issueNumber}`,
          url: `https://github.com/acme/fixture/issues/${options.issueNumber}`,
          createdAt: "2026-10-20T00:00:00Z",
          labels: [],
          handled: false,
          runId: null,
          agentRunId: options.runId,
        },
      ],
      runs: [
        {
          runId: options.runId,
          status: "running",
          startedAt: "2026-10-27T10:00:00.000Z",
          finishedAt: null,
          exitCode: null,
          issueNumbers: [options.issueNumber],
          activity: 1,
          firstStderrLine: null,
          ...(options.summaryVersion === undefined
            ? {}
            : { harnessVersion: options.summaryVersion }),
        },
      ],
      agents: [agent],
      updatedAt: options.lastPollAt,
    };
    if (options.pauseSource === undefined) delete state.pauseSource;
    else state.pauseSource = options.pauseSource;
    return state;
  }

  test("a draining older worker is the family's running work, not its pause", async () => {
    const root = await temporaryDirectory("issues-family-repo");
    const stateDir = join(root, "state");
    const oldWorker = await liveProcess();
    const newWorker = await liveProcess();
    const subject = bridge(root, stateDir);
    try {
      const oldRun = "2026-10-27T10-00-01-000Z";
      const newRun = "2026-10-27T10-00-02-000Z";
      // The older document predates the pause source and the run summary's
      // version: only the run record and the dashboard's marker can tell this
      // pause was a takeover.
      writeState(
        versionedStatePath(stateDir, root, OLD),
        ownerState({
          root,
          stateDir,
          version: OLD,
          pid: oldWorker.pid,
          startedAt: oldWorker.startedAt,
          lifecycle: "pausing",
          paused: true,
          runId: oldRun,
          issueNumber: 17,
          lastPollAt: "2026-10-27T09:59:00.000Z",
        }),
      );
      writeState(
        versionedStatePath(stateDir, root, NEW),
        ownerState({
          root,
          stateDir,
          version: NEW,
          pid: newWorker.pid,
          startedAt: newWorker.startedAt,
          lifecycle: "running",
          paused: false,
          pauseSource: null,
          runId: newRun,
          issueNumber: 18,
          lastPollAt: "2026-10-27T10:00:30.000Z",
          summaryVersion: NEW,
        }),
      );
      await writeRunRecord(stateDir, root, oldRun, 17, OLD, oldWorker.pid, "running");
      await writeRunRecord(stateDir, root, newRun, 18, NEW, newWorker.pid, "running");
      writeDrainMarker(drainMarkerPath(stateDir, root, OLD), {
        version: OLD,
        pid: oldWorker.pid,
        by: NEW,
        at: "2026-10-27T10:00:20.000Z",
      });
      await writeLiveLock(
        versionLockPath(lockPath(root), OLD),
        { pid: oldWorker.pid, startedAt: oldWorker.startedAt, harnessVersion: OLD, stateDir },
        root,
      );
      await writeLiveLock(
        versionLockPath(lockPath(root), NEW),
        { pid: newWorker.pid, startedAt: newWorker.startedAt, harnessVersion: NEW, stateDir },
        root,
      );

      const takeover = subject.snapshot();
      expect(takeover.attached).toBe(true);
      expect(takeover.lifecycle).toBe("running");
      expect(takeover.paused).toBe(false);
      expect(
        takeover.workers.map((worker) => worker.version).sort(),
      ).toEqual([OLD, NEW]);
      expect(takeover.poll?.lastPollAt).toBe("2026-10-27T10:00:30.000Z");
      expect(
        takeover.agents.map((agent) => [agent.issueNumber, agent.harnessVersion]),
      ).toEqual([
        [17, OLD],
        [18, NEW],
      ]);
      expect(takeover.runs.find((run) => run.runId === oldRun)?.harnessVersion).toBe(OLD);
      expect(takeover.runs.find((run) => run.runId === oldRun)?.status).toBe("running");
      expect(takeover.queue.map((issue) => issue.number)).toEqual([17, 18]);

      // The older worker retires: its tasks and runs stay readable with their
      // version, the live list drops it, and only the newer version runs.
      await rm(versionLockPath(lockPath(root), OLD), { force: true });
      const retired = subject.snapshot();
      expect(retired.workers.map((worker) => worker.version)).toEqual([NEW]);
      expect(retired.agents.map((agent) => agent.issueNumber)).toEqual([18]);
      expect(retired.runs.find((run) => run.runId === oldRun)?.harnessVersion).toBe(OLD);
    } finally {
      subject.dispose();
      oldWorker.stop();
      newWorker.stop();
      await rm(lockPath(root), { recursive: true, force: true });
    }
  }, 20_000);

  test("a stopped version's queue never reappears as pending", async () => {
    const root = await temporaryDirectory("issues-family-stopped-queue-repo");
    const stateDir = join(root, "state");
    const worker = await liveProcess();
    const subject = new IssuesBridge({
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: NEW,
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
      now: readClock("2026-10-27T10:00:00.000Z", "2026-10-27T10:00:10.000Z"),
      syncRead: async () => ({ kind: "issues", issues: [issue(20)], etag: null }),
    });
    try {
      writeState(
        versionedStatePath(stateDir, root, NEW),
        ownerState({
          root,
          stateDir,
          version: NEW,
          pid: worker.pid,
          startedAt: worker.startedAt,
          lifecycle: "running",
          paused: false,
          runId: "2026-10-27T10-00-00-000Z",
          issueNumber: 20,
          lastPollAt: "2026-10-27T10:00:05.000Z",
        }),
      );
      // A retired version keeps the open list of its last read on disk. Those
      // rows are history: only a live worker's queue may publish them.
      writeState(versionedStatePath(stateDir, root, OLD), {
        ...emptyState({ repo: "acme/fixture", root }),
        lifecycle: "stopped",
        enabled: false,
        worker: {
          pid: 999_999,
          startedAt: "2026-10-27T09:00:00.000Z",
          stateDir,
          harnessVersion: OLD,
          argv: [],
        },
        queue: [
          { ...issue(9), handled: false, runId: null, agentRunId: null },
          { ...issue(20), handled: false, runId: null, agentRunId: null },
        ],
      });
      await writeLiveLock(
        versionLockPath(lockPath(root), NEW),
        { pid: worker.pid, startedAt: worker.startedAt, harnessVersion: NEW, stateDir },
        root,
      );

      await subject.syncNow();
      const snapshot = subject.snapshot();
      expect(snapshot.attached).toBe(true);
      expect(snapshot.queue.map((entry) => entry.number)).toEqual([20]);
    } finally {
      subject.dispose();
      worker.stop();
      await rm(lockPath(root), { recursive: true, force: true });
    }
  }, 20_000);

  test("an operator's Pause still reads as pausing", async () => {
    const root = await temporaryDirectory("issues-family-pause-repo");
    const stateDir = join(root, "state");
    const worker = await liveProcess();
    const subject = bridge(root, stateDir);
    try {
      const runId = "2026-10-27T10-00-03-000Z";
      writeState(
        versionedStatePath(stateDir, root, NEW),
        ownerState({
          root,
          stateDir,
          version: NEW,
          pid: worker.pid,
          startedAt: worker.startedAt,
          lifecycle: "pausing",
          paused: true,
          pauseSource: "operator",
          runId,
          issueNumber: 19,
          lastPollAt: "2026-10-27T10:00:00.000Z",
        }),
      );
      await writeRunRecord(stateDir, root, runId, 19, NEW, worker.pid, "running");
      await writeLiveLock(
        versionLockPath(lockPath(root), NEW),
        { pid: worker.pid, startedAt: worker.startedAt, harnessVersion: NEW, stateDir },
        root,
      );
      const paused = subject.snapshot();
      expect(paused.lifecycle).toBe("pausing");
      expect(paused.paused).toBe(true);
      expect(paused.agents.map((agent) => agent.harnessVersion)).toEqual([NEW]);
    } finally {
      subject.dispose();
      worker.stop();
      await rm(lockPath(root), { recursive: true, force: true });
    }
  }, 20_000);
});

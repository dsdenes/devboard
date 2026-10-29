import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IssuesBridge } from "./issues";
import { acquireLock } from "../issues/lock";
import { controlDirectory, lockPath, statePath } from "../issues/paths";
import { emptyState, writeState } from "../issues/state";
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
      ).toEqual({ ok: false, message: "No issues worker is running for this checkout." });
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

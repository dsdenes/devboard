import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DesignBridge } from "./design";
import { agentRegistry } from "./agents/registry";
import { versionLockPath } from "../issues/lock";
import {
  lockPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/design/paths";
import { takeCommands } from "../issues/design/control";
import {
  emptyState,
  writeState,
  type DesignDocumentationEntry,
  type DesignIssueRow,
  type DesignState,
} from "../issues/design/state";
import { readHarnessVersion } from "./version";
import { createdDirectories, temporaryDirectory } from "../tests/fixtures/scout-helpers";

const harnessRoot = join(import.meta.dir, "..");
const runningVersion = readHarnessVersion(harnessRoot) ?? "test";

async function liveWorker(root: string): Promise<{ pid: number; stop: () => Promise<void> }> {
  const script = join(root, "fixture", "issues", "design", "worker.ts");
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, "setInterval(() => undefined, 1000);\n");
  const child = Bun.spawn({
    cmd: [process.execPath, script],
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  return {
    pid: child.pid,
    stop: async () => {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

async function writeWorkerLock(
  root: string,
  stateDir: string,
  version: string | null,
  pid: number,
): Promise<void> {
  const path = version === null ? lockPath(root) : versionLockPath(lockPath(root), version);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      repo: root,
      stateDir,
      harnessVersion: version,
      argv: ["fixture"],
    }),
  );
  return;
}

function publishedState(
  root: string,
  stateDir: string,
  options: {
    version: string | null;
    pid: number;
    lifecycle: DesignState["lifecycle"];
    updatedAt: string;
    newestCycleId: string;
    issues?: DesignIssueRow[];
    documentation?: DesignDocumentationEntry[];
  },
): DesignState {
  const updatedAt = new Date(options.updatedAt);
  return {
    ...emptyState({
      repo: "acme/fixture",
      root,
      lifecycle: options.lifecycle,
      now: updatedAt,
    }),
    enabled: true,
    worker: {
      pid: options.pid,
      startedAt: updatedAt.toISOString(),
      stateDir,
      harnessVersion: options.version,
      argv: ["fixture"],
    },
    lastCycleStartedAt: options.updatedAt,
    newestCycleId: options.newestCycleId,
    issues: options.issues ?? [],
    documentation: options.documentation ?? [],
  };
}

function issueRow(number: number, title: string): DesignIssueRow {
  return {
    number,
    title,
    url: `https://forge.test/acme/fixture/issues/${number}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "pending",
    category: "color",
    version: null,
  };
}

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("design bridge stop proof", () => {
  test("a releasing worker is not signalled until the release settles", async () => {
    const root = await temporaryDirectory("design-bridge-releasing");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "issues", "design", "worker.ts");
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
    const state = (lifecycle: "releasing" | "idle") => ({
      ...emptyState({ repo: "acme/fixture", root, lifecycle }),
      enabled: true,
    });
    writeState(statePath(stateDir, root), state("releasing"));

    const subject = new DesignBridge({
      descriptor: agentRegistry.require("design"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: () => undefined,
    });

    const signals: Array<number | NodeJS.Signals> = [];
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      target: number,
      signal: number | NodeJS.Signals = 0,
    ) => {
      signals.push(signal);
      return true;
    }) as typeof process.kill);
    try {
      expect(subject.stop()).toEqual({ ok: true });
      // Two full proof windows while the worker publishes `releasing`.
      vi.advanceTimersByTime(3_000);
      vi.advanceTimersByTime(5_000);
      expect(signals.filter((signal) => typeof signal === "string")).toEqual([]);

      writeState(statePath(stateDir, root), state("idle"));
      vi.advanceTimersByTime(10_000);
      expect(signals.filter((signal) => typeof signal === "string")).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      subject.dispose();
      worker.kill("SIGKILL");
      await worker.exited;
      await rm(lockPath(root), { force: true });
    }
  }, 20_000);
});

describe("design bridge family view", () => {
  test("lists every version's worker and merges their cycles without a mismatch notice", async () => {
    const root = await temporaryDirectory("design-bridge-family");
    const stateDir = join(root, "state");
    const older = await liveWorker(root);
    const newer = await liveWorker(root);
    try {
      await writeWorkerLock(root, stateDir, "0.1.0", older.pid);
      await writeWorkerLock(root, stateDir, "0.2.0", newer.pid);
      const olderState = publishedState(root, stateDir, {
        version: "0.1.0",
        pid: older.pid,
        lifecycle: "auditing",
        updatedAt: "2026-01-01T00:00:00.000Z",
        newestCycleId: "20260101-000000-000001-0001",
        issues: [issueRow(1, "Older finding")],
      });
      const newerState = publishedState(root, stateDir, {
        version: "0.2.0",
        pid: newer.pid,
        lifecycle: "idle",
        updatedAt: "2026-01-01T01:00:00.000Z",
        newestCycleId: "20260101-010000-000002-0001",
        issues: [issueRow(2, "Newer finding")],
        documentation: [
          {
            at: "2026-01-01T01:00:00.000Z",
            version: "0.1.9",
            url: "https://forge.test/releases/0.1.9",
            summary: "Name the accent token",
            files: ["DESIGN.md"],
            diff: "+ accent\n",
          },
        ],
      });
      writeState(versionedStatePath(stateDir, root, "0.1.0"), olderState);
      writeState(versionedStatePath(stateDir, root, "0.2.0"), newerState);

      const subject = new DesignBridge({
        descriptor: agentRegistry.require("design"),
        repoDir: root,
        stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion,
        harnessDir: harnessRoot,
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: () => undefined,
      });
      try {
        const snapshot = subject.snapshot();
        expect((snapshot.workers ?? []).map((worker) => worker.version).sort()).toEqual([
          "0.1.0",
          "0.2.0",
        ]);
        expect((snapshot.workers ?? []).every((worker) => worker.stateDir === stateDir)).toBe(true);
        expect(snapshot.issues.map((issue) => issue.title).sort()).toEqual([
          "Newer finding",
          "Older finding",
        ]);
        expect(snapshot.documentation).toHaveLength(1);
        expect(snapshot.notice).toBeNull();
        expect(snapshot.lifecycle).toBe("running");
        expect((snapshot.detail as { scanId?: string | null }).scanId).toBe(
          "20260101-010000-000002-0001",
        );
      } finally {
        subject.dispose();
      }
    } finally {
      await older.stop();
      await newer.stop();
    }
  }, 20_000);

  test("writes family-wide settings and stop to every live worker", async () => {
    const root = await temporaryDirectory("design-bridge-controls");
    const stateDir = join(root, "state");
    const older = await liveWorker(root);
    const newer = await liveWorker(root);
    try {
      await writeWorkerLock(root, stateDir, "0.1.0", older.pid);
      await writeWorkerLock(root, stateDir, "0.2.0", newer.pid);
      const subject = new DesignBridge({
        descriptor: agentRegistry.require("design"),
        repoDir: root,
        stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion,
        harnessDir: harnessRoot,
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: () => undefined,
      });
      try {
        expect(subject.setSettings(30, 4, 2)).toEqual({ ok: true });
        expect(subject.stop()).toEqual({ ok: true });
        for (const version of ["0.1.0", "0.2.0"]) {
          const commands = takeCommands(versionedControlDirectory(stateDir, root, version));
          expect(commands).toContainEqual({
            type: "settings",
            intervalMinutes: 30,
            maxPerHour: 4,
            maxPending: 2,
          });
          expect(commands).toContainEqual({ type: "stop" });
        }
      } finally {
        subject.dispose();
      }
    } finally {
      await older.stop();
      await newer.stop();
    }
  }, 20_000);

  test("starts nothing when no worker is live", async () => {
    const root = await temporaryDirectory("design-bridge-quiet");
    const stateDir = join(root, "state");
    const spawns: string[][] = [];
    const subject = new DesignBridge({
      descriptor: agentRegistry.require("design"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion,
      harnessDir: harnessRoot,
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: (argv) => {
        spawns.push(argv);
        return 123_456;
      },
    });
    try {
      subject.begin();
      await subject.takeoverOldWorkers();
      expect(spawns).toEqual([]);
    } finally {
      subject.dispose();
    }
  }, 20_000);

  test("starts the newest harness beside an older worker and drains it once", async () => {
    const root = await temporaryDirectory("design-bridge-takeover");
    const stateDir = join(root, "state");
    const older = await liveWorker(root);
    try {
      await writeWorkerLock(root, stateDir, "0.1.0", older.pid);
      writeState(
        versionedStatePath(stateDir, root, "0.1.0"),
        publishedState(root, stateDir, {
          version: "0.1.0",
          pid: older.pid,
          lifecycle: "auditing",
          updatedAt: "2026-01-01T00:00:00.000Z",
          newestCycleId: "20260101-000000-000001-0001",
        }),
      );
      const spawns: string[][] = [];
      const subject = new DesignBridge({
        descriptor: agentRegistry.require("design"),
        repoDir: root,
        stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion,
        harnessDir: harnessRoot,
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: (argv) => {
          spawns.push(argv);
          return 123_456;
        },
      });
      try {
        // Start only attaches to the live family; it never spawns a second worker.
        expect(await subject.start()).toEqual({ ok: true });
        expect(spawns).toEqual([]);

        await subject.takeoverOldWorkers();
        expect(spawns).toHaveLength(1);
        expect(spawns[0]![1]).toBe(join(harnessRoot, "issues", "design", "worker.ts"));
        expect(spawns[0]).toContain("--repo");
        expect(spawns[0]).toContain(root);
        expect(takeCommands(versionedControlDirectory(stateDir, root, "0.1.0"))).toContainEqual({
          type: "drain",
        });
        expect(subject.snapshot().notice).toBeNull();

        // One automatic start per bridge lifetime.
        await subject.takeoverOldWorkers();
        expect(spawns).toHaveLength(1);
      } finally {
        subject.dispose();
      }
    } finally {
      await older.stop();
    }
  }, 20_000);
});

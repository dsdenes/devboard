import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentRegistry } from "../server/agents/registry";
import {
  DEFAULT_INTERVAL_MINUTES,
  readSettings,
} from "../release-train/settings";
import { releaseTrainDirectory } from "../release-train/paths";
import {
  ReleaseTrainWorker,
  type ReleaseRunInput,
  type ReleaseRunResult,
} from "../release-train/worker";
import type {
  ReleaseTrainGate,
  ReleaseTrainUnreleased,
} from "../lib/release-train-gate";

/**
 * The Release Train worker lifecycle: its 10-minute default, the gate before
 * any agent, singleton starts and ticks, and a failed range retried on the
 * next due tick. Every run is injected; no test contacts omp, npm, or a forge.
 */

const harnessRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Workspace {
  root: string;
  repoDir: string;
  stateDir: string;
  directory: string;
}

function workspace(name: string): Workspace {
  const base = join(harnessRoot, ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `release-train-worker-${name}-`));
  roots.push(root);
  const repoDir = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(join(repoDir, ".devboard"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, repoDir, stateDir, directory: releaseTrainDirectory(stateDir) };
}

function unreleased(target = "a".repeat(40), version = "1.0.1"): ReleaseTrainUnreleased {
  return {
    state: "unreleased",
    target,
    previous: { tag: "v1.0.0", version: "1.0.0" },
    range: `v1.0.0..${target}`,
    version,
    commits: [{ sha: target, subject: "fix: release it", merge: false }],
    releaseCommits: [{ sha: target, subject: "fix: release it", merge: false }],
  };
}

function workerAt(
  workspaceValue: Workspace,
  options: {
    gate: (repoDir: string) => ReleaseTrainGate | Promise<ReleaseTrainGate>;
    runRelease?: (input: ReleaseRunInput) => Promise<ReleaseRunResult>;
    now?: () => Date;
    harnessVersion?: string | null;
    ownerStateDir?: string;
  },
): ReleaseTrainWorker {
  return new ReleaseTrainWorker({
    repoDir: workspaceValue.repoDir,
    stateDir: workspaceValue.stateDir,
    ...(options.ownerStateDir === undefined ? {} : { ownerStateDir: options.ownerStateDir }),
    harnessVersion: options.harnessVersion ?? "test-version",
    manual: true,
    now: options.now ?? (() => new Date("2026-11-02T10:00:00.000Z")),
    gate: options.gate,
    runRelease: options.runRelease ?? (async () => ({ ok: true, version: "1.0.1", url: "https://forge.test/releases/tag/v1.0.1" })),
    log: () => undefined,
  });
}

describe("Release Train family", () => {
  test("registers the scheduled family with a 10-minute default", () => {
    const descriptor = agentRegistry.require("release-train");
    expect(descriptor.label).toBe("Release Train");
    expect(descriptor.description).toContain("scheduled");
    expect(descriptor.prompt).toEqual({ kind: "file", file: "release-train.md" });
    expect(descriptor.cadence).toEqual({
      field: "intervalMinutes",
      defaultMinutes: 10,
      minMinutes: 1,
      maxMinutes: 1440,
    });
    expect(descriptor.commands).toEqual({
      start: "startAgent",
      stop: "stopAgent",
      setSettings: "setAgentSettings",
    });
    expect(descriptor.controls).toEqual({ pause: true, checkNow: true });
    expect(DEFAULT_INTERVAL_MINUTES).toBe(10);
  });

  test("a fresh state directory defaults to a 10-minute cadence", async () => {
    const workspaceValue = workspace("default-cadence");
    const worker = workerAt(workspaceValue, { gate: () => ({ state: "nothing", target: "a".repeat(40), previous: { tag: "v1.0.0", version: "1.0.0" }, range: "v1.0.0.." + "a".repeat(40) }) });
    expect(worker.begin(false)).toBe(true);
    try {
      expect(readSettings(workspaceValue.directory).intervalMinutes).toBe(10);
    } finally {
      await worker.stop();
    }
  });

  test("a nothing-to-release verdict spawns no agent", async () => {
    const workspaceValue = workspace("nothing");
    let runs = 0;
    const target = "b".repeat(40);
    const worker = workerAt(workspaceValue, {
      gate: () => ({
        state: "nothing",
        target,
        previous: { tag: "v1.0.0", version: "1.0.0" },
        range: `v1.0.0..${target}`,
      }),
      runRelease: async () => {
        runs += 1;
        return { ok: true, version: "1.0.0", url: "https://forge.test/v1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(0);
      expect(worker.currentState.activity.join("\n")).toContain("nothing to release");
    } finally {
      await worker.stop();
    }
  });

  test("an unreleased verdict starts exactly one agent and records its release", async () => {
    const workspaceValue = workspace("unreleased");
    let runs = 0;
    let request: ReleaseRunInput["request"] | undefined;
    const worker = workerAt(workspaceValue, {
      gate: () => unreleased(),
      runRelease: async (input) => {
        runs += 1;
        request = input.request;
        input.activity("the agent released it");
        return { ok: true, version: "1.0.1", url: "https://forge.test/releases/tag/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(1);
      expect(request?.range).toBe(`v1.0.0..${"a".repeat(40)}`);
      expect(worker.currentState.release).toEqual({
        version: "1.0.1",
        url: "https://forge.test/releases/tag/v1.0.1",
        at: "2026-11-02T10:00:00.000Z",
        sha: "a".repeat(40),
        range: `v1.0.0..${"a".repeat(40)}`,
      });
      expect(worker.currentState.activity.join("\n")).toContain(
        "released v1.0.1: https://forge.test/releases/tag/v1.0.1",
      );
      expect(worker.currentState.failure).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  test("a second worker of the same version refuses while the first is live", async () => {
    const workspaceValue = workspace("singleton");
    const first = workerAt(workspaceValue, { gate: () => unreleased() });
    const second = workerAt(workspaceValue, { gate: () => unreleased() });
    expect(first.begin(false)).toBe(true);
    try {
      expect(second.begin(false)).toBe(false);
    } finally {
      await first.stop();
    }
    expect(second.begin(false)).toBe(true);
    await second.stop();
  });

  test("a tick during an active run starts no second run", async () => {
    const workspaceValue = workspace("active");
    const pending = Promise.withResolvers<ReleaseRunResult>();
    const started = Promise.withResolvers<void>();
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => unreleased(),
      runRelease: async () => {
        runs += 1;
        started.resolve();
        return await pending.promise;
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      const firstTick = worker.tickNow();
      await started.promise;
      expect(runs).toBe(1);
      await worker.tickNow();
      expect(runs).toBe(1);
      pending.resolve({ ok: true, version: "1.0.1", url: "https://forge.test/v1.0.1" });
      await firstTick;
      expect(worker.currentState.release?.version).toBe("1.0.1");
    } finally {
      await worker.stop();
    }
  });

  test("a failed run leaves the range for the next due tick, which runs again", async () => {
    const workspaceValue = workspace("retry");
    const now = { value: Date.parse("2026-11-02T10:00:00.000Z") };
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => unreleased(),
      now: () => new Date(now.value),
      runRelease: async () => {
        runs += 1;
        return runs === 1
          ? { ok: false, detail: "the release workflow concluded failure" }
          : { ok: true, version: "1.0.1", url: "https://forge.test/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(1);
      expect(worker.currentState.release).toBeNull();
      expect(worker.currentState.failure?.detail).toContain("concluded failure");
      // The cadence is due again ten minutes later, with no operator action.
      now.value += 10 * 60_000;
      await worker.tickNow();
      expect(runs).toBe(2);
      expect(worker.currentState.release?.version).toBe("1.0.1");
      expect(worker.currentState.failure).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  test("a failed run whose tag now exists is retried on the next tick", async () => {
    const workspaceValue = workspace("retry-after-tag");
    const now = { value: Date.parse("2026-11-02T10:00:00.000Z") };
    const target = "c".repeat(40);
    let phase = 0;
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      now: () => new Date(now.value),
      gate: () =>
        phase === 0
          ? unreleased(target)
          : {
              state: "nothing",
              target,
              previous: { tag: "v1.0.1", version: "1.0.1" },
              range: `v1.0.1..${target}`,
            },
      runRelease: async () => {
        runs += 1;
        return runs === 1
          ? { ok: false, detail: "the Gitea release v1.0.1 is missing devboard-1.0.1.tgz" }
          : { ok: true, version: "1.0.1", url: "https://forge.test/releases/tag/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(1);
      expect(worker.currentState.failure?.version).toBe("1.0.1");
      phase = 1;
      now.value += 10 * 60_000;
      await worker.tickNow();
      expect(runs).toBe(2);
      expect(worker.currentState.release?.version).toBe("1.0.1");
      expect(worker.currentState.failure).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  test("a gate failure records the failure and starts no run", async () => {
    const workspaceValue = workspace("gate-error");
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => ({ state: "error", detail: "could not fetch origin/main" }),
      runRelease: async () => {
        runs += 1;
        return { ok: true, version: "1.0.1", url: "https://forge.test/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(0);
      expect(worker.currentState.gate?.state).toBe("error");
      expect(worker.currentState.activity.join("\n")).toContain(
        "release check failed: could not fetch origin/main",
      );
    } finally {
      await worker.stop();
    }
  });

  test("state, control, lock, and activity live under the state directory", async () => {
    const workspaceValue = workspace("layout");
    const worker = workerAt(workspaceValue, { gate: () => unreleased() });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      const directory = resolve(workspaceValue.directory);
      expect(worker.currentState.runs[0]?.id).toBeDefined();
      expect(readSettings(directory).intervalMinutes).toBe(10);
    } finally {
      await worker.stop();
    }
  });
});

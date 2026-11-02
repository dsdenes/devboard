import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock } from "../issues/lock";
import { agentRegistry } from "../server/agents/registry";
import { ReleaseTrainActivity } from "../server/release-train";
import {
  DEFAULT_INTERVAL_MINUTES,
  readSettings,
} from "../release-train/settings";
import {
  releaseTrainDirectory,
  runDirectory,
  runsDirectory,
  versionedControlDirectory,
  versionedLockPath,
} from "../release-train/paths";
import {
  emptyState,
  readState,
  writeState,
  type ReleaseTrainRun,
} from "../release-train/state";
import {
  NPM_VISIBILITY_WINDOW_MS,
  ReleaseTrainWorker,
  readResult,
  verifyShipped,
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

function gitIn(repoDir: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.name=Train Test",
      "-c",
      "user.email=train@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A repository with one tagged commit, the shape a released run leaves. */
function releasedRepository(name: string, tag = "v1.0.1"): { repoDir: string; head: string } {
  const repoDir = join(workspace(name).root, "repo");
  mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, ["init", "-q"]);
  gitIn(repoDir, ["commit", "--allow-empty", "-q", "-m", "fix: the release"]);
  const head = gitIn(repoDir, ["rev-parse", "HEAD"]);
  gitIn(repoDir, ["tag", tag, head]);
  return { repoDir, head };
}

/** Two commits with `v1.0.1` naming either the first or the tip. */
function taggedRepository(
  repoDir: string,
  tagAtTip: boolean,
): { first: string; tip: string } {
  gitIn(repoDir, ["init", "-q"]);
  gitIn(repoDir, ["commit", "--allow-empty", "-q", "-m", "fix: the release"]);
  const first = gitIn(repoDir, ["rev-parse", "HEAD"]);
  gitIn(repoDir, ["commit", "--allow-empty", "-q", "-m", "fix: the next change"]);
  const tip = gitIn(repoDir, ["rev-parse", "HEAD"]);
  gitIn(repoDir, ["tag", "v1.0.1", tagAtTip ? tip : first]);
  return { first, tip };
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
    verify?: typeof verifyShipped;
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
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    log: () => undefined,
  });
}

describe("release verification", () => {
  test("retries the npm read inside the propagation window and records the release", async () => {
    const { repoDir, head } = releasedRepository("verify-retry");
    const reads: string[] = [];
    const replies = [
      { code: 1, stdout: "", stderr: "npm error code E404" },
      { code: 1, stdout: "", stderr: "npm error code E404" },
      { code: 0, stdout: "1.0.1", stderr: "" },
    ];
    const activity: string[] = [];
    const verified = await verifyShipped({
      repoDir,
      target: head,
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: (line) => activity.push(line),
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => {
        const reply = replies[Math.min(reads.length, replies.length - 1)]!;
        reads.push(reply.stderr);
        return reply;
      },
      readRelease: async (tag) => ({
        release: {
          id: 1,
          tag_name: tag,
          assets: [
            { name: "devboard-1.0.1.tgz" },
            { name: "devboard-1.0.1.tgz.sha256" },
          ],
        },
        url: `https://forge.test/releases/tag/${tag}`,
      }),
      sleep: async () => undefined,
    });
    expect(verified).toEqual({
      ok: true,
      version: "1.0.1",
      url: "https://forge.test/releases/tag/v1.0.1",
    });
    expect(reads).toHaveLength(3);
    expect(activity.filter((line) => line.includes("waiting for"))).toHaveLength(2);
    expect(activity).toContain("verified @dsdenes/devboard@1.0.1 and the Gitea assets");
    expect(NPM_VISIBILITY_WINDOW_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  test("fails at the bound with the npm phase named when the version never appears", async () => {
    const { repoDir, head } = releasedRepository("verify-npm-bound");
    let reads = 0;
    const verified = await verifyShipped({
      repoDir,
      target: head,
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: () => undefined,
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => {
        reads += 1;
        return { code: 1, stdout: "", stderr: "npm error code E404" };
      },
      readRelease: async () => {
        throw new Error("the Gitea phase must not run");
      },
      sleep: async () => undefined,
      npmWindowMs: 40,
      npmPollMs: 5,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("unreachable");
    expect(verified.phase).toBe("npm");
    expect(verified.version).toBe("1.0.1");
    expect(verified.detail).toStartWith("npm visibility:");
    expect(verified.detail).toContain("@dsdenes/devboard@1.0.1");
    expect(verified.detail).toContain("is not visible on npmjs");
    expect(verified.detail).toContain("npm error code E404");
    expect(verified.detail).not.toContain("Gitea");
    expect(reads).toBeGreaterThan(1);
  });

  test("names the tag phase when no tag carries the released commit", async () => {
    const { repoDir, head } = releasedRepository("verify-tag");
    let reads = 0;
    const verified = await verifyShipped({
      repoDir,
      target: head,
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: () => undefined,
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => {
        reads += 1;
        return { code: 0, stdout: "1.0.1", stderr: "" };
      },
      readRelease: async (tag) => ({
        release: {
          id: 1,
          tag_name: tag,
          assets: [
            { name: "devboard-1.0.1.tgz" },
            { name: "devboard-1.0.1.tgz.sha256" },
          ],
        },
        url: `https://forge.test/releases/tag/${tag}`,
      }),
    });
    // v1.0.1 names the commit, so the tag phase accepts it and moves on.
    expect(verified.ok).toBe(true);
    expect(reads).toBe(1);

    const untagged = await verifyShipped({
      repoDir,
      target: "b".repeat(40),
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: () => undefined,
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => {
        throw new Error("the npm phase must not run");
      },
    });
    expect(untagged.ok).toBe(false);
    if (untagged.ok) throw new Error("unreachable");
    expect(untagged.phase).toBe("tag");
    expect(untagged.detail).toStartWith("tag binding:");
    expect(untagged.detail).toContain("for v1.0.1");
    expect(untagged.detail).toContain("b".repeat(7));
    expect(untagged.detail).not.toContain("npmjs");
  });

  test("names the Gitea assets phase with the missing asset and the version", async () => {
    const { repoDir, head } = releasedRepository("verify-assets");
    const verified = await verifyShipped({
      repoDir,
      target: head,
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: () => undefined,
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => ({ code: 0, stdout: "1.0.1", stderr: "" }),
      readRelease: async (tag) => ({
        release: { id: 1, tag_name: tag, assets: [{ name: "devboard-1.0.1.tgz" }] },
        url: `https://forge.test/releases/tag/${tag}`,
      }),
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("unreachable");
    expect(verified.phase).toBe("gitea");
    expect(verified.version).toBe("1.0.1");
    expect(verified.detail).toStartWith("Gitea release assets:");
    expect(verified.detail).toContain("v1.0.1 is missing devboard-1.0.1.tgz.sha256");
    expect(verified.detail).not.toContain("npmjs");

    const absent = await verifyShipped({
      repoDir,
      target: head,
      version: "1.0.1",
      environment: {},
      stateDir: join(repoDir, ".tmp"),
      activity: () => undefined,
      refresh: () => ({ code: 0, stdout: "", stderr: "" }),
      npmView: () => ({ code: 0, stdout: "1.0.1", stderr: "" }),
      readRelease: async () => ({ release: undefined, url: "" }),
    });
    expect(absent.ok).toBe(false);
    if (absent.ok) throw new Error("unreachable");
    expect(absent.detail).toBe("Gitea release assets: the release v1.0.1 does not exist");
  });
});

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
      expect(worker.currentState.runs[0]?.commits).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  test("the agent's result document is read from the run directory", () => {
    const workspaceValue = workspace("result");
    const runDir = runDirectory(workspaceValue.directory, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({ ok: false, detail: "the release workflow concluded failure" }),
    );
    expect(readResult(runDir)).toEqual({
      ok: false,
      detail: "the release workflow concluded failure",
    });
    expect(readResult(runDirectory(workspaceValue.directory, "absent"))).toBeUndefined();
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
    const start = Date.parse("2026-11-02T10:00:00.000Z");
    const now = { value: start };
    let gateReads = 0;
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => {
        gateReads += 1;
        return unreleased();
      },
      now: () => new Date(now.value),
      runRelease: async () => {
        runs += 1;
        if (runs > 1) return { ok: true, version: "1.0.1", url: "https://forge.test/v1.0.1" };
        // A failing run that outlasts the cadence must still earn a full gap.
        now.value += 12 * 60_000;
        return { ok: false, detail: "the release workflow concluded failure" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(runs).toBe(1);
      expect(worker.currentState.release).toBeNull();
      expect(worker.currentState.failure?.detail).toContain("concluded failure");
      const endedAt = start + 12 * 60_000;
      expect(Date.parse(worker.currentWorker?.nextRunAt ?? "")).toBe(endedAt + 10 * 60_000);
      // Inside the interval after the end: not due, so no gate read and no agent.
      now.value = endedAt + 9 * 60_000;
      await worker.tickNow(false);
      expect(gateReads).toBe(1);
      expect(runs).toBe(1);
      // The cadence is due again a full interval after the end, with no operator action.
      now.value = endedAt + 10 * 60_000;
      await worker.tickNow(false);
      expect(gateReads).toBe(2);
      expect(runs).toBe(2);
      expect(worker.currentState.release?.version).toBe("1.0.1");
      expect(worker.currentState.failure).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  test("a thrown gate records the failure and holds the cadence", async () => {
    const workspaceValue = workspace("thrown-gate");
    const now = { value: Date.parse("2026-11-02T10:00:00.000Z") };
    let gates = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => {
        gates += 1;
        throw new Error("could not read the release state");
      },
      now: () => new Date(now.value),
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(gates).toBe(1);
      expect(worker.currentState.failure?.detail).toBe("could not read the release state");
      expect(worker.currentWorker?.lastError).toBe("could not read the release state");
      expect(worker.currentWorker?.lifecycle).toBe("failed");
      expect(worker.currentState.activity.join("\n")).toContain(
        "release train tick failed: could not read the release state",
      );
      const nextRunAt = Date.parse(worker.currentWorker?.nextRunAt ?? "");
      expect(nextRunAt - now.value).toBeGreaterThanOrEqual(10 * 60_000);
      // Inside the interval the gate is not read again; on the next due tick it is.
      now.value += 1_000;
      await worker.tickNow(false);
      expect(gates).toBe(1);
      now.value = nextRunAt;
      await worker.tickNow(false);
      expect(gates).toBe(2);
    } finally {
      await worker.stop();
    }
  });

  test("a run-directory write that throws closes the run and records its failure", async () => {
    const workspaceValue = workspace("thrown-run-dir");
    const now = { value: Date.parse("2026-11-02T10:00:00.000Z") };
    const target = "a".repeat(40);
    let gates = 0;
    let runs = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => {
        gates += 1;
        return unreleased(target);
      },
      now: () => new Date(now.value),
      runRelease: async () => {
        runs += 1;
        return { ok: true, version: "1.0.1", url: "https://forge.test/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      // A regular file where the runs directory belongs: the run directory
      // cannot be created, so the tick throws before it starts any agent.
      writeFileSync(runsDirectory(workspaceValue.directory), "");
      await worker.tickNow();
      expect(runs).toBe(0);
      const failure = worker.currentState.failure;
      expect(failure?.detail).toContain("not a directory");
      expect(failure?.sha).toBe(target);
      expect(failure?.range).toBe(`v1.0.0..${target}`);
      expect(failure?.version).toBe("1.0.1");
      expect(worker.currentWorker?.lastError).toBe(failure?.detail);
      expect(worker.currentWorker?.activeRun).toBeNull();
      expect(worker.currentState.runs[0]?.state).toBe("failed");
      expect(worker.currentState.runs[0]?.detail).toBe(failure?.detail);
      const nextRunAt = Date.parse(worker.currentWorker?.nextRunAt ?? "");
      expect(nextRunAt - now.value).toBeGreaterThanOrEqual(10 * 60_000);
      // The worker is not wedged: a tick inside the interval neither gates nor runs.
      now.value += 1_000;
      await worker.tickNow(false);
      expect(gates).toBe(1);
      expect(runs).toBe(0);
      // The range is retried on the next due tick once the write succeeds.
      rmSync(runsDirectory(workspaceValue.directory));
      now.value = nextRunAt;
      await worker.tickNow(false);
      expect(gates).toBe(2);
      expect(runs).toBe(1);
      expect(worker.currentState.failure).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  test("a stop after the agent published still records the release", async () => {
    const workspaceValue = workspace("stopped-published");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sawStopping = false;
    const worker = workerAt(workspaceValue, {
      gate: () => unreleased(),
      runRelease: async (input) => {
        started.resolve();
        await release.promise;
        sawStopping = input.stopping();
        return { ok: true, version: "1.0.1", url: "https://forge.test/releases/tag/v1.0.1" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    const tick = worker.tickNow();
    await started.promise;
    const stop = worker.stop();
    release.resolve();
    await tick;
    await stop;
    expect(sawStopping).toBe(true);
    expect(worker.currentState.release?.version).toBe("1.0.1");
    expect(worker.currentState.failure).toBeNull();
  });

  test("a recorded failure whose version tag now exists is verified, not re-released", async () => {
    for (const tagAtTip of [false, true]) {
      const workspaceValue = workspace(`repair-tag-${tagAtTip ? "tip" : "first"}`);
      const { first, tip } = taggedRepository(workspaceValue.repoDir, tagAtTip);
      const range = `v1.0.0..${first}`;
      writeState(workspaceValue.directory, {
        ...emptyState({ repo: "", root: workspaceValue.repoDir }),
        failure: {
          at: "2026-11-02T09:00:00.000Z",
          detail: "the release workflow concluded failure",
          sha: first,
          range,
          version: "1.0.1",
        },
      });
      const verifications: Array<{ target: string; version: string }> = [];
      let runs = 0;
      const worker = workerAt(workspaceValue, {
        gate: () => ({
          state: "nothing",
          target: tip,
          previous: { tag: "v1.0.1", version: "1.0.1" },
          range: `v1.0.1..${tip}`,
        }),
        runRelease: async () => {
          runs += 1;
          return { ok: true, version: "9.9.9", url: "https://forge.test/releases/tag/v9.9.9" };
        },
        verify: async (options) => {
          verifications.push({ target: options.target, version: options.version });
          return {
            ok: true,
            version: options.version,
            url: "https://forge.test/releases/tag/v1.0.1",
          };
        },
      });
      expect(worker.begin(false)).toBe(true);
      try {
        await worker.tickNow();
        expect(runs).toBe(0);
        expect(verifications).toEqual([{ target: first, version: "1.0.1" }]);
        expect(worker.currentState.release).toEqual({
          version: "1.0.1",
          url: "https://forge.test/releases/tag/v1.0.1",
          at: "2026-11-02T10:00:00.000Z",
          sha: first,
          range,
        });
        expect(worker.currentState.failure).toBeNull();
        expect(worker.currentState.runs[0]?.state).toBe("released");
      } finally {
        await worker.stop();
      }
    }
  });

  test("a failure whose own version tag is absent is never verified", async () => {
    const workspaceValue = workspace("repair-untagged");
    const { first, tip } = taggedRepository(workspaceValue.repoDir, false);
    writeState(workspaceValue.directory, {
      ...emptyState({ repo: "", root: workspaceValue.repoDir }),
      failure: {
        at: "2026-11-02T09:00:00.000Z",
        detail: "the release workflow concluded failure",
        sha: first,
        range: `v1.0.0..${first}`,
        version: "2.0.0",
      },
    });
    let verifications = 0;
    const worker = workerAt(workspaceValue, {
      gate: () => ({
        state: "nothing",
        target: tip,
        previous: { tag: "v1.0.1", version: "1.0.1" },
        range: `v1.0.1..${tip}`,
      }),
      verify: async (options) => {
        verifications += 1;
        return { ok: true, version: options.version, url: "https://forge.test/v2.0.0" };
      },
    });
    expect(worker.begin(false)).toBe(true);
    try {
      await worker.tickNow();
      expect(verifications).toBe(0);
      expect(worker.currentState.release).toBeNull();
      expect(worker.currentState.failure?.version).toBe("2.0.0");
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

  test("a takeover tick keeps the release the draining worker recorded", async () => {
    const workspaceValue = workspace("takeover-merge");
    const older = workerAt(workspaceValue, {
      harnessVersion: "0.0.9",
      now: () => new Date("2026-11-02T10:00:00.000Z"),
      gate: () => unreleased(),
      runRelease: async (input) => {
        input.activity("the older worker published the release");
        return { ok: true, version: "1.0.1", url: "https://forge.test/releases/tag/v1.0.1" };
      },
    });
    const newer = workerAt(workspaceValue, {
      harnessVersion: "0.1.0",
      now: () => new Date("2026-11-02T10:00:05.000Z"),
      gate: () => ({
        state: "nothing",
        target: "b".repeat(40),
        previous: { tag: "v1.0.1", version: "1.0.1" },
        range: `v1.0.1..${"b".repeat(40)}`,
      }),
    });
    // Both workers read the shared state before either writes it: this is the
    // takeover overlap, where the newer version starts while the older drains.
    expect(older.begin(false)).toBe(true);
    expect(newer.begin(false)).toBe(true);
    try {
      await older.tickNow();
      const released = older.currentState.runs[0];
      expect(released?.state).toBe("released");
      const releasedId = released?.id ?? "";
      expect(newer.currentState.runs).toHaveLength(0);

      await newer.tickNow();

      const reloaded = readState(workspaceValue.directory);
      expect(reloaded?.release?.version).toBe("1.0.1");
      const row = reloaded?.runs.find((entry) => entry.id === releasedId);
      expect(row?.state).toBe("released");
      expect(row?.url).toBe("https://forge.test/releases/tag/v1.0.1");
      const activity = reloaded?.activity.join("\n") ?? "";
      expect(activity).toContain("released v1.0.1: https://forge.test/releases/tag/v1.0.1");
      expect(activity).toContain("the older worker published the release");
      expect(activity).toContain("nothing to release");
    } finally {
      await older.stop();
      await newer.stop();
    }
  });
});

describe("Release Train page", () => {
  function run(patch: Partial<ReleaseTrainRun> & Pick<ReleaseTrainRun, "id">): ReleaseTrainRun {
    return {
      startedAt: "2026-11-02T09:00:00.000Z",
      endedAt: null,
      state: "running",
      range: "v1.0.0.." + "a".repeat(40),
      target: "a".repeat(40),
      version: null,
      url: null,
      detail: null,
      commits: null,
      ...patch,
    };
  }

  function activityAt(workspaceValue: Workspace): ReleaseTrainActivity {
    return new ReleaseTrainActivity({
      descriptor: agentRegistry.require("release-train"),
      repoDir: workspaceValue.repoDir,
      stateDir: workspaceValue.stateDir,
      harnessDir: harnessRoot,
    });
  }

  test("lists verified releases with their date, version, and commit count", () => {
    const workspaceValue = workspace("page-history");
    const legacy = run({
      id: "legacy",
      state: "released",
      version: "1.0.0",
      url: "https://forge.test/releases/tag/v1.0.0",
      endedAt: "2026-11-02T09:30:00.000Z",
    });
    // A release recorded before the shared state carried the count: its agent
    // request still holds the released list.
    const legacyRun = runDirectory(workspaceValue.directory, legacy.id);
    mkdirSync(legacyRun, { recursive: true });
    writeFileSync(
      join(legacyRun, "request.json"),
      JSON.stringify({ releaseCommits: [{ sha: "b" }, { sha: "c" }, { sha: "d" }] }),
    );
    writeState(workspaceValue.directory, {
      ...emptyState({ repo: "", root: workspaceValue.root }),
      runs: [
        run({
          id: "failed",
          state: "failed",
          version: "2.0.0",
          endedAt: "2026-11-02T11:00:00.000Z",
        }),
        run({
          id: "released",
          state: "released",
          version: "1.1.0",
          url: "https://forge.test/releases/tag/v1.1.0",
          endedAt: "2026-11-02T10:00:00.000Z",
          commits: 4,
        }),
        legacy,
      ],
    });
    expect(activityAt(workspaceValue).snapshot().releases).toEqual([
      {
        at: "2026-11-02T10:00:00.000Z",
        version: "1.1.0",
        commits: 4,
        url: "https://forge.test/releases/tag/v1.1.0",
      },
      {
        at: "2026-11-02T09:30:00.000Z",
        version: "1.0.0",
        commits: 3,
        url: "https://forge.test/releases/tag/v1.0.0",
      },
    ]);
  });

  test("a repository with no release yet lists an empty history", () => {
    const workspaceValue = workspace("page-empty");
    expect(activityAt(workspaceValue).snapshot().releases).toEqual([]);
  });
});

describe("Release Train takeover", () => {
  /**
   * Start refuses a repository that is not a checkout root, so the takeover
   * fixtures are real repositories rather than bare directories.
   */
  function checkout(name: string): Workspace {
    const workspaceValue = workspace(name);
    const result = Bun.spawnSync({
      cmd: ["git", "init", "-q"],
      cwd: workspaceValue.repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return workspaceValue;
  }

  /** The harness version a host would start next, read from its prefix. */
  function hostHarnessVersion(workspaceValue: Workspace, version: string): void {
    writeFileSync(
      join(workspaceValue.repoDir, ".devboard", "package.json"),
      JSON.stringify({ name: "@dsdenes/devboard", version }),
    );
  }

  /** A live worker of one harness version, as an older dashboard left it. */
  function liveOwner(workspaceValue: Workspace, version: string): { release: () => void } {
    const result = acquireLock(versionedLockPath(workspaceValue.directory, version), {
      repo: workspaceValue.repoDir,
      stateDir: workspaceValue.stateDir,
      harnessVersion: version,
      argv: [],
    });
    if (!result.acquired) throw new Error("the fixture worker lock was not acquired");
    return { release: result.release };
  }

  function commandsIn(directory: string): unknown[] {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [];
    }
    return names
      .sort()
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown);
  }

  interface TakeoverOptions {
    runningVersion: string;
    spawnWorker: (
      argv: string[],
      environment: Record<string, string | undefined>,
    ) => number | undefined;
  }

  function trainAt(workspaceValue: Workspace, options: TakeoverOptions): ReleaseTrainActivity {
    return new ReleaseTrainActivity({
      descriptor: agentRegistry.require("release-train"),
      repoDir: workspaceValue.repoDir,
      stateDir: workspaceValue.stateDir,
      harnessDir: harnessRoot,
      runningVersion: options.runningVersion,
      environment: {},
      log: () => undefined,
      spawnWorker: options.spawnWorker,
    });
  }

  test("Start takes over an older live worker and drains it", async () => {
    const workspaceValue = checkout("takeover-start");
    hostHarnessVersion(workspaceValue, "1.0.0");
    const older = liveOwner(workspaceValue, "0.0.9");
    const spawned: string[][] = [];
    const environments: Record<string, string | undefined>[] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv, environment) => {
        spawned.push(argv);
        environments.push(environment);
        return 4242;
      },
    });
    try {
      expect(await activity.start()).toEqual({ ok: true });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.join(" ")).toContain(join("release-train", "main.ts"));
      expect(spawned[0]!.join(" ")).toContain(`--state-dir ${workspaceValue.stateDir}`);
      expect(environments[0]?.DEVBOARD_HARNESS_VERSION).toBe("1.0.0");
      expect(commandsIn(versionedControlDirectory(workspaceValue.directory, "0.0.9"))).toEqual([
        { type: "drain" },
      ]);
    } finally {
      older.release();
    }
  });

  test("pressing Start twice spawns exactly one worker", async () => {
    const workspaceValue = checkout("takeover-twice");
    hostHarnessVersion(workspaceValue, "1.0.0");
    const older = liveOwner(workspaceValue, "0.0.9");
    const spawned: string[][] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      expect(await activity.start()).toEqual({ ok: true });
      expect(await activity.start()).toEqual({ ok: true });
      expect(spawned).toHaveLength(1);
      expect(commandsIn(versionedControlDirectory(workspaceValue.directory, "0.0.9"))).toEqual([
        { type: "drain" },
      ]);
    } finally {
      older.release();
    }
  });

  test("Start reports success without spawning when this version's worker is live", async () => {
    const workspaceValue = checkout("takeover-same-version");
    hostHarnessVersion(workspaceValue, "1.0.0");
    const live = liveOwner(workspaceValue, "1.0.0");
    const spawned: string[][] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      expect(await activity.start()).toEqual({ ok: true });
      expect(spawned).toHaveLength(0);
    } finally {
      live.release();
    }
  });

  test("Start never claims success when only an older version's worker is live and takeover is not allowed", async () => {
    const workspaceValue = checkout("takeover-refused");
    // The host prefix already holds a newer harness than this process.
    hostHarnessVersion(workspaceValue, "1.0.1");
    const older = liveOwner(workspaceValue, "0.0.9");
    const spawned: string[][] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      const result = await activity.start();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("0.0.9");
      expect(result.message).toContain("1.0.1");
      expect(spawned).toHaveLength(0);
      expect(commandsIn(versionedControlDirectory(workspaceValue.directory, "0.0.9"))).toEqual([]);
    } finally {
      older.release();
    }
  });

  test("begin takes over an older live worker without an operator", async () => {
    const workspaceValue = checkout("takeover-begin");
    hostHarnessVersion(workspaceValue, "1.0.0");
    const older = liveOwner(workspaceValue, "0.0.9");
    const spawned: string[][] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      activity.begin();
      await activity.settled();
      expect(spawned).toHaveLength(1);
      expect(commandsIn(versionedControlDirectory(workspaceValue.directory, "0.0.9"))).toEqual([
        { type: "drain" },
      ]);
    } finally {
      activity.dispose();
      older.release();
    }
  });

  test("begin starts nothing when no worker is live", async () => {
    const workspaceValue = checkout("takeover-begin-idle");
    hostHarnessVersion(workspaceValue, "1.0.0");
    const spawned: string[][] = [];
    const activity = trainAt(workspaceValue, {
      runningVersion: "1.0.0",
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      activity.begin();
      await activity.settled();
      expect(spawned).toHaveLength(0);
    } finally {
      activity.dispose();
    }
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentRegistry } from "../server/agents/registry";
import { readHarnessVersion } from "../server/version";
import { WatchdogActivity, preflightWatchdog } from "../server/watchdog";
import { writeWatchdogCommand } from "../watchdog/control";
import { loadLedger, saveLedger } from "../watchdog/ledger";
import {
  controlDirectory,
  versionedControlDirectory,
  versionedLockPath,
  versionedWorkerDirectory,
  watchdogDirectory,
  workerStatePath,
} from "../watchdog/paths";
import { writeWatchdogSettings } from "../watchdog/settings";
import { writeWorkerState } from "../watchdog/worker-state";

const harnessRoot = resolve(import.meta.dir, "..");
/** New workers publish under their own harness version, not the legacy path. */
const harnessVersion = readHarnessVersion(harnessRoot);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", "watchdog-runtime-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".devboard"), { recursive: true });
  Bun.spawnSync({ cmd: ["git", "init", "-q", root], stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync({
    cmd: ["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
    stdout: "ignore",
    stderr: "ignore",
  });
  return root;
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(50);
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Fingerprints a cycle report filed; discovery may also file unrelated evidence. */
function filedFingerprints(latest: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(latest?.issues)) return [];
  return latest.issues
    .filter(
      (issue): issue is Record<string, unknown> =>
        typeof issue === "object" && issue !== null,
    )
    .map((issue) => (typeof issue.fingerprint === "string" ? issue.fingerprint : ""));
}

function adapter(
  root: string,
  options: {
    systemctl?: (args: string[]) => { code: number; stdout: string; stderr: string };
    spawnWorker?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
    preflight?: (request: {
      repoDir: string;
      environment: Record<string, string | undefined>;
    }) => Promise<{ ok: true } | { ok: false; message: string }>;
  } = {},
): WatchdogActivity {
  return new WatchdogActivity({
    descriptor: agentRegistry.require("watchdog"),
    repoDir: root,
    stateDir: join(root, "state"),
    harnessDir: harnessRoot,
    send: () => undefined,
    ...(options.systemctl === undefined ? {} : { systemctl: options.systemctl }),
    ...(options.spawnWorker === undefined ? {} : { spawnWorker: options.spawnWorker }),
    ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
  });
}

describe("detached watchdog worker", () => {
  test("runs its first cycle immediately, stops on command, and releases the lock", async () => {
    const root = await temporaryRoot();
    const directory = watchdogDirectory(root);
    const child = spawn(
      process.execPath,
      [
        join(harnessRoot, "watchdog", "worker.ts"),
        "--root",
        root,
        "--state-dir",
        directory,
      ],
      { cwd: harnessRoot, stdio: "ignore" },
    );
    try {
      const running = await waitFor(() => {
        const state = readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)));
        return state?.lifecycle === "running" ? state : undefined;
      }, "the worker to publish running");
      expect(typeof running.pid).toBe("number");
      await waitFor(() => readJson(join(directory, "latest.json")), "the first cycle report");
      expect(existsSync(versionedLockPath(directory, harnessVersion))).toBe(true);

      writeWatchdogCommand(versionedControlDirectory(directory, harnessVersion), { type: "stop" });
      await waitFor(
        () =>
          (readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)))
            ?.lifecycle === "stopped"
            ? true
            : undefined),
        "the worker to publish stopped",
      );
      await waitFor(
        () => (existsSync(versionedLockPath(directory, harnessVersion)) ? undefined : true),
        "the lock release",
      );
      await waitFor(
        () => (child.exitCode === null ? undefined : true),
        "the worker process to exit",
      );
      const stopped = readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)));
      expect(stopped?.enabled).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  test("Stop and SIGTERM during a filing cycle finish it and keep its filing", async () => {
    const root = await temporaryRoot();
    const directory = watchdogDirectory(root);
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "gh"),
      "#!/bin/sh\nsleep 4\necho https://github.com/acme/fixture/issues/1\n",
      { mode: 0o755 },
    );
    const dedupStub = join(root, "dedup.json");
    await writeFile(
      dedupStub,
      `${JSON.stringify({
        read: { open_issues: [] },
        decisions: [{ fingerprint: "*", action: "unique" }],
      })}\n`,
    );
    const fingerprint = "0123456789abcdef0123456789abcdef";
    const seenAt = new Date().toISOString();
    saveLedger(directory, {
      version: 2,
      findings: {
        [fingerprint]: {
          category: "server-error",
          line: "Synthetic finding held by a slow forge call",
          firstSeen: seenAt,
          lastSeen: seenAt,
          count: 1,
          disposition: "none",
          instances: [],
        },
      },
      pendingFiling: [fingerprint],
    });
    const activity = adapter(root);
    const child = spawn(
      process.execPath,
      [
        join(harnessRoot, "watchdog", "worker.ts"),
        "--root",
        root,
        "--state-dir",
        directory,
        "--owner-state-dir",
        stateDir,
      ],
      {
        cwd: harnessRoot,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          DEVBOARD_WATCHDOG_DEDUP_STUB: dedupStub,
        },
      },
    );
    try {
      await waitFor(
        () => (existsSync(join(directory, "runs")) ? true : undefined),
        "the filing cycle to start",
      );
      const stop = activity.stop();
      expect(stop.ok).toBe(true);
      child.kill("SIGTERM");
      await waitFor(
        () =>
          (readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)))
            ?.lifecycle === "stopped"
            ? true
            : undefined),
        "the worker to finish its cycle and publish stopped",
      );
      await waitFor(
        () => (existsSync(versionedLockPath(directory, harnessVersion)) ? undefined : true),
        "the lock release",
      );
      const latest = readJson(join(directory, "latest.json"));
      expect(latest?.action).toBe("filed");
      expect(filedFingerprints(latest).filter((value) => value === fingerprint)).toEqual([
        fingerprint,
      ]);
      expect(existsSync(String(latest?.reportPath))).toBe(true);
      const ledger = loadLedger(directory);
      expect(ledger.findings[fingerprint]?.disposition).toBe(
        "filed:https://github.com/acme/fixture/issues/1",
      );
      expect(ledger.pendingFiling).toEqual([]);
      expect(
        readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)))?.enabled,
      ).toBe(false);
      expect(activity.snapshot().lifecycle).toBe("stopped");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      activity.dispose();
    }
  }, 30_000);

  test("applies a saved cadence without restarting the worker", async () => {
    const root = await temporaryRoot();
    const directory = watchdogDirectory(root);
    const child = spawn(
      process.execPath,
      [join(harnessRoot, "watchdog", "worker.ts"), "--root", root, "--state-dir", directory],
      { cwd: harnessRoot, stdio: "ignore" },
    );
    try {
      const running = await waitFor(() => {
        const state = readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)));
        return state?.lifecycle === "running" ? state : undefined;
      }, "the worker to publish running");
      const pid = running.pid;
      writeWatchdogCommand(versionedControlDirectory(directory, harnessVersion), {
        type: "settings",
        intervalMinutes: 30,
        maxPerHour: null,
        maxPending: null,
      });
      const changed = await waitFor(() => {
        const state = readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)));
        const last = typeof state?.lastRunAt === "string" ? Date.parse(state.lastRunAt) : NaN;
        const next = typeof state?.nextRunAt === "string" ? Date.parse(state.nextRunAt) : NaN;
        if (!Number.isFinite(last) || !Number.isFinite(next)) return undefined;
        return next - last >= 29 * 60_000 ? state : undefined;
      }, "the new cadence");
      expect(changed.pid).toBe(pid);
      expect(readJson(join(directory, "settings.json"))).toEqual({
        intervalMinutes: 30,
        maxPerHour: null,
        maxPending: null,
      });
      writeWatchdogCommand(versionedControlDirectory(directory, harnessVersion), { type: "stop" });
      await waitFor(
        () =>
          (readJson(workerStatePath(versionedWorkerDirectory(directory, harnessVersion)))
            ?.lifecycle === "stopped"
            ? true
            : undefined),
        "the worker to stop",
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("watchdog lifecycle and ownership", () => {
  test("Start reaches starting before the worker and running once its state is readable", async () => {
    const root = await temporaryRoot();
    const directory = watchdogDirectory(root);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = sleeper.pid!;
    const activity = adapter(root, {
      preflight: async () => ({ ok: true }),
      spawnWorker: () => {
        writeWorkerState(directory, {
          version: 1,
          pid,
          startedAt: new Date().toISOString(),
          root,
          stateDir: join(root, "state"),
          lifecycle: "running",
          enabled: true,
          harnessVersion: "test",
          argv: [],
          lastRunAt: null,
          nextRunAt: null,
          lastError: null,
          notice: null,
          updatedAt: new Date().toISOString(),
        });
        return pid;
      },
    });
    try {
      const pending = activity.start();
      expect(activity.snapshot().lifecycle).toBe("starting");
      const started = await pending;
      expect(started.ok).toBe(true);
      const running = await waitFor(
        () => (activity.snapshot().lifecycle === "running" ? activity.snapshot() : undefined),
        "running",
      );
      expect(running.owned).toBe(true);
      expect(running.attached).toBe(true);

      const stopped = activity.stop();
      expect(stopped.ok).toBe(true);
      expect(activity.snapshot().lifecycle).toBe("stopping");
      sleeper.kill("SIGKILL");
      await waitFor(
        () => (activity.snapshot().lifecycle === "stopped" ? true : undefined),
        "stopped",
      );
    } finally {
      if (sleeper.exitCode === null) sleeper.kill("SIGKILL");
      activity.dispose();
    }
  }, 20_000);

  test("a worker owned by another dashboard reads running, owned false, and cannot be stopped", async () => {
    const root = await temporaryRoot();
    const directory = watchdogDirectory(root);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = sleeper.pid!;
    try {
      writeWorkerState(directory, {
        version: 1,
        pid,
        startedAt: new Date().toISOString(),
        root,
        stateDir: join(root, "another-state"),
        lifecycle: "running",
        enabled: true,
        harnessVersion: "test",
        argv: [],
        lastRunAt: null,
        nextRunAt: null,
        lastError: null,
        notice: null,
        updatedAt: new Date().toISOString(),
      });
      let spawned = 0;
      const activity = adapter(root, {
        spawnWorker: () => {
          spawned += 1;
          return undefined;
        },
      });
      const snapshot = activity.snapshot();
      expect(snapshot.lifecycle).toBe("running");
      expect(snapshot.owned).toBe(false);
      const stopped = activity.stop();
      expect(stopped.ok).toBe(false);
      const started = await activity.start();
      expect(started.ok).toBe(true);
      if (started.ok) expect(started.notice).toContain("another dashboard");
      expect(spawned).toBe(0);
      activity.dispose();
    } finally {
      sleeper.kill("SIGKILL");
    }
  }, 20_000);
});

describe("watchdog preflight and timer gate", () => {
  test("refuses a root without .devboard and names it", async () => {
    const root = await temporaryRoot();
    await rm(join(root, ".devboard"), { recursive: true, force: true });
    const result = await preflightWatchdog({ repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(".devboard");
  });

  test("refuses while the legacy timer is active or enabled", async () => {
    const root = await temporaryRoot();
    const result = await preflightWatchdog({
      repoDir: root,
      environment: process.env,
      systemctl: (args) =>
        args[0] === "is-active"
          ? { code: 0, stdout: "active", stderr: "" }
          : { code: 0, stdout: "disabled", stderr: "" },
      run: async () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("devboard-watchdog.timer");
  });

  test("reads the timer gate, offers a disable, and clears the block", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    let blocked = true;
    const activity = adapter(root, {
      systemctl: (args) => {
        calls.push(args);
        if (args[0] === "disable") {
          blocked = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "is-active") {
          return { code: 0, stdout: blocked ? "active" : "inactive", stderr: "" };
        }
        return { code: 0, stdout: blocked ? "enabled" : "disabled", stderr: "" };
      },
    });
    try {
      activity.begin();
      const gated = await waitFor(
        () => (activity.snapshot().timer?.blocked === true ? activity.snapshot().timer : undefined),
        "the timer gate",
      );
      expect(gated?.unit).toBe("devboard-watchdog.timer");
      expect(gated?.state).toBe("active");
      const disabled = await activity.disableTimer();
      expect(disabled.ok).toBe(true);
      expect(calls.some((args) => args[0] === "disable" && args.includes("--now"))).toBe(true);
      expect(activity.snapshot().timer?.blocked).toBe(false);
    } finally {
      activity.dispose();
    }
  });

  test("a failed disable shows its first stderr line and keeps the block", async () => {
    const root = await temporaryRoot();
    let disabled = false;
    const activity = adapter(root, {
      systemctl: (args) => {
        if (args[0] === "disable") {
          disabled = true;
          return { code: 1, stdout: "", stderr: "Failed to disable unit: Access denied\nsecond" };
        }
        if (args[0] === "is-active") return { code: 0, stdout: "active", stderr: "" };
        return { code: 0, stdout: "enabled", stderr: "" };
      },
    });
    try {
      activity.begin();
      await waitFor(
        () => (activity.snapshot().timer?.blocked === true ? true : undefined),
        "the timer gate",
      );
      const result = await activity.disableTimer();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("Access denied");
      expect(disabled).toBe(true);
      const snapshot = activity.snapshot();
      expect(snapshot.timer?.blocked).toBe(true);
      expect(snapshot.timer?.error).toContain("Access denied");
      expect(snapshot.error).toContain("Access denied");
    } finally {
      activity.dispose();
    }
  });

  test("an absent systemctl leaves Start available", async () => {
    const root = await temporaryRoot();
    const activity = adapter(root, {
      systemctl: () => ({ code: 127, stdout: "", stderr: "systemctl: not found" }),
    });
    try {
      activity.begin();
      const timer = await waitFor(
        () => (activity.snapshot().timer !== null ? activity.snapshot().timer : undefined),
        "the absent timer gate",
      );
      expect(timer?.state).toBe("absent");
      expect(timer?.blocked).toBe(false);
    } finally {
      activity.dispose();
    }
  });
});

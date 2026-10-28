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
});

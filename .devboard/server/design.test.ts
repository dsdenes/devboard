import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DesignBridge } from "./design";
import { agentRegistry } from "./agents/registry";
import { lockPath, statePath } from "../issues/design/paths";
import { emptyState, writeState } from "../issues/design/state";
import { createdDirectories, temporaryDirectory } from "../tests/fixtures/scout-helpers";

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

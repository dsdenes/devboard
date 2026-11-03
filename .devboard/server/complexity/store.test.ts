import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComplexitySnapshot } from "./analyze";
import { ComplexitySnapshots, complexityClock } from "./snapshots";
import {
  complexityDirectory,
  parseSnapshot,
  readSnapshots,
  snapshotFile,
  writeSnapshot,
} from "./store";

const temporaryRoot = join(import.meta.dir, "..", "..", ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function snapshot(date: string, loc: number): ComplexitySnapshot {
  return {
    version: 1,
    date,
    recordedAt: `${date}T00:00:00.000Z`,
    project: {
      files: 1,
      functions: 1,
      loc,
      meanCyclomatic: 2,
      maxCyclomatic: 3,
      functionsOverThreshold: 0,
      duplicatedLineRatio: 0.125,
      meanMaintainability: 80,
    },
    files: [
      {
        path: ".devboard/server/keep.ts",
        loc,
        functions: 1,
        duplicatedLineRatio: 0.125,
        maintainability: 80,
      },
    ],
    functions: [
      {
        path: ".devboard/server/keep.ts",
        name: "keep",
        line: 1,
        lines: 3,
        cyclomatic: 2,
        nesting: 0,
        parameters: 1,
      },
    ],
  };
}

describe("snapshot persistence", () => {
  test("round-trips every level of a snapshot through its day's file", async () => {
    const root = await temporaryDirectory("complexity-store-");
    const directory = complexityDirectory(root, join(root, "checkout"));
    const stored = snapshot("2026-11-01", 10);

    await writeSnapshot(directory, stored);

    expect(await readdir(directory)).toEqual(["2026-11-01.json"]);
    expect(await readFile(snapshotFile(directory, "2026-11-01"), "utf8")).toContain('"version":1');
    expect(readSnapshots(directory)).toEqual([stored]);
    expect(parseSnapshot(stored)).toEqual(stored);
  });

  test("reads the recorded days oldest first and skips damaged files", async () => {
    const root = await temporaryDirectory("complexity-store-");
    const directory = complexityDirectory(root, join(root, "checkout"));

    await writeSnapshot(directory, snapshot("2026-11-02", 12));
    await writeSnapshot(directory, snapshot("2026-11-01", 11));
    await writeFile(snapshotFile(directory, "2026-11-03"), "{ not json");
    await writeFile(
      snapshotFile(directory, "2026-11-04"),
      JSON.stringify({ ...snapshot("2026-11-04", 13), version: 2 }),
    );
    await writeFile(join(directory, "notes.txt"), "ignore me");

    expect(readSnapshots(directory).map((entry) => entry.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(parseSnapshot({ ...snapshot("2026-11-01", 1), files: [{ path: "" }] })).toBeUndefined();
  });

  test("a missing directory is an empty history", async () => {
    const root = await temporaryDirectory("complexity-store-");

    expect(readSnapshots(join(root, "absent"))).toEqual([]);
  });
});

describe("the once-per-UTC-day rule", () => {
  test("records one snapshot per day and none for a repeat or a restart", async () => {
    const root = await temporaryDirectory("complexity-daily-");
    const stateDir = join(root, "state");
    const repoDir = join(root, "checkout");
    let instant = Date.parse("2026-11-01T09:00:00.000Z");
    let measurements = 0;
    const analyze = (now: Date): ComplexitySnapshot => {
      measurements += 1;
      return { ...snapshot(now.toISOString().slice(0, 10), 10 + measurements), date: "ignored" };
    };
    const options = {
      stateDir,
      repoDir,
      now: () => new Date(instant),
      analyze,
      intervalMs: 60_000,
    };

    const first = new ComplexitySnapshots(options);
    const created = await first.check();
    expect(created?.date).toBe("2026-11-01");
    expect(measurements).toBe(1);

    // A second check, a page reload, and a reconnect on the same day add
    // nothing and measure nothing.
    expect(await first.check()).toBeNull();
    expect(measurements).toBe(1);
    first.dispose();

    // The UTC date rolls over while the server runs: one new file.
    instant = Date.parse("2026-11-02T00:00:30.000Z");
    expect((await first.check())?.date).toBe("2026-11-02");
    expect(measurements).toBe(2);
    first.dispose();

    // A restart on the second day finds the day already recorded.
    const restarted = new ComplexitySnapshots(options);
    expect(await restarted.check()).toBeNull();
    expect(measurements).toBe(2);
    expect(readSnapshots(complexityDirectory(stateDir, repoDir)).map((entry) => entry.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
    restarted.dispose();
  });

  test("overlapping checks share one measurement and one file", async () => {
    const root = await temporaryDirectory("complexity-daily-");
    let measurements = 0;
    const controller = new ComplexitySnapshots({
      stateDir: join(root, "state"),
      repoDir: join(root, "checkout"),
      now: () => new Date("2026-11-01T12:00:00.000Z"),
      analyze: (now) => {
        measurements += 1;
        return snapshot(now.toISOString().slice(0, 10), 10);
      },
    });

    const [left, right] = await Promise.all([controller.check(), controller.check()]);

    expect(measurements).toBe(1);
    expect(left?.date).toBe("2026-11-01");
    expect(right).toBe(left);
    expect(readSnapshots(controller.directory)).toHaveLength(1);
    controller.dispose();
  });

  test("the frame lists every recorded date and carries the newest detail", async () => {
    const root = await temporaryDirectory("complexity-daily-");
    let instant = Date.parse("2026-11-01T12:00:00.000Z");
    const controller = new ComplexitySnapshots({
      stateDir: join(root, "state"),
      repoDir: join(root, "checkout"),
      now: () => new Date(instant),
      analyze: (now) => snapshot(now.toISOString().slice(0, 10), 10),
    });

    await controller.check();
    instant = Date.parse("2026-11-02T12:00:00.000Z");
    await controller.check();

    const frame = controller.frame();
    expect(frame.snapshots.map((entry) => entry.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(frame.snapshots.map((entry) => entry.project.loc)).toEqual([10, 10]);
    expect(frame.latest?.date).toBe("2026-11-02");
    expect(frame.latest?.files).toHaveLength(1);
    controller.dispose();
  });

  test("a failed measurement records nothing and is reported once", async () => {
    const root = await temporaryDirectory("complexity-daily-");
    const errors: string[] = [];
    const controller = new ComplexitySnapshots({
      stateDir: join(root, "state"),
      repoDir: join(root, "checkout"),
      now: () => new Date("2026-11-01T12:00:00.000Z"),
      analyze: () => {
        throw new Error("unreadable source");
      },
      reportError: (line) => errors.push(line),
    });

    expect(await controller.check()).toBeNull();
    expect(errors).toEqual(["complexity: measurement for 2026-11-01 failed: unreadable source"]);
    expect(controller.snapshots).toEqual([]);
    controller.dispose();
  });
});

test("the pinned clock fixes the day and an unusable value falls back to the real one", () => {
  expect(complexityClock({ DEVBOARD_COMPLEXITY_NOW: "2026-11-01T06:00:00.000Z" })().toISOString()).toBe(
    "2026-11-01T06:00:00.000Z",
  );
  expect(complexityClock({ DEVBOARD_COMPLEXITY_NOW: "not a date" })().getTime()).toBeGreaterThan(
    Date.parse("2025-01-01T00:00:00.000Z"),
  );
});

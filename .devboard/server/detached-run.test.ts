import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pidAlive } from "../issues/lock";
import {
  DETACHED_RUN_VERSION,
  DetachedPeer,
  appendDetachedRunActivity,
  beginDetachedHandoff,
  detachedRunDirectory,
  detachedRunLeasePath,
  endDetachedHandoff,
  readDetachedRunActivity,
  readDetachedRunState,
  writeDetachedLease,
  writeDetachedRunState,
} from "./detached-run";

const harness = resolve(import.meta.dir, "..");
const testRoot = join(harness, ".tmp");
const stub = join(harness, "tests", "fixtures", "slow-stub-acp.ts");
const directories: string[] = [];

async function fixture(): Promise<{ repoDir: string; stateDir: string }> {
  await mkdir(testRoot, { recursive: true });
  const repoDir = join(testRoot, `detached-run-${randomUUID()}`);
  const stateDir = join(repoDir, "state");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  directories.push(repoDir);
  return { repoDir, stateDir };
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("detached runs", () => {
  test("a peer survives a dashboard replacement and replays its activity", async () => {
    const { repoDir, stateDir } = await fixture();
    writeDetachedLease(stateDir, repoDir, "a");
    const activity: string[] = [];
    const first = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "lane",
      key: "1",
      instance: "a",
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      env: { ...process.env, SLOW_STUB_MS: "2000" },
      onActivity: (entry) => activity.push(entry.text),
      onQuestion: () => undefined,
    });
    const firstRun = first.run("work");
    await waitFor(() => activity.length > 0);
    const ownerPid = first.ownerPid;
    expect(ownerPid).toBeDefined();
    expect(pidAlive(ownerPid!)).toBe(true);

    // The replacement writes its handoff and lease; the owner stays alive.
    beginDetachedHandoff(stateDir, repoDir, "a");
    first.close();
    writeDetachedLease(stateDir, repoDir, "b");
    const replayed: string[] = [];
    const second = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "lane",
      key: "1",
      instance: "b",
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      env: { ...process.env, SLOW_STUB_MS: "2000" },
      onActivity: (entry) => replayed.push(entry.text),
      onQuestion: () => undefined,
    });
    const secondRun = second.run("work");
    await waitFor(() => replayed.join("").includes("first line"));
    expect(second.ownerPid).toBe(ownerPid);
    expect(pidAlive(ownerPid!)).toBe(true);
    await secondRun;
    expect(readDetachedRunState(detachedRunDirectory(stateDir, repoDir, "lane", "1"))?.status).toBe(
      "succeeded",
    );
    expect(replayed.join("")).toContain("second line");

    const run = await firstRun;
    expect(run).toEqual({ preserved: true });
    endDetachedHandoff(stateDir, repoDir);
    expect(readDetachedRunActivity(detachedRunDirectory(stateDir, repoDir, "lane", "1")).length)
      .toBeGreaterThan(1);
  }, 30_000);

  test("a new instance in the same process adopts the live run", async () => {
    const { repoDir, stateDir } = await fixture();
    writeDetachedLease(stateDir, repoDir, "a");
    const first = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "adr",
      key: "record",
      instance: "a",
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      env: { ...process.env, SLOW_STUB_MS: "1500" },
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    void first.run("work");
    await waitFor(() => first.ownerPid !== undefined);
    const ownerPid = first.ownerPid;

    // A second dashboard in this process supervises the same owner.
    writeDetachedLease(stateDir, repoDir, "b");
    const directory = detachedRunDirectory(stateDir, repoDir, "adr", "record");
    // Wait for the owner to record the new lease, so this test covers the
    // state a successor actually reads: the run already names its instance.
    await waitFor(() => readDetachedRunState(directory)?.instance === "b");
    const second = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "adr",
      key: "record",
      instance: "b",
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      env: { ...process.env, SLOW_STUB_MS: "100" },
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    void second.run("work");
    await waitFor(() => second.ownerPid !== undefined);
    expect(second.ownerPid).toBe(ownerPid);
    second.close();
  }, 30_000);

  test("a foreign dashboard lease never ends a run its own live launcher supervises", async () => {
    const { repoDir, stateDir } = await fixture();
    // Another dashboard serves the same repository and holds its shared lease
    // with a live process while this process started and supervises the run.
    // The child blocks on its stdin, so it stays alive without a wall-clock
    // delay until the test kills it.
    const foreign = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      const leasePath = detachedRunLeasePath(stateDir, repoDir);
      await mkdir(dirname(leasePath), { recursive: true });
      await writeFile(
        leasePath,
        JSON.stringify({ pid: foreign.pid, instance: "other", updatedAt: Date.now() }),
      );
      const peer = new DetachedPeer({
        repoDir,
        stateDir,
        kind: "discover",
        key: "contribution",
        instance: "mine",
        command: `${process.execPath} ${stub}`,
        cwd: repoDir,
        env: { ...process.env, SLOW_STUB_MS: "600" },
        onActivity: () => undefined,
        onQuestion: () => undefined,
      });
      await peer.run("work");
      const state = readDetachedRunState(
        detachedRunDirectory(stateDir, repoDir, "discover", "contribution"),
      );
      expect(state?.status).toBe("succeeded");
      expect(state?.error).toBeNull();
    } finally {
      foreign.kill();
      await foreign.exited;
    }
  }, 30_000);

  test("Stop reaches the same owner and ends the run", async () => {
    const { repoDir, stateDir } = await fixture();
    writeDetachedLease(stateDir, repoDir, "a");
    const peer = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "adr",
      key: "stop",
      instance: "a",
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      env: { ...process.env, SLOW_STUB_MS: "5000" },
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    const running = peer.run("work");
    await waitFor(() => peer.ownerPid !== undefined);
    const ownerPid = peer.ownerPid;
    peer.close();
    await running;
    await waitFor(
      () =>
        readDetachedRunState(detachedRunDirectory(stateDir, repoDir, "adr", "stop"))?.status ===
        "stopped",
    );
    await waitFor(() => !pidAlive(ownerPid!));
  }, 30_000);

  test("a poll re-bases its activity cursor when the journal drops its oldest entries", async () => {
    const { repoDir, stateDir } = await fixture();
    const directory = detachedRunDirectory(stateDir, repoDir, "lane", "trim");
    await mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    writeDetachedRunState(directory, {
      version: DETACHED_RUN_VERSION,
      kind: "lane",
      key: "trim",
      repo: resolve(repoDir),
      stateDir: resolve(stateDir),
      harnessVersion: null,
      instance: "a",
      launcherPid: process.pid,
      generation: randomUUID(),
      status: "running",
      startedAt: now,
      finishedAt: null,
      error: null,
      question: null,
      owner: { pid: process.pid, argv: [], cwd: repoDir },
      peer: null,
      updatedAt: now,
    });
    const delivered: string[] = [];
    const peer = new DetachedPeer({
      repoDir,
      stateDir,
      kind: "lane",
      key: "trim",
      instance: "a",
      attachOnly: true,
      pollMs: 10,
      command: `${process.execPath} ${stub}`,
      cwd: repoDir,
      onActivity: (entry) => delivered.push(entry.text),
      onQuestion: () => undefined,
    });
    const run = peer.run("work");
    appendDetachedRunActivity(directory, { text: "before the bound", append: false });
    await waitFor(() => delivered.includes("before the bound"));

    // Cross the journal's byte bound with more entries than its window holds,
    // so the rewrite discards entries the peer has already counted.
    const filler = "x".repeat(1_024);
    for (let index = 0; index < 1_200; index += 1) {
      appendDetachedRunActivity(directory, { text: `${filler} ${index}`, append: false });
    }
    await waitFor(() => readDetachedRunActivity(directory).length < 1_200);
    await waitFor(() => delivered.length > 1);

    const after = ["after the bound one", "after the bound two", "after the bound three"];
    for (const text of after) appendDetachedRunActivity(directory, { text, append: false });
    await waitFor(() => after.every((text) => delivered.includes(text)));
    // The cursor counts what was appended, not a renumbered position, so no
    // entry reaches the dashboard twice.
    expect(new Set(delivered).size).toBe(delivered.length);
    peer.close();
    await run;
  }, 30_000);
});

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { testProviderService } from "./fixtures/test-providers";
import {
  GOAL_DRAFT_OWNER_VERSION,
  readGoalDraftHandoff,
  readGoalDraftLease,
  writeGoalDraftHandoff,
  writeGoalDraftOwnerState,
} from "./goal-draft-owner";

/**
 * A bind attempt that throws EADDRINUSE is discarded whole. `server/index.ts`
 * retries `createApp`, so an abandoned attempt that attached to the state
 * directory would adopt a pending reload handoff and write its own lease
 * before the attempt that finally serves ever binds.
 */

const testRoot = join(resolve(import.meta.dir, ".."), ".tmp");
const temporaryDirectories: string[] = [];
const owners: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];

afterAll(async () => {
  for (const owner of owners) {
    owner.kill();
    await owner.exited;
  }
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  stateDir: string;
  adrDir: string;
  staticDir: string;
}> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "bind-retry-"));
  temporaryDirectories.push(root);
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const stateDir = join(root, "state");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Bind retry</title>");
  return { root, stateDir, adrDir, staticDir };
}

/** Seeds the pending handoff and live owner a reload replacement would adopt. */
async function seedPendingHandoff(root: string, stateDir: string): Promise<void> {
  const argv = [process.execPath, "-e", "await new Promise(() => {})"];
  const owner = Bun.spawn({
    cmd: argv,
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  owners.push(owner);
  const path = ".devboard/goal-proposals/pending.md";
  const now = new Date().toISOString();
  writeGoalDraftOwnerState(stateDir, root, path, {
    version: GOAL_DRAFT_OWNER_VERSION,
    run: {
      status: "running",
      path,
      startedAt: now,
      finishedAt: null,
      error: null,
      activity: ["the live owner"],
      question: null,
    },
    owner: { pid: owner.pid, argv, cwd: root },
    peer: null,
    launcherPid: process.pid,
    supervisorPid: process.pid,
    updatedAt: now,
  });
  writeGoalDraftHandoff(stateDir, root, { at: Date.now(), pid: process.pid });
}

test(
  "a bind attempt that throws leaves the pending handoff to the manager that serves",
  async () => {
    const { root, stateDir, adrDir, staticDir } = await fixture();
    await seedPendingHandoff(root, stateDir);
    const holder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("held"),
    });
    const app = (port: number) =>
      createApp({
        adrDir,
        staticDir,
        hostname: "127.0.0.1",
        port,
        repoDir: root,
        stateDir,
        runningVersion: "test",
        agentCommand: "true",
        providers: testProviderService(stateDir),
        issues: { syncRead: async () => ({ kind: "not-modified", etag: null }) },
      });
    try {
      // The retry loop's first and second attempts lose the bind to the holder.
      expect(() => app(holder.port ?? 0)).toThrow();
      expect(() => app(holder.port ?? 0)).toThrow();
      expect(readGoalDraftHandoff(stateDir, root)).not.toBeNull();
      expect(readGoalDraftLease(stateDir, root)).toBeNull();

      holder.stop(true);
      const server = app(holder.port ?? 0);
      try {
        expect(readGoalDraftHandoff(stateDir, root)).toBeNull();
        const lease = readGoalDraftLease(stateDir, root);
        expect(lease?.pid).toBe(process.pid);
        expect(lease?.instance).toBeDefined();
      } finally {
        server.stop(true);
      }
    } finally {
      holder.stop(true);
    }
  },
  60_000,
);

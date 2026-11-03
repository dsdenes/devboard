import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInstalledDashboard, stopPid } from "../scripts/verification";
import { AcpConnection } from "../server/acp";
import { DetachedPeer } from "../server/detached-run";
import { readGoalDraftOwnerState } from "../server/goal-draft-owner";
import { GoalDraftManager } from "../server/goal-drafts";
import { IssuesBridge } from "../server/issues";
import { liveProcess, processStat, readSupervisionRecords } from "../watchdog/supervision";
import {
  cleanupScratch,
  harnessRoot,
  idlePeer,
  killFixture,
  recordOf,
  scratch,
  stubAgent,
  waitFor,
} from "./fixtures/supervision-helpers";

/**
 * One supervised spawn path: every surface starts its child in its own process
 * group and records it before using it. Each test drives the production surface
 * and observes the child, its record, and the record's removal.
 */

afterAll(cleanupScratch);

describe("supervised spawn record", () => {
  test("records an ACP peer in its own process group while it runs", async () => {
    const stateDir = await scratch("supervision-acp");
    const connection = new AcpConnection({
      command: `${process.execPath} ${stubAgent}`,
      cwd: stateDir,
      env: { ...process.env, STATE_DIR: stateDir },
      stateDir,
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    const pid = connection.pid;
    expect(pid).toBeDefined();
    try {
      const record = await waitFor(() => recordOf(stateDir, pid!), "the peer record");
      expect(record.ownerPid).toBe(process.pid);
      expect(record.argv.join(" ")).toContain("stub-agent.ts");
      expect(processStat(pid!)?.pgrp).toBe(pid!);
      expect(record.pgid).toBe(pid!);
    } finally {
      connection.close();
    }
    await waitFor(
      () => (recordOf(stateDir, pid!) === undefined ? true : undefined),
      "the peer record to leave",
    );
  }, 30_000);

  test("records the detached run owner and the peer it starts", async () => {
    const stateDir = await scratch("supervision-run-owner");
    const repoDir = await scratch("supervision-run-repo");
    const command = await idlePeer(repoDir);
    const peer = new DetachedPeer({
      command,
      cwd: repoDir,
      repoDir,
      stateDir,
      kind: "test",
      key: "record",
      instance: "supervision-test",
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    const run = peer.run("record the owner");
    try {
      const ownerPid = await waitFor(() => peer.ownerPid, "the run owner pid");
      const record = await waitFor(() => recordOf(stateDir, ownerPid), "the owner record");
      expect(record.argv.join(" ")).toContain("run-owner.ts");
      expect(processStat(ownerPid)?.pgrp).toBe(ownerPid);
      const peerPid = await waitFor(() => peer.pid, "the recorded peer pid");
      const peerRecord = await waitFor(() => recordOf(stateDir, peerPid), "the peer record");
      expect(peerRecord.ownerPid).toBe(ownerPid);
      expect(processStat(peerPid)?.pgrp).toBe(peerPid);
      peer.close();
      void run.catch(() => undefined);
      await waitFor(() => recordOf(stateDir, ownerPid) === undefined, "the owner record to leave");
      await waitFor(() => (!liveProcess(peerPid) ? true : undefined), "the peer to end");
    } finally {
      peer.close();
      killFixture(peer.ownerPid);
      killFixture(peer.pid);
    }
  }, 30_000);

  test("records the goal-draft owner and the peer it starts", async () => {
    const repoDir = await scratch("supervision-draft-repo");
    const stateDir = await scratch("supervision-draft-state");
    mkdirSync(join(repoDir, ".devboard", "goal-proposals"), { recursive: true });
    writeFileSync(join(repoDir, ".devboard", "goal-proposals", "draft.md"), "# Draft\n\nbody\n");
    const command = await idlePeer(repoDir);
    const manager = new GoalDraftManager({
      repoDir,
      stateDir,
      command,
      send: () => undefined,
      environment: async () => ({ ...process.env }),
      pollMs: 50,
      log: () => undefined,
    });
    manager.begin();
    const path = ".devboard/goal-proposals/draft.md";
    try {
      const started = await manager.start(path);
      expect(started.ok).toBe(true);
      const owner = await waitFor(
        () => readGoalDraftOwnerState(stateDir, repoDir, path)?.owner ?? undefined,
        "the draft owner",
      );
      const record = await waitFor(() => recordOf(stateDir, owner.pid), "the owner record");
      expect(record.argv.join(" ")).toContain("goal-draft-owner.ts");
      expect(processStat(owner.pid)?.pgrp).toBe(owner.pid);
      manager.stop(path);
      await waitFor(
        () => (recordOf(stateDir, owner.pid) === undefined ? true : undefined),
        "the owner record to leave",
      );
    } finally {
      manager.stop(path);
      manager.dispose();
      killFixture(readGoalDraftOwnerState(stateDir, repoDir, path)?.owner?.pid);
    }
  }, 30_000);

  test("records the verification dashboard it starts in its own group", async () => {
    const host = await scratch("supervision-dashboard");
    const prefix = join(host, ".devboard");
    const installed = join(prefix, "node_modules", "@dsdenes", "devboard");
    mkdirSync(join(installed, "server"), { recursive: true });
    writeFileSync(
      join(installed, "server", "index.ts"),
      `Bun.serve({\n` +
        `  hostname: "127.0.0.1",\n` +
        `  port: Number(process.env.PORT ?? 0),\n` +
        `  fetch: () => new Response("ok"),\n` +
        `});\n`,
    );
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0" }),
    );
    const dashboard = await startInstalledDashboard(host, {});
    const stateDir = join(prefix, ".tmp");
    try {
      const record = await waitFor(() => recordOf(stateDir, dashboard.pid), "the dashboard record");
      expect(record.argv.join(" ")).toContain("server/index.ts");
      expect(processStat(dashboard.pid)?.pgrp).toBe(dashboard.pid);
    } finally {
      stopPid(dashboard.pid);
    }
    await waitFor(
      () => (recordOf(stateDir, dashboard.pid) === undefined ? true : undefined),
      "the dashboard record to leave",
    );
  }, 60_000);

  test("records a background worker entry point in its own group", async () => {
    const repoDir = await scratch("supervision-worker-repo");
    const stateDir = await scratch("supervision-worker-state");
    Bun.spawnSync({ cmd: ["git", "init", "-q", repoDir] });
    Bun.spawnSync({
      cmd: ["git", "-C", repoDir, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
    });
    const bridge = new IssuesBridge({
      repoDir,
      stateDir,
      agentCommand: `${process.execPath} ${stubAgent}`,
      agentEnvironment: async () => ({}),
      runningVersion: null,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: true }),
      pollMs: 50,
      log: () => undefined,
    });
    let workerPid: number | undefined;
    try {
      const started = await bridge.start();
      expect(started.ok).toBe(true);
      const record = await waitFor(
        () =>
          readSupervisionRecords(stateDir).find((entry) =>
            entry.argv.join(" ").includes(join("issues", "worker.ts")),
          ),
        "the worker record",
      );
      workerPid = record.pid;
      expect(record.ownerPid).toBe(process.pid);
      expect(processStat(record.pid)?.pgrp).toBe(record.pid);
    } finally {
      bridge.dispose();
      if (workerPid !== undefined) {
        try {
          process.kill(workerPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
    await waitFor(
      () => (recordOf(stateDir, workerPid!) === undefined ? true : undefined),
      "the worker record to leave",
    );
  }, 60_000);
});

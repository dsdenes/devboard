import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveProcess, reapOrphans, supervisedDetach } from "../watchdog/supervision";
import {
  cleanupScratch,
  killFixture,
  recordOf,
  scratch,
  snapshotOf,
  treeFixture,
  waitFor,
} from "./fixtures/supervision-helpers";

/**
 * The leak regression: a supervised owner starts a peer, the peer starts a
 * grandchild, and the owner is SIGKILLed. Every descendant is gone within one
 * minute and every record the owner left is removed, because the reaper proves
 * each child lost its owner rather than guessing from a name.
 */

afterAll(cleanupScratch);

function markerPid(marker: string, role: string): number | undefined {
  try {
    const text = readFileSync(`${marker}.${role}`, "utf8").trim();
    return text.length === 0 ? undefined : Number(text);
  } catch {
    return undefined;
  }
}

test("reaps an orphaned owner's peer and grandchild within one minute", async () => {
  const scratchDir = await scratch("supervision-orphan-tree");
  const stateDir = join(scratchDir, ".devboard", ".tmp");
  const marker = join(scratchDir, "tree");
  const ownerPid = supervisedDetach([process.execPath, treeFixture, stateDir, "owner", marker], {
    cwd: scratchDir,
    env: { ...process.env, STATE_DIR: stateDir },
    stateDir,
  });
  expect(ownerPid).toBeDefined();
  let peerPid: number | undefined;
  let grandchildPid: number | undefined;
  try {
    peerPid = await waitFor(() => markerPid(marker, "peer"), "the peer");
    grandchildPid = await waitFor(() => markerPid(marker, "grandchild"), "the grandchild");
    await waitFor(
      () =>
        recordOf(stateDir, ownerPid!) !== undefined &&
        recordOf(stateDir, peerPid!) !== undefined &&
        recordOf(stateDir, grandchildPid!) !== undefined
          ? true
          : undefined,
      "every record",
    );
    process.kill(ownerPid!, "SIGKILL");
    // One tick ends the tree; the 60-second bound covers a slow first pass.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      reapOrphans({
        scopes: [{ stateDir, repoDir: scratchDir }],
        processes: snapshotOf([peerPid, grandchildPid]),
        killGraceMs: 500,
      });
      if (
        !liveProcess(peerPid) &&
        !liveProcess(grandchildPid) &&
        recordOf(stateDir, peerPid) === undefined &&
        recordOf(stateDir, grandchildPid) === undefined
      ) {
        break;
      }
      await Bun.sleep(200);
    }
    expect(liveProcess(peerPid)).toBe(false);
    expect(liveProcess(grandchildPid)).toBe(false);
    expect(recordOf(stateDir, peerPid)).toBeUndefined();
    expect(recordOf(stateDir, grandchildPid)).toBeUndefined();
    expect(recordOf(stateDir, ownerPid!)).toBeUndefined();
  } finally {
    killFixture(ownerPid);
    killFixture(peerPid);
    killFixture(grandchildPid);
  }
}, 90_000);

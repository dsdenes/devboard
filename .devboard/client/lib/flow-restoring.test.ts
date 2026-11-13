import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { applyFrames } = await import("./frames");
const { connection } = await import("./connection.svelte");
const { flow } = await import("./flow.svelte");

// The frame path a mounted page installs: a pushed frame reaches the store
// through the connection's handler list, exactly as `App.svelte` wires it.
connection.onMessage((message) => flow.handleEvent(message as Record<string, unknown>));

/** One `flowSnapshot` frame with the field set the server answers. */
function snapshot(
  status: string,
  sessionId: string | null,
): { type: string } & Record<string, unknown> {
  return {
    type: "flowSnapshot",
    status,
    sessionId,
    goal: sessionId === null ? "" : "The stored session",
    decisions: "",
    worktree: null,
    branch: null,
    baseRevision: null,
    files: [],
    widgets: [],
    steering: [],
    checkpoints: [],
    verification: null,
    blockers: [],
    pr: null,
    prError: null,
    leftover: null,
    question: null,
    goalCreation: null,
    conversation: null,
    activity: [],
    notice: null,
    history: [],
  };
}

/** A read mid-restore is an answer, not the empty one that invites a new
 *  session: nothing that creates a goal or starts work is offered until the
 *  restored snapshot arrives. */
test("a restoring frame disables Start and goal creation until the restore lands", () => {
  applyFrames([snapshot("restoring", null)]);
  expect(flow.restoring).toBe(true);
  expect(flow.startDisabled).toBe(true);

  applyFrames([snapshot("idle", "seeded-session")]);
  expect(flow.restoring).toBe(false);
  expect(flow.startDisabled).toBe(false);
});

/// A merged session never ticks again, so the composer must not promise a
/// checkpoint; a stopped session is still read after a restart.
test("only an unmerged session offers a steering send", () => {
  applyFrames([snapshot("merged", "merged-session")]);
  flow.steeringDraft = "One more note";
  expect(flow.steeringMerged).toBe(true);
  expect(flow.steeringDisabled).toBe(true);

  applyFrames([snapshot("stopped", "stopped-session")]);
  flow.steeringDraft = "One more note";
  expect(flow.steeringMerged).toBe(false);
  expect(flow.steeringDisabled).toBe(false);

  flow.steeringDraft = "   ";
  expect(flow.steeringDisabled).toBe(true);
});

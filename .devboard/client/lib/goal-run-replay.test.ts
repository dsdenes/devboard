import { expect, test } from "bun:test";
import { GoalStore } from "./goal.svelte";

/** The started frame the polled `/goal` read replays for a live manual run. */
const STARTED = {
  type: "runStarted",
  file: "a.md",
  title: "Adopt the fixture decision",
  action: "resolving",
  manual: true,
};

/** The terminal frame the same read replays after that run ends. */
const FINISHED = {
  type: "runStopped",
  file: "a.md",
  title: "Adopt the fixture decision",
  resolved: true,
  status: "Accepted",
  activity: ["Inspecting a.md", "Answer received: Alpha"],
};

test("a replayed finished run re-enables Start and keeps its last action", () => {
  const store = new GoalStore();
  store.handleEvent(STARTED);
  store.handleEvent({ type: "activity", text: "Inspecting a.md" });
  store.handleEvent({ type: "activity", text: "Answer received: Alpha" });
  expect(store.runStartDisabled).toBe(true);
  expect(store.activityActive).toBe(true);

  // The run ended while the page was polling, so the stop broadcast reached
  // nobody and the next replay carries the terminal state instead.
  store.handleEvent(FINISHED);
  expect(store.runState).toBe("stopped");
  expect(store.manualRunActive).toBe(false);
  expect(store.runStartDisabled).toBe(false);
  expect(store.activityActive).toBe(false);
  expect(store.currentAction).toBe("Answer received: Alpha");
  expect(store.previousActions).toEqual(["Inspecting a.md"]);

  // Every later poll replays the same frame; it may not grow the log.
  store.handleEvent(FINISHED);
  expect(store.activity).toEqual(["Inspecting a.md", "Answer received: Alpha"]);
});

test("a reconnect forgets a run it cannot prove live", () => {
  const store = new GoalStore();
  store.handleEvent(STARTED);
  expect(store.runStartDisabled).toBe(true);

  store.resetActiveOperations();
  expect(store.runState).toBe("idle");
  expect(store.manualRunActive).toBe(false);
  expect(store.activity).toEqual([]);
  expect(store.runStartDisabled).toBe(false);
});

import { expect, jest, test } from "bun:test";
import { connection } from "./connection.svelte";
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

test("a replayed started frame keeps the run's first stamp", () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const store = new GoalStore();
    store.handleEvent(STARTED);
    const first = store.runStartedAt;
    expect(first).toBe("2026-11-01T00:00:00.000Z");

    // The next poll replays the same frame two seconds later; the run did not
    // start then, so its stamp may not move.
    jest.setSystemTime(new Date("2026-11-01T00:00:02Z"));
    store.handleEvent(STARTED);
    expect(store.runStartedAt).toBe(first);

    // A retitled replay is still the same run.
    store.handleEvent({ ...STARTED, title: "Adopt the revised decision" });
    expect(store.runTitle).toBe("Adopt the revised decision");
    expect(store.runStartedAt).toBe(first);

    // The run ends, and the next run of the same ADR gets its own stamp.
    store.handleEvent(FINISHED);
    jest.setSystemTime(new Date("2026-11-01T00:01:00Z"));
    store.handleEvent(STARTED);
    expect(store.runStartedAt).toBe("2026-11-01T00:01:00.000Z");
  } finally {
    jest.useRealTimers();
  }
});

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

test("a reconnect clears a reset that ended while the page was away", () => {
  const was = connection.state;
  connection.state = "open";
  try {
    const store = new GoalStore();
    store.handleEvent({ type: "implementationResetStarted" });
    store.resetStatus = "Reset committed as abc1234.";
    expect(store.resetting).toBe(true);
    expect(store.resetDisabled).toBe(true);
    expect(store.skillDeleteDisabled).toBe(true);

    // The reset finished during the outage: its stop frame reached no page,
    // and the replay sends the started frame only for a reset still running,
    // so the reconnect's own clear is the only thing that frees the controls.
    store.resetActiveOperations();
    expect(store.resetting).toBe(false);
    expect(store.resetDisabled).toBe(false);
    expect(store.skillDeleteDisabled).toBe(false);
    expect(store.resetStatus).toBe("Reset committed as abc1234.");

    // A reset that is still live replays its started frame in that same
    // reconnect, so the flag comes back and the controls stay busy.
    store.handleEvent({ type: "implementationResetStarted" });
    expect(store.resetting).toBe(true);
    expect(store.resetDisabled).toBe(true);
  } finally {
    connection.state = was;
  }
});

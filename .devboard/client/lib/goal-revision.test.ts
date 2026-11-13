import { afterEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import { GoalStore } from "./goal.svelte";

/** The frames one activation dispatched, with `send` stubbed for its duration. */
function dispatched(activate: (goal: GoalStore) => void): unknown[] {
  const sent: unknown[] = [];
  const original = connection.send;
  connection.send = (command) => {
    sent.push(command);
    return true;
  };
  try {
    activate(new GoalStore());
  } finally {
    connection.send = original;
  }
  return sent;
}

afterEach(() => {
  connection.lastError = null;
});

test("Revise goal dispatches the operator's guidance trimmed", () => {
  const sent = dispatched((goal) => {
    goal.revisionRequest = "  Tighten the scope to the merge path  ";
    goal.reviseGoal();
  });

  expect(sent).toEqual([{ type: "reviseGoal", request: "Tighten the scope to the merge path" }]);
});

test("Revise goal with an empty guidance field sends no request", () => {
  const sent = dispatched((goal) => {
    goal.revisionRequest = "   \n ";
    goal.reviseGoal();
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "reviseGoal" });
});

test("one revision consumes its guidance, so the next one starts empty", () => {
  const goal = new GoalStore();

  goal.revisionRequest = "Tighten the scope";
  goal.handleEvent({ type: "goalRevisionStarted" });
  expect(goal.revisionRequest).toBe("");

  goal.revisionRequest = "Drop the metrics";
  goal.handleEvent({
    type: "goalRevisionStopped",
    completed: true,
    text: "# Revised goal\n\nThe agent rewrote this.",
  });
  expect(goal.revisionRequest).toBe("");
});

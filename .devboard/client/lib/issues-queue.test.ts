import { describe, expect, test } from "bun:test";
import { queueCounts, queueSummary } from "./issues-queue";
import type { QueuedIssue } from "./types";

function issue(number: number, labels: string[] = []): QueuedIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://tracker.test/issues/${number}`,
    createdAt: "2026-10-26T00:00:00Z",
    labels,
    handled: false,
    runId: null,
    agentRunId: null,
  };
}

describe("queue counts", () => {
  test("a processing issue is running, not pending", () => {
    const counts = queueCounts([
      issue(17, ["processing"]),
      issue(18, ["processing", "goal"]),
      issue(19),
    ]);
    expect(counts).toEqual({ pending: 1, working: 2 });
  });

  test("a ledger's handled marker changes no count", () => {
    const handled: QueuedIssue = {
      ...issue(17),
      handled: true,
      runId: "run-17",
    };
    expect(queueCounts([handled, issue(18)])).toEqual({ pending: 2, working: 0 });
  });

  test("a stale worker run id changes no count", () => {
    const stale: QueuedIssue = {
      ...issue(17),
      agentRunId: "run-17",
    };
    expect(queueCounts([stale])).toEqual({ pending: 1, working: 0 });
  });

  test("an empty queue has no waiting or running work", () => {
    expect(queueCounts([])).toEqual({ pending: 0, working: 0 });
  });
});

describe("queue summary", () => {
  test("names both states while agents are working", () => {
    expect(queueSummary({ pending: 2, working: 3 })).toBe("2 pending · 3 running");
  });

  test("omits a zero running count", () => {
    expect(queueSummary({ pending: 0, working: 0 })).toBe("0 pending");
    expect(queueSummary({ pending: 5, working: 0 })).toBe("5 pending");
  });
});

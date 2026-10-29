import { describe, expect, test } from "bun:test";
import { queueCounts, queueSummary } from "./issues-queue";
import type { QueuedIssue } from "./types";

function issue(
  number: number,
  state: { handled?: boolean; agentRunId?: string | null } = {},
): QueuedIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://tracker.test/issues/${number}`,
    createdAt: "2026-10-26T00:00:00Z",
    labels: [],
    handled: state.handled ?? false,
    runId: null,
    agentRunId: state.agentRunId ?? null,
  };
}

describe("queue counts", () => {
  test("a running issue is not pending", () => {
    const counts = queueCounts([
      issue(17, { agentRunId: "run-17" }),
      issue(18, { agentRunId: "run-18" }),
      issue(19),
    ]);
    expect(counts).toEqual({ pending: 1, working: 2 });
  });

  test("a handled issue is neither pending nor working", () => {
    const counts = queueCounts([issue(17, { handled: true }), issue(18)]);
    expect(counts).toEqual({ pending: 1, working: 0 });
  });

  test("handled wins over a stale run id, as the row badge does", () => {
    const counts = queueCounts([issue(17, { handled: true, agentRunId: "stale" })]);
    expect(counts).toEqual({ pending: 0, working: 0 });
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

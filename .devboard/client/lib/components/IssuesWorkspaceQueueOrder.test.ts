import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");

/** The Issues mode's Queue tab. */
const QUEUE = { id: "issues", kind: "queue", resourceId: "issues", title: "Issues" };

function queued(number: number) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://tracker.test/issues/${number}`,
    createdAt: "2026-11-01T00:00:00Z",
    labels: [],
    handled: false,
    runId: null,
    agentRunId: null,
  };
}

/** A worker snapshot whose queue arrives in the tracker's own, unsorted order. */
function snapshot(queue: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    paused: false,
    queue,
    runs: [],
    agents: [],
  };
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("the queue renders in tracker order, never re-sorted by issue number", () => {
  issues.handleEvent(snapshot([queued(17), queued(12), queued(19)]));

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });

  const rows = view.getAllByTestId("issues-queue-item");
  expect(rows.map((row) => row.getAttribute("data-number"))).toEqual(["17", "12", "19"]);
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render, waitFor } = await import("@testing-library/svelte");
const { default: IssuesAgentFocus } = await import("./IssuesAgentFocus.svelte");
const { issues } = await import("../issues.svelte");

afterEach(() => cleanup());

const TAB = {
  id: "agent:run-42",
  kind: "agent",
  resourceId: "run-42",
  title: "#42 Fix the focus stream",
};

function snapshot(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    queue: [],
    runs: [],
    agents: [
      {
        runId: "run-42",
        issueNumber: 42,
        startedAt: "2026-11-09T10:00:00Z",
        question: null,
        acp: null,
        harnessVersion: "1.44.10",
      },
    ],
  };
}

test("the focus page shows the live streamed activity", async () => {
  issues.handleEvent(snapshot());
  issues.handleEvent({
    type: "issuesActivity",
    runId: "run-42",
    replay: true,
    entries: [
      { text: "$ cargo test", append: false },
      { text: "running tests", append: false },
    ],
  });

  const view = render(IssuesAgentFocus, {
    props: { tab: TAB, close: () => {}, openRuns: () => {} },
  });

  const log = await view.findByTestId("issues-agent-focus-activity");
  expect(log.getAttribute("data-run")).toBe("run-42");
  expect(log.textContent).toContain("$ cargo test");
  expect(log.textContent).toContain("running tests");

  // A later frame reaches the panel without a reload.
  issues.handleEvent({
    type: "issuesActivity",
    runId: "run-42",
    entries: [{ text: " 2 passed", append: true }],
  });
  await waitFor(() => expect(log.textContent).toContain("running tests 2 passed"));
});

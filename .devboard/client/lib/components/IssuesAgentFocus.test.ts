import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
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
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/svelte");
const { default: IssuesAgentFocus } = await import("./IssuesAgentFocus.svelte");
const { issues } = await import("../issues.svelte");

/**
 * The store is a module singleton, so a frame one test delivers would answer
 * another test's tab. Every test starts from no run selection at all.
 */
function resetRunState(): void {
  issues.snapshot = null;
  issues.agentActivity = {};
  issues.run = null;
  issues.runError = null;
  issues.selectedRun = null;
}

beforeEach(resetRunState);

afterEach(() => {
  cleanup();
  resetRunState();
});

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

  // The Output header names the run being read and when it started.
  const runId = view.getByTestId("issues-agent-focus-run-id");
  expect(runId.textContent?.trim()).toBe("run-42");
  expect(runId.getAttribute("title")).toBe("Run identifier: run-42");
  const started = view.getByTestId("issues-agent-focus-run-started");
  expect(started.textContent?.trim()).toStartWith("Started ");
  expect(started.getAttribute("title")).toBe("Started 2026-11-09T10:00:00Z");

  // A later frame reaches the panel without a reload.
  issues.handleEvent({
    type: "issuesActivity",
    runId: "run-42",
    entries: [{ text: " 2 passed", append: true }],
  });
  await waitFor(() => expect(log.textContent).toContain("running tests 2 passed"));
});

/** A run that already ended: its snapshot lists it as history, not as a live agent. */
function finishedSnapshot(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "idle",
    enabled: true,
    queue: [],
    runs: [
      {
        runId: "run-42",
        status: "succeeded",
        startedAt: "2026-11-09T10:00:00Z",
        finishedAt: "2026-11-09T10:04:00Z",
        exitCode: 0,
        issueNumbers: [42],
        activity: 2,
        firstStderrLine: null,
        harnessVersion: "1.44.10",
      },
    ],
    agents: [],
  };
}

/** One run's persisted history, as the `issuesRun` frame carries it. */
function finishedRun(): Record<string, unknown> {
  return {
    runId: "run-42",
    status: "succeeded",
    startedAt: "2026-11-09T10:00:00Z",
    finishedAt: "2026-11-09T10:04:00Z",
    exitCode: 0,
    issueNumbers: [42],
    activity: 2,
    firstStderrLine: null,
    harnessVersion: "1.44.10",
    repo: "dsdenes/devboard",
    argv: ["omp", "acp"],
    cwd: "/repo",
    issues: [],
    workerPid: 4242,
    activityLines: ["$ cargo test", "2 passed"],
  };
}

test("a finished run restored from history renders its recorded activity", async () => {
  issues.handleEvent(finishedSnapshot());

  const view = render(IssuesAgentFocus, {
    props: { tab: TAB, close: () => {}, openRuns: () => {} },
  });
  // The panel does not render before the history frame answers the request.
  expect(view.getByText("Loading the run from history…")).not.toBeNull();
  expect(view.queryByTestId("issues-agent-focus-activity")).toBeNull();

  issues.handleEvent({ type: "issuesRun", run: finishedRun() });

  const log = await view.findByTestId("issues-agent-focus-activity");
  expect(log.getAttribute("data-run")).toBe("run-42");
  expect(log.textContent).toContain("$ cargo test");
  expect(log.textContent).toContain("2 passed");
  expect(view.queryByTestId("issues-agent-focus-unavailable")).toBeNull();
  expect(view.queryByText("Loading the run from history…")).toBeNull();
});

test("a pruned run shows the unavailable panel and its way to the run list", async () => {
  issues.handleEvent(finishedSnapshot());
  let opened = 0;
  const view = render(IssuesAgentFocus, {
    props: { tab: TAB, close: () => {}, openRuns: () => (opened += 1) },
  });
  expect(view.getByText("Loading the run from history…")).not.toBeNull();

  issues.handleEvent({ type: "issuesRunMissing" });

  const panel = await view.findByTestId("issues-agent-focus-unavailable");
  expect(panel.textContent).toContain("This run is no longer available in run history.");
  expect(view.queryByTestId("issues-agent-focus-activity")).toBeNull();
  expect(view.queryByText("Loading the run from history…")).toBeNull();

  await fireEvent.click(view.getByText("Open Runs"));
  expect(opened).toBe(1);
});

test("a run restored from history keeps its id and start in the header", async () => {
  issues.handleEvent(finishedSnapshot());

  const view = render(IssuesAgentFocus, {
    props: { tab: TAB, close: () => {}, openRuns: () => {} },
  });
  issues.handleEvent({ type: "issuesRun", run: finishedRun() });

  const runId = await view.findByTestId("issues-agent-focus-run-id");
  expect(runId.textContent?.trim()).toBe("run-42");
  expect(runId.getAttribute("title")).toBe("Run identifier: run-42");

  // The start comes from the run history when no live agent owns the run.
  const started = view.getByTestId("issues-agent-focus-run-started");
  expect(started.textContent?.trim()).toStartWith("Started ");
  expect(started.getAttribute("title")).toBe("Started 2026-11-09T10:00:00Z");
});

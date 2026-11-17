import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The component and the testing library mount into the window happy-dom
// registers above, so they load after registration.
const { cleanup, render, waitFor } = await import("@testing-library/svelte");
const { default: GoalWorkspace } = await import("./GoalWorkspace.svelte");
const { goal } = await import("../goal.svelte");

/** The console tab that holds the lifecycle panel and its stage track. */
const OVERVIEW = {
  id: "overview",
  kind: "overview",
  resourceId: "overview",
  title: "Implementation",
};

/** The ADR the paused lifecycle was processing when the manual run started. */
const LIFECYCLE_RECORD = {
  file: "0007-lifecycle.md",
  title: "Lifecycle record",
  status: "Accepted",
  pending: true,
  summary: "Summary",
};

/** The implementation pass that paused itself for the manual run. */
const PAUSED_LIFECYCLE = {
  type: "lifecycleState",
  stage: "implementation",
  pass: 2,
  work: { kind: "adr", id: LIFECYCLE_RECORD.file },
  paused: true,
};

/** The frame a single-record run emits when it takes over from the lifecycle. */
const MANUAL_RUN = {
  type: "runStarted",
  file: "0009-manual.md",
  title: "Manual record",
  action: "resolving",
  manual: true,
};

beforeEach(() => {
  goal.records = [];
  goal.next = null;
  goal.goalText = "";
  goal.goalReady = true;
  goal.creationActive = false;
  goal.revisionActive = false;
  goal.skillsPrepActive = false;
  goal.runFile = null;
  goal.runTitle = null;
  goal.runState = "idle";
  goal.manualRunActive = false;
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
  goal.skills = [];
});

afterEach(() => cleanup());

function consoleView() {
  // The activity terminal schedules its first repaint on an animation frame,
  // and the test runtime's native-runtime restore leaves none behind.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
  const props = { tab: OVERVIEW, openTab: () => undefined, closeTab: () => undefined };
  return render(GoalWorkspace, { props });
}

test("a manual run that paused the lifecycle names its own record", async () => {
  const view = consoleView();
  goal.records = [LIFECYCLE_RECORD];

  goal.handleEvent(PAUSED_LIFECYCLE);
  // A paused lifecycle is live work of its own until the manual run starts.
  await waitFor(() => expect(view.getByTestId("stage-state").textContent).toBe("Paused"));
  expect(view.getByTestId("lifecycle-stages").textContent).toContain(LIFECYCLE_RECORD.title);

  goal.handleEvent(MANUAL_RUN);
  expect(goal.lifecycleActive).toBe(true);

  await waitFor(() => expect(view.getByTestId("stage-state").textContent).toBe("Manual run"));
  const track = view.getByTestId("lifecycle-stages").textContent ?? "";
  expect(track).toContain(MANUAL_RUN.title);
  expect(track).not.toContain(LIFECYCLE_RECORD.title);

  const now = view.getByTestId("now").textContent ?? "";
  expect(now).toContain(MANUAL_RUN.title);
});

test("a paused lifecycle with no manual run still reports Paused and its work item", async () => {
  const view = consoleView();
  goal.records = [LIFECYCLE_RECORD];

  goal.handleEvent(PAUSED_LIFECYCLE);

  await waitFor(() => expect(view.getByTestId("stage-state").textContent).toBe("Paused"));
  const track = view.getByTestId("lifecycle-stages").textContent ?? "";
  expect(track).toContain(LIFECYCLE_RECORD.title);
  expect(view.queryByTestId("now")).toBeNull();
});

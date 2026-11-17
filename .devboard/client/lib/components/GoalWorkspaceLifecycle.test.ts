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

/** A lifecycle frame reporting an implementation pass in flight. */
const RUNNING = {
  type: "lifecycleState",
  stage: "implementation",
  pass: 1,
  work: null,
  paused: false,
};

/** The idle lifecycle the reset's completion broadcast reports. */
const IDLE = { type: "lifecycleState", stage: "goal", pass: 1, work: null, paused: false };

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
  goal.resetArmed = false;
  goal.resetting = false;
  goal.resetStatus = null;
  goal.skills = [];
});

afterEach(() => cleanup());

function consoleView() {
  const props = { tab: OVERVIEW, openTab: () => undefined, closeTab: () => undefined };
  return render(GoalWorkspace, { props });
}

test("an idle lifecycle frame after an implementation frame renders Not started", async () => {
  const view = consoleView();

  goal.handleEvent(RUNNING);
  expect(goal.lifecycleSeen).toBe(true);
  await waitFor(() => expect(view.getByTestId("stage-state").textContent).toBe("Running"));
  expect(view.getByTestId("lifecycle-stages").textContent).toContain("Pass");

  // The reset finished and the server reported its idle lifecycle: nothing is
  // in flight, so the console may not keep the pass the reset discarded.
  goal.handleEvent(IDLE);
  expect(goal.lifecycleSeen).toBe(false);
  expect(goal.lifecycleActive).toBe(false);
  await waitFor(() =>
    expect(view.getByTestId("stage-state").textContent).toBe("Not started"),
  );
  expect(view.getByTestId("lifecycle-stages").textContent).not.toContain("Pass");
});

test("a completed reset leaves the stage track at Not started without a reload", async () => {
  const view = consoleView();
  goal.handleEvent(RUNNING);
  await waitFor(() => expect(view.getByTestId("stage-state").textContent).toBe("Running"));

  goal.handleEvent({ type: "implementationResetStarted" });
  goal.handleEvent({
    type: "implementationResetStopped",
    completed: true,
    commit: "abc1234",
  });
  // The reset owns this frame: every page hears the pass is back at goal.
  goal.handleEvent(IDLE);

  expect(goal.resetStatus).toBe("Reset committed as abc1234.");
  await waitFor(() =>
    expect(view.getByTestId("stage-state").textContent).toBe("Not started"),
  );
  expect(view.getByTestId("lifecycle-stages").textContent).not.toContain("Pass");
});

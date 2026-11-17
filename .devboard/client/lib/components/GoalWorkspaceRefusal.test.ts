import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The component and the testing library mount into the window happy-dom
// registers above, so they load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: GoalWorkspace } = await import("./GoalWorkspace.svelte");
const { connection } = await import("../connection.svelte");
const { goal } = await import("../goal.svelte");

/** The pending record whose page carries the Start control. */
const RECORD = {
  file: "a.md",
  title: "Adopt the fixture decision",
  status: "accepted",
  pending: true,
  summary: "Decide the fixture.",
};

const ADR_TAB = { id: "adr:a.md", kind: "adr", resourceId: "a.md", title: RECORD.title };

/** Stands in for the dispatch path: the test delivers the answer it expects. */
function recordSends(): { sent: unknown[]; restore: () => void } {
  const previous = connection.send;
  const sent: unknown[] = [];
  connection.send = (command: unknown) => {
    sent.push(command);
    return true;
  };
  return {
    sent,
    restore: () => {
      connection.send = previous;
    },
  };
}

beforeEach(() => {
  goal.records = [RECORD];
  goal.next = null;
  goal.runFile = null;
  goal.runTitle = null;
  goal.runState = "idle";
  goal.manualRunActive = false;
  goal.activity = [];
  goal.question = null;
  goal.draft = "";
  goal.lifecycle = { stage: "implementation", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = true;
});

afterEach(() => cleanup());

function adrView() {
  const props = { tab: ADR_TAB, openTab: () => undefined, closeTab: () => undefined };
  return render(GoalWorkspace, { props });
}

test("a refused Start clears its busy word and shows no ceiling notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = adrView();
    const start = view.getByTestId("start");
    await fireEvent.click(start);
    expect(sends.sent).toContainEqual({ type: "startRun", file: "a.md" });
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(start.textContent?.trim()).toBe("Starting…");

    // The server answered that dispatch by refusing it, and the frame names
    // the command it refused.
    connection.receiveFrame({
      type: "error",
      message: "The lifecycle is already resolving that ADR.",
      command: "startRun",
    });
    await Promise.resolve();
    expect(start.getAttribute("aria-busy")).toBeNull();
    expect(start.textContent?.trim()).toBe("Start this record");

    // The latch is gone, so the ceiling has nothing to report either.
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("another command's refusal leaves the Start control busy until the ceiling", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = adrView();
    const start = view.getByTestId("start");
    await fireEvent.click(start);
    expect(start.getAttribute("aria-busy")).toBe("true");

    // A refusal of the lifecycle toggle answers that control, never this one.
    connection.receiveFrame({
      type: "error",
      message: "The lifecycle is not running.",
      command: "stopLifecycle",
    });
    await Promise.resolve();
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(start.textContent?.trim()).toBe("Starting…");
    expect(view.queryByTestId("command-notice")).toBeNull();

    // Nothing answered this dispatch, so the ceiling still reports it.
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.getByTestId("command-notice").textContent).toContain(
      "Start this record received no answer.",
    );
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

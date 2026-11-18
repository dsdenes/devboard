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
const ADRS_TAB = { id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADR records" };
const DOCUMENT_TAB = {
  id: "goal-document",
  kind: "goal-document" as const,
  resourceId: "goal-document",
  title: "Goal document",
};
const SKILLS_TAB = { id: "skills", kind: "skills" as const, resourceId: "skills", title: "Skills" };

const globals = globalThis as unknown as Record<string, unknown>;

/** The dialog moves focus on the next animation frame, which this runtime lacks. */
function installFrameShim(): void {
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
}

/** No lifecycle pass or revision is in flight; controls gated by it stay enabled. */
function idleLifecycle(): void {
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
}

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

let previousState: typeof connection.state;

beforeEach(() => {
  installFrameShim();
  previousState = connection.state;
  // The controls that gate on `connection.open` are enabled in this suite.
  connection.state = "open";
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
  goal.goalReady = false;
  goal.creationActive = false;
  goal.revisionActive = false;
  goal.skillsPrepActive = false;
  goal.revisionRequest = "";
  goal.skills = [];
  goal.resetting = false;
  goal.resetStatus = null;
  goal.resetArmed = false;
});

afterEach(() => {
  cleanup();
  connection.state = previousState;
});

function adrView() {
  const props = { tab: ADR_TAB, openTab: () => undefined, closeTab: () => undefined };
  return render(GoalWorkspace, { props });
}

function mount(tab: typeof ADR_TAB | typeof ADRS_TAB | typeof DOCUMENT_TAB | typeof SKILLS_TAB) {
  return render(GoalWorkspace, {
    props: { tab, openTab: () => undefined, closeTab: () => undefined },
  });
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

test("a refused table Start clears its busy word and shows no ceiling notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = mount(ADRS_TAB);
    const start = view.getByTestId("start");
    await fireEvent.click(start);
    expect(sends.sent).toContainEqual({ type: "startRun", file: "a.md" });
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(start.textContent?.trim()).toBe("Starting…");

    connection.receiveFrame({
      type: "error",
      message: "Flow Mode is active. Finish or stop its work first.",
      command: "startRun",
    });
    await Promise.resolve();
    expect(start.getAttribute("aria-busy")).toBeNull();
    expect(start.textContent?.trim()).toBe("Start");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a refused Create goal settles at once and shows no ceiling notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = mount(DOCUMENT_TAB);
    const create = view.getByTestId("create-goal");
    await fireEvent.click(create);
    expect(sends.sent).toContainEqual({ type: "createGoal" });
    expect(create.getAttribute("aria-busy")).toBe("true");
    expect(create.textContent?.trim()).toBe("Creating…");

    connection.receiveFrame({
      type: "error",
      message: "Flow Mode is active. Finish or stop its work first.",
      command: "createGoal",
    });
    await Promise.resolve();
    expect(create.getAttribute("aria-busy")).toBeNull();
    expect(create.textContent?.trim()).toBe("Create goal");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("another command's refusal leaves Create goal busy until the ceiling", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = mount(DOCUMENT_TAB);
    const create = view.getByTestId("create-goal");
    await fireEvent.click(create);
    expect(create.getAttribute("aria-busy")).toBe("true");

    connection.receiveFrame({
      type: "error",
      message: "A goal revision is already active.",
      command: "reviseGoal",
    });
    await Promise.resolve();
    expect(create.getAttribute("aria-busy")).toBe("true");
    expect(create.textContent?.trim()).toBe("Creating…");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.getByTestId("command-notice").textContent).toContain(
      "Create goal received no answer.",
    );
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a refused Revise goal settles at once and shows no ceiling notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    idleLifecycle();
    const view = mount(DOCUMENT_TAB);
    const revise = view.getByTestId("revise-goal");
    await fireEvent.click(revise);
    expect(sends.sent).toContainEqual({ type: "reviseGoal" });
    expect(revise.getAttribute("aria-busy")).toBe("true");
    expect(revise.textContent?.trim()).toBe("Revising…");

    connection.receiveFrame({
      type: "error",
      message: "A goal revision is already active.",
      command: "reviseGoal",
    });
    await Promise.resolve();
    expect(revise.getAttribute("aria-busy")).toBeNull();
    expect(revise.textContent?.trim()).toBe("Revise goal");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a refused Prepare skills settles at once on the document page", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    goal.goalReady = true;
    idleLifecycle();
    const view = mount(DOCUMENT_TAB);
    const prepare = view.getByTestId("prepare-skills");
    await fireEvent.click(prepare);
    expect(sends.sent).toContainEqual({ type: "prepareSkills" });
    expect(prepare.getAttribute("aria-busy")).toBe("true");
    expect(prepare.textContent?.trim()).toBe("Preparing…");

    connection.receiveFrame({
      type: "error",
      message: "Flow Mode is active. Finish or stop its work first.",
      command: "prepareSkills",
    });
    await Promise.resolve();
    expect(prepare.getAttribute("aria-busy")).toBeNull();
    expect(prepare.textContent?.trim()).toBe("Prepare skills");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a refused Prepare skills again settles at once on the Skills page", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    goal.goalReady = true;
    goal.skills = [
      { name: "fixture-conventions", description: "Fixture.", family: "prepare", state: "generated" },
    ];
    idleLifecycle();
    const view = mount(SKILLS_TAB);
    const prepare = view.getByTestId("prepare-skills-overlay");
    await fireEvent.click(prepare);
    expect(sends.sent).toContainEqual({ type: "prepareSkills" });
    expect(prepare.getAttribute("aria-busy")).toBe("true");
    expect(prepare.textContent?.trim()).toBe("Preparing…");

    connection.receiveFrame({
      type: "error",
      message: "Flow Mode is active. Finish or stop its work first.",
      command: "prepareSkills",
    });
    await Promise.resolve();
    expect(prepare.getAttribute("aria-busy")).toBeNull();
    expect(prepare.textContent?.trim()).toBe("Prepare skills again");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a refused reset confirm settles at once and shows no ceiling notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    goal.resetArmed = true;
    const view = mount(ADRS_TAB);
    const dialog = view.getByTestId("reset-confirmation");
    const confirm = dialog.querySelector<HTMLButtonElement>(
      'button[data-command="goal.reset.confirm"]',
    );
    if (confirm === null) throw new Error("no Confirm reset control");

    await fireEvent.click(confirm);
    expect(sends.sent).toContainEqual({ type: "resetImplementation" });
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.textContent?.trim()).toBe("Confirming…");

    connection.receiveFrame({
      type: "error",
      message: "Reset is blocked while a Flow session is unmerged.",
      command: "resetImplementation",
    });
    await Promise.resolve();
    expect(confirm.getAttribute("aria-busy")).toBeNull();
    expect(confirm.textContent?.trim()).toBe("Confirm reset");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

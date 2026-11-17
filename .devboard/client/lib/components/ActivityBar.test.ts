import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

beforeEach(() => {
  // Moving focus onto a mode tab opens its tooltip, and the tooltip's presence
  // manager waits on a frame the test runtime's native-runtime restore leaves
  // behind. The runner resets the frame callbacks between tests, so the shim is
  // installed for each of them.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame = () => undefined;
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: ActivityBar } = await import("./ActivityBarHarness.svelte");
const { goal } = await import("../goal.svelte");
const { issues } = await import("../issues.svelte");
const { flow } = await import("../flow.svelte");
const { discover } = await import("../discover.svelte");
import type { IssuesAgent, IssuesLifecycle, IssuesSnapshot } from "../types";

function issuesSnapshot(lifecycle: IssuesLifecycle, agents: IssuesAgent[] = []): IssuesSnapshot {
  return {
    present: true,
    repo: "dsdenes/devboard",
    root: "/repo",
    lifecycle,
    enabled: true,
    paused: false,
    attached: false,
    worker: null,
    poll: null,
    queue: [],
    runs: [],
    agents,
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    updatedAt: null,
    notice: null,
  };
}

const { layout } = await import("../layout.svelte");

function modeTab(container: HTMLElement, mode: string): HTMLElement {
  const element = container.querySelector(`[data-testid="mode-${mode}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${mode} tab`);
  return element;
}

afterEach(() => {
  cleanup();
  layout.reset();
  goal.runState = "idle";
  goal.question = null;
  goal.lanes = [];
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
  issues.snapshot = null;
  flow.status = "none";
  flow.question = null;
  flow.blockers = [];
  discover.state = null;
  discover.active = false;
  discover.activeAgent = null;
  discover.runningAll = false;
  discover.allFailed = null;
  discover.question = null;
  discover.agentQuestions = {};
  discover.errorAgent = null;
  discover.activity = [];
});

test("a lane question marks Goal as needing attention while the lifecycle is paused", async () => {
  goal.lifecycle = { stage: "implementation", pass: 1, work: null, paused: true };
  goal.lifecycleSeen = true;
  goal.lanes = [
    {
      id: "lane-a",
      kind: "implementation",
      epic: { number: 7, title: "Epic", url: "" },
      record: null,
      attempt: 1,
      status: "running",
      activity: [],
      question: { id: "lane-q", message: "Which epic?", options: [] },
    },
  ];
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-goal"]');
  expect(tab?.getAttribute("aria-label")).toBe("Goal (Alt+1), needs attention");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("attention");
});

test("a finished manual run leaves a resumed lifecycle's Goal tab running", async () => {
  // The server resumes the lifecycle after a manual sequence it interrupted, so
  // this is the ordinary end state of `Resolve next ADR` on a live lifecycle.
  goal.runState = "stopped";
  goal.lifecycle = { stage: "implementation", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = true;
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-goal"]');
  expect(tab?.getAttribute("aria-label")).toBe("Goal (Alt+1), work running");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("running");
});

test("a stopped manual run without a lifecycle still needs attention", async () => {
  // No lifecycle is live, so the console's run-stopped notice is the surface
  // that reports the run, and the rail agrees with it.
  goal.runState = "stopped";
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-goal"]');
  expect(tab?.getAttribute("aria-label")).toBe("Goal (Alt+1), needs attention");
  expect(goal.lifecycleActive).toBe(false);
});

test("a waiting Issues agent question marks the tab as needing attention", async () => {
  // The running family is the ordinary state while an agent asks its question:
  // the question still owns the rail's one cross-mode attention cue.
  issues.snapshot = issuesSnapshot("running", [
    {
      runId: "run-1",
      issueNumber: 2067,
      startedAt: "2026-11-17T00:00:00Z",
      question: { id: 1, message: "Which issue?", options: [] },
      acp: null,
    },
  ]);
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-issues"]');
  expect(tab?.getAttribute("aria-label")).toBe("Issues (Alt+2), needs attention");
  expect(tab?.getAttribute("title")).toBe("Issues — Alt+2, needs attention");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("attention");
});

test("a running Issues family without a question still reads work running", async () => {
  issues.snapshot = issuesSnapshot("running", [
    {
      runId: "run-1",
      issueNumber: 2067,
      startedAt: "2026-11-17T00:00:00Z",
      question: null,
      acp: null,
    },
  ]);
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-issues"]');
  expect(tab?.getAttribute("aria-label")).toBe("Issues (Alt+2), work running");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("running");
});

test("a Flow question marks the tab as needing attention while the session runs", async () => {
  flow.status = "running";
  flow.question = { id: 1, message: "Approve the plan?", options: [] };
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-flow"]');
  expect(tab?.getAttribute("aria-label")).toBe("Flow (Alt+3), needs attention");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("attention");
});

test("a running Flow session without a question reads work running", async () => {
  flow.status = "running";
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-flow"]');
  expect(tab?.getAttribute("aria-label")).toBe("Flow (Alt+3), work running");
});

test("a Discover question marks the tab as needing attention while the run is live", async () => {
  discover.active = true;
  discover.question = { id: 1, message: "Which context?", options: [] };
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-discover"]');
  expect(tab?.getAttribute("aria-label")).toBe("Discover (Alt+4), needs attention");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("attention");
});

test("a single Discover agent's question reaches the rail on a live run", async () => {
  discover.active = true;
  discover.agentQuestions = {
    "discover-glossary": { id: 2, message: "Which term?", options: [] },
  };
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-discover"]');
  expect(tab?.getAttribute("aria-label")).toBe("Discover (Alt+4), needs attention");
});

test("a failed Discover agent needs attention when no run is live", async () => {
  discover.errorAgent = "discover-contribution";
  const view = render(ActivityBar);
  await tick();
  const tab = view.container.querySelector('[data-testid="mode-discover"]');
  expect(tab?.getAttribute("aria-label")).toBe("Discover (Alt+4), needs attention");
  expect(tab?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("attention");
});
test("the tablist holds one Tab stop, carried by the selected mode's tab", async () => {
  const view = render(ActivityBar);
  await tick();
  const stops = (): (string | null)[] =>
    [...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("tabindex"));
  expect(stops()).toEqual(["0", "-1", "-1", "-1", "-1"]);

  layout.setMode("flow");
  await tick();
  expect(stops()).toEqual(["-1", "-1", "0", "-1", "-1"]);
});

test("arrow keys move focus and selection, wrapping at both ends", async () => {
  const view = render(ActivityBar);
  await tick();

  modeTab(view.container, "goal").focus();
  await fireEvent.keyDown(modeTab(view.container, "goal"), { key: "ArrowDown" });
  expect(layout.mode).toBe("issues");
  expect(document.activeElement?.id).toBe("mode-issues-tab");

  await fireEvent.keyDown(modeTab(view.container, "issues"), { key: "ArrowRight" });
  expect(layout.mode).toBe("flow");
  expect(document.activeElement?.id).toBe("mode-flow-tab");

  await fireEvent.keyDown(modeTab(view.container, "goal"), { key: "ArrowUp" });
  expect(layout.mode).toBe("devboard");
  expect(document.activeElement?.id).toBe("mode-devboard-tab");

  await fireEvent.keyDown(modeTab(view.container, "devboard"), { key: "ArrowLeft" });
  expect(layout.mode).toBe("discover");
  expect(document.activeElement?.id).toBe("mode-discover-tab");
});

test("Home and End move focus and selection to the first and last tabs", async () => {
  const view = render(ActivityBar);
  await tick();
  layout.setMode("flow");
  await tick();

  await fireEvent.keyDown(modeTab(view.container, "flow"), { key: "Home" });
  expect(layout.mode).toBe("goal");
  expect(document.activeElement?.id).toBe("mode-goal-tab");

  await fireEvent.keyDown(modeTab(view.container, "goal"), { key: "End" });
  expect(layout.mode).toBe("devboard");
  expect(document.activeElement?.id).toBe("mode-devboard-tab");
});

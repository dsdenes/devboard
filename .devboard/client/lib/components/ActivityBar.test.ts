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
// the stores load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: ActivityBar } = await import("./ActivityBarHarness.svelte");
const { goal } = await import("../goal.svelte");

afterEach(() => {
  cleanup();
  goal.runState = "idle";
  goal.question = null;
  goal.lanes = [];
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
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

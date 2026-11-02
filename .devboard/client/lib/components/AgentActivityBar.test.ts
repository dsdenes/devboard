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
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { createRawSnippet, tick } = await import("svelte");
const { default: AgentActivityBar } = await import("./AgentActivityBar.svelte");

afterEach(() => {
  cleanup();
});

const control = createRawSnippet(() => ({
  render: () => '<button type="button" data-testid="test-control">Start</button>',
}));

test("one collapsed row carries the dot, last line, toggle, and control slot", async () => {
  const view = render(AgentActivityBar, {
    props: {
      identity: "mode:page",
      label: "Synthetic agent",
      status: "idle",
      activity: [],
      control,
    },
  });
  const bar = within(view.container).getByTestId("agent-activity-bar");
  expect(view.container.querySelectorAll('[data-testid="agent-activity-bar"]').length).toBe(1);
  const dot = within(bar).getByTestId("agent-activity-dot");
  expect(dot.getAttribute("data-state")).toBe("idle");
  expect(dot.textContent).toBe("");
  expect(dot.getAttribute("role")).toBe("img");
  expect(within(bar).getByTestId("agent-activity-last").textContent?.trim()).toBe(
    "No activity yet.",
  );
  const toggle = within(bar).getByTestId("agent-activity-toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(bar).getByTestId("agent-activity-control").textContent).toContain("Start");
  expect(within(bar).queryByTestId("agent-activity-question")).toBeNull();
  expect(within(bar).queryByTestId("agent-activity-log")).toBeNull();
});

test("the newest line, the start time, and the question marker follow the data", async () => {
  const view = render(AgentActivityBar, {
    props: {
      identity: "mode:page",
      label: "Synthetic agent",
      status: "running",
      activity: ["first line", "newest line"],
      startedAt: "2026-11-01T10:00:00.000Z",
      waiting: true,
    },
  });
  const bar = within(view.container).getByTestId("agent-activity-bar");
  const last = within(bar).getByTestId("agent-activity-last");
  expect(last.textContent?.trim()).toBe("newest line");
  expect(last.getAttribute("title")).toBe("newest line");
  const dot = within(bar).getByTestId("agent-activity-dot");
  expect(dot.getAttribute("data-state")).toBe("running");
  expect(dot.getAttribute("title")).toBe("2026-11-01T10:00:00.000Z");
  expect(dot.getAttribute("aria-label")).toContain("2026-11-01T10:00:00.000Z");
  expect(within(bar).getByTestId("agent-activity-question")).not.toBeNull();
});

test("the toggle expands every line and a new identity collapses it", async () => {
  const view = render(AgentActivityBar, {
    props: {
      identity: "mode:one",
      label: "Synthetic agent",
      status: "succeeded",
      activity: ["first line", "second line", "third line"],
    },
  });
  const bar = within(view.container).getByTestId("agent-activity-bar");
  const toggle = within(bar).getByTestId("agent-activity-toggle");
  await fireEvent.click(toggle);
  await tick();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const log = within(bar).getByTestId("agent-activity-log");
  const lines = log.querySelectorAll(".agent-activity-bar__line");
  expect(lines.length).toBe(3);
  expect(log.textContent).toContain("third line");
  await fireEvent.click(toggle);
  await tick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(bar).queryByTestId("agent-activity-log")).toBeNull();

  await fireEvent.click(toggle);
  await tick();
  expect(within(bar).getByTestId("agent-activity-log")).not.toBeNull();
  await view.rerender({
    identity: "mode:two",
    label: "Synthetic agent",
    status: "idle",
    activity: ["another line"],
  });
  await tick();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(bar).queryByTestId("agent-activity-log")).toBeNull();
});

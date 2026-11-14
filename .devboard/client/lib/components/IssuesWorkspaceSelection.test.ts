import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");

/** The overview tab, which carries the running-agent rows. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** A snapshot that lists two open issues worked by two running agents. */
function snapshot(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    queue: [
      {
        number: 42,
        title: "Issue 42",
        url: "https://tracker.test/issues/42",
        createdAt: "2026-11-01T00:00:00Z",
        labels: [],
        handled: false,
        runId: null,
        agentRunId: "run-42",
      },
      {
        number: 43,
        title: "Issue 43",
        url: "https://tracker.test/issues/43",
        createdAt: "2026-11-01T00:00:00Z",
        labels: [],
        handled: false,
        runId: null,
        agentRunId: "run-43",
      },
    ],
    runs: [],
    agents: [
      {
        runId: "run-42",
        issueNumber: 42,
        startedAt: "2026-11-01T00:00:00Z",
        question: null,
        acp: null,
      },
      {
        runId: "run-43",
        issueNumber: 43,
        startedAt: "2026-11-01T00:00:01Z",
        question: null,
        acp: null,
      },
    ],
  };
}

function openButton(view: { container: HTMLElement }, runId: string): HTMLElement {
  const button = view.container.querySelector<HTMLElement>(
    `.issues-agent-row__open[data-run="${runId}"]`,
  );
  if (button === null) throw new Error(`no open control for ${runId}`);
  return button;
}

function row(view: { container: HTMLElement }, runId: string): HTMLElement {
  const element = view.container.querySelector<HTMLElement>(`.issues-agent-row[data-run="${runId}"]`);
  if (element === null) throw new Error(`no row for ${runId}`);
  return element;
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("the selected running-agent row announces its selection on the focusable control", async () => {
  issues.handleEvent(snapshot());

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  // The first live agent owns the output pane until the operator selects one.
  expect(openButton(view, "run-42").getAttribute("aria-current")).toBe("true");
  expect(openButton(view, "run-43").getAttribute("aria-current")).toBeNull();
  expect(
    view.container.querySelectorAll('.issues-agent-row__open[aria-current="true"]').length,
  ).toBe(1);

  // The row is layout only; the accent styling reads its own marker.
  expect(row(view, "run-42").getAttribute("data-current")).toBe("true");
  expect(row(view, "run-42").getAttribute("aria-current")).toBeNull();
  expect(row(view, "run-43").getAttribute("data-current")).toBeNull();

  await fireEvent.click(openButton(view, "run-43"));

  expect(openButton(view, "run-43").getAttribute("aria-current")).toBe("true");
  expect(openButton(view, "run-42").getAttribute("aria-current")).toBeNull();
  expect(row(view, "run-43").getAttribute("data-current")).toBe("true");
  expect(row(view, "run-42").getAttribute("data-current")).toBeNull();
});

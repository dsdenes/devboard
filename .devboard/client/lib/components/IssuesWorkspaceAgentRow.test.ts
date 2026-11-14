import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render, within } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");

/** The overview tab, which holds the running-agent rows. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** The page's clock while the row is on screen: five seconds into the run. */
const NOW = new Date("2026-11-01T00:00:05Z");

const QUESTION = {
  id: 7,
  message: "Which branch should the close land on?",
  options: [{ label: "main", recommended: true }],
};

/** A snapshot that lists one open issue worked by one running agent. */
function state(question: unknown): Record<string, unknown> {
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
    ],
    runs: [],
    agents: [
      {
        runId: "run-42",
        issueNumber: 42,
        startedAt: "2026-11-01T00:00:00Z",
        question,
        acp: null,
      },
    ],
  };
}

/** The one running-agent row, read by the run it names. */
function row(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.issues-agent-row[data-run="run-42"]');
  if (found === null) throw new Error("the running-agent row did not render");
  return found;
}

/** The row's elapsed cell, the only per-second text on the surface. */
function elapsed(container: HTMLElement): string {
  return within(row(container)).getByTestId("issues-agent-row-elapsed").textContent?.trim() ?? "";
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("the row badges an open question and keeps its elapsed value ticking once answered", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  try {
    issues.handleEvent(state(null));
    const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
    await Promise.resolve();

    // An agent with no question carries no badge, and the cell states its age.
    expect(within(row(view.container)).queryByText("needs answer")).toBeNull();
    expect(elapsed(view.container)).toBe("5s");

    // The same agent now waits on a question: the row names that state once.
    issues.handleEvent(state(QUESTION));
    await Promise.resolve();
    expect(within(row(view.container)).getByText("needs answer").textContent?.trim()).toBe(
      "needs answer",
    );
    expect(elapsed(view.container)).toBe("5s");

    // The page's own clock advances the cell; nothing else writes that text.
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(elapsed(view.container)).toBe("1m");

    // The answer clears the badge while the advanced elapsed value stays.
    issues.handleEvent(state(null));
    await Promise.resolve();
    expect(within(row(view.container)).queryByText("needs answer")).toBeNull();
    expect(elapsed(view.container)).toBe("1m");
  } finally {
    jest.useRealTimers();
  }
});

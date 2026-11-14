import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { cleanup, render } = await import("@testing-library/svelte");
const { default: IssuesAgentFocus } = await import("./components/IssuesAgentFocus.svelte");
const { issues } = await import("./issues.svelte");

afterEach(() => {
  cleanup();
  issues.snapshot = null;
  issues.run = null;
  issues.agentActivity = {};
});

function liveState(runId: string): void {
  issues.snapshot = {
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    paused: false,
    queue: [],
    runs: [],
    agents: [
      {
        runId,
        issueNumber: 7,
        startedAt: "2026-11-14T10:00:00.000Z",
        question: null,
      },
    ],
  } as unknown as NonNullable<typeof issues.snapshot>;
}

/**
 * A live agent's page shows the run's whole log, not the newest lines the
 * Issues state read carries.
 *
 * The state read is polled every two seconds and carries a bounded preview of
 * each running agent, so the page it feeds would otherwise show 50 lines of a
 * log that reaches 1 MiB.
 */
test("a live agent's page shows the run's whole log", async () => {
  const runId = "run-1";
  const whole = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  liveState(runId);
  issues.agentActivity = { [runId]: whole.slice(-2) };
  issues.run = {
    runId,
    status: "running",
    activityLines: whole,
  } as unknown as NonNullable<typeof issues.run>;

  const view = render(IssuesAgentFocus, {
    props: {
      tab: { id: "agent:run-1", kind: "agent", resourceId: runId, title: "#7" },
      close: () => undefined,
      openRuns: () => undefined,
    },
  });
  const log = await view.findByTestId("issues-agent-focus-activity");
  const rendered = Array.from(log.querySelectorAll(".issues-activity__line")).map(
    (line) => line.textContent ?? "",
  );
  expect(rendered).toEqual(whole);

  // Before the run read lands the page still shows the preview it has.
  issues.run = null;
  expect(view.getByTestId("issues-agent-focus-activity").textContent).toContain("line 199");
});

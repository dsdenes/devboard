import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { connection } = await import("../connection.svelte");
const { issues } = await import("../issues.svelte");

/** The Runs tab, which carries the run list and its detail panel. */
const RUNS = { id: "runs", kind: "runs", resourceId: "runs", title: "Runs" };

/** A snapshot naming one finished run, overlaid with the fields a test needs. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    root: "/repo",
    lifecycle: "stopped",
    enabled: false,
    paused: false,
    attached: false,
    worker: null,
    poll: {
      intervalMs: 10000,
      lastPollAt: "2026-11-10T20:00:00.000Z",
      nextPollAt: "2026-11-10T20:00:10.000Z",
      etag: null,
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue: [],
    runs: [
      {
        runId: "run-42",
        status: "finished",
        startedAt: "2026-11-10T19:00:00.000Z",
        finishedAt: "2026-11-10T19:04:00.000Z",
        exitCode: 0,
        issueNumbers: [42],
        activity: 2,
        firstStderrLine: null,
        harnessVersion: "1.45.0",
      },
    ],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: 0,
    finishedAt: "2026-11-10T19:04:00.000Z",
    notice: null,
    updatedAt: "2026-11-10T19:04:00.000Z",
    workers: [],
    sync: { intervalMs: 30000, lastSyncAt: "2026-11-10T19:04:00.000Z", error: null },
    ...overrides,
  };
}

function detail(activityLines: string[]): Record<string, unknown> {
  const [summary] = snapshot().runs as Record<string, unknown>[];
  return {
    ...summary,
    repo: "acme/app",
    argv: ["omp", "acp"],
    cwd: "/repo",
    issues: [{ number: 42, title: "Fix the runs activity" }],
    workerPid: 4242,
    activityLines,
  };
}

function resetRunState(): void {
  issues.snapshot = null;
  issues.agentActivity = {};
  issues.run = null;
  issues.missingRun = null;
  issues.selectedRun = null;
}

afterEach(() => {
  cleanup();
  resetRunState();
  connection.state = "connecting";
});

test("runs detail renders a command line as the shared log renders it", () => {
  issues.handleEvent(snapshot());
  issues.run = detail(["$ cargo test", "2 passed"]) as never;

  const view = render(IssuesWorkspace, { props: { tab: RUNS } });

  const log = view.getByTestId("issues-run-activity");
  expect(log.getAttribute("data-run")).toBe("run-42");
  const command = log.querySelector('.issues-activity__line[data-kind="command"]');
  expect(command).not.toBeNull();
  expect(command?.querySelector(".issues-activity__prompt")?.textContent).toBe("$");
  expect(command?.textContent).toBe("$ cargo test");
  expect(log.textContent).toBe("$ cargo test\n2 passed");
});

test("a run with no retained lines shows the shared empty state", () => {
  issues.handleEvent(snapshot());
  issues.run = detail([]) as never;

  const view = render(IssuesWorkspace, { props: { tab: RUNS } });

  expect(view.getByTestId("issues-run-activity").textContent?.trim()).toBe("No activity yet.");
});

test("a run whose history is gone says why, and another selection clears it", async () => {
  connection.state = "open";
  const [first] = snapshot().runs as Record<string, unknown>[];
  issues.handleEvent(snapshot({ runs: [first, { ...first, runId: "run-43", issueNumbers: [43] }] }));

  const view = render(IssuesWorkspace, { props: { tab: RUNS } });
  const rowFor = (runId: string): HTMLElement => {
    const row = view.container.querySelector(`[data-testid="issues-run"][data-run="${runId}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`no run row ${runId}`);
    return row;
  };
  expect(view.getAllByTestId("issues-run").length).toBe(2);

  await fireEvent.click(rowFor("run-42"));
  issues.handleEvent({
    type: "issuesRunMissing",
    runId: "run-42",
    message: "No such issues run.",
  });

  const unavailable = await view.findByTestId("issues-run-unavailable");
  expect(unavailable.getAttribute("data-run")).toBe("run-42");
  expect(unavailable.textContent).toContain("This run is no longer available in run history.");
  expect(view.queryByTestId("issues-run-detail")).toBeNull();
  expect(view.getAllByTestId("issues-run").length).toBe(2);

  await fireEvent.click(rowFor("run-43"));
  expect(view.queryByTestId("issues-run-unavailable")).toBeNull();
  expect(view.getByTestId("issues-run-loading").getAttribute("data-run")).toBe("run-43");
});

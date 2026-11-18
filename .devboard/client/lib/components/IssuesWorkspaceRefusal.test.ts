import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The component and the testing library mount into the window happy-dom
// registers above, so they load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { connection } = await import("../connection.svelte");
const { issues } = await import("../issues.svelte");

/** The overview tab, which carries the Automation panel. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** The refusal a lifecycle command answers with when the worker never took it. */
const REFUSAL = "The worker exited before the command reached it.";

/** A live worker's snapshot: every Automation control but Resume is offered. */
function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    paused: false,
    attached: true,
    worker: null,
    poll: null,
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    deferral: null,
    starting: false,
    startError: null,
    updatedAt: "2026-11-18T00:00:00.000Z",
    workers: [],
    ...overrides,
  };
}

/** One Automation control and the frame that refuses its command. */
interface Control {
  testid: string;
  command: string;
  label: string;
  busy: string;
  snapshot: Record<string, unknown>;
}

const CONTROLS: Control[] = [
  { testid: "issues-pause", command: "pauseIssues", label: "Pause", busy: "Pausing…", snapshot: state() },
  {
    testid: "issues-resume",
    command: "resumeIssues",
    label: "Resume",
    busy: "Resuming…",
    snapshot: state({ lifecycle: "paused", paused: true }),
  },
  { testid: "issues-stop", command: "stopIssues", label: "Stop", busy: "Stopping…", snapshot: state() },
  {
    testid: "issues-check-now",
    command: "checkIssues",
    label: "Check now",
    busy: "Checking…",
    snapshot: state(),
  },
];

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

connection.onMessage((message) => {
  issues.handleEvent(message as Record<string, unknown>);
});

beforeEach(() => {
  // The controls gate on `connection.open`, which is the transport's own state.
  connection.state = "open";
});

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

for (const control of CONTROLS) {
  test(`a refused ${control.label} rests its control without the ceiling notice`, async () => {
    const sends = recordSends();
    jest.useFakeTimers();
    try {
      issues.snapshot = control.snapshot as never;
      const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
      const button = view.getByTestId(control.testid);

      await fireEvent.click(button);
      expect(sends.sent).toContainEqual(
        expect.objectContaining({ type: control.command }),
      );
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.textContent?.trim()).toBe(control.busy);

      // The server refused the command in the lone `error` frame, which names
      // the command it refused; the snapshot never changed.
      connection.receiveFrame({ type: "error", message: REFUSAL, command: control.command });
      await Promise.resolve();

      expect(button.getAttribute("aria-busy")).toBeNull();
      expect(button.textContent?.trim()).toBe(control.label);
      expect(view.queryByTestId("command-notice")).toBeNull();

      // The refusal is the answer: the ceiling has nothing left to report.
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(view.queryByTestId("command-notice")).toBeNull();
    } finally {
      jest.useRealTimers();
      sends.restore();
    }
  });
}

test("another command's refusal leaves Pause waiting for its own answer", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    issues.snapshot = state() as never;
    const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
    const button = view.getByTestId("issues-pause");

    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    // A refused check answers the Check now control, never this one.
    connection.receiveFrame({ type: "error", message: REFUSAL, command: "checkIssues" });
    await Promise.resolve();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("Pausing…");

    // Nothing answered Pause, so its ceiling still reports that.
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.getByTestId("command-notice").textContent).toContain("Pause received no answer.");
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

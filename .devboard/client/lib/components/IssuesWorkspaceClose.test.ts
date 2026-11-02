import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so each dispatched command is readable. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeEnvelope) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { connection } = await import("../connection.svelte");
const { issues } = await import("../issues.svelte");

/** The overview tab, which holds the running-agent rows. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** A snapshot that lists one open issue worked by one running agent. */
function state(): Record<string, unknown> {
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
        question: null,
        acp: null,
      },
    ],
  };
}

connection.onMessage((message) => {
  issues.handleEvent(message as Record<string, unknown>);
});

afterEach(() => {
  cleanup();
  connection.dispose();
  FakeSocket.instances = [];
});

test("a refused close rests the row's control at once and takes a retry", async () => {
  // The preload restores the native WebSocket before every test.
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  socket.deliver(state());

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
  await view.findByTestId("issues-close-issue");

  expect(view.getByTestId("issues-close-issue").textContent?.trim()).toBe("Close");
  await fireEvent.click(view.getByTestId("issues-close-issue"));
  expect(view.getByTestId("issues-close-issue").textContent?.trim()).toBe("Closing…");
  expect(socket.sent.filter((frame) => frame.includes('"closeIssue"')).length).toBe(1);

  // The server answered: the reason arrives, and the issue stays queued, so
  // the latching evidence is this frame's close revision rather than the queue.
  socket.deliver({
    type: "issuesClosed",
    number: 42,
    ok: false,
    message: "the forge refused the close",
  });
  await view.findByText("Close");

  expect(view.getByTestId("issues-close-issue").textContent?.trim()).toBe("Close");
  expect(view.queryByTestId("command-notice")).toBeNull();
  expect(view.getByTestId("issues-close-issue").hasAttribute("disabled")).toBe(false);

  // The refused issue stays queued, and the row dispatches the retry at once.
  await fireEvent.click(view.getByTestId("issues-close-issue"));
  expect(view.getByTestId("issues-close-issue").textContent?.trim()).toBe("Closing…");
  expect(socket.sent.filter((frame) => frame.includes('"closeIssue"')).length).toBe(2);
});

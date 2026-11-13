import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so a closed connection is observable. */
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
const { default: IssuesWorkspace } = await import("./components/IssuesWorkspace.svelte");
const { connection } = await import("./connection.svelte");
const { issues } = await import("./issues.svelte");

/** The overview tab, which carries the Automation panel. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** A running snapshot, so every control has a subject to act on. */
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
    starting: false,
    startError: null,
    deferral: null,
    updatedAt: "2026-11-13T00:00:00.000Z",
    workers: [],
    ...overrides,
  };
}

connection.onMessage((message) => {
  issues.handleEvent(message as Record<string, unknown>);
});

afterEach(() => {
  cleanup();
  connection.dispose();
  issues.snapshot = null;
  FakeSocket.instances = [];
});

/** A page whose socket opened, received its state, then closed. */
function closeConnection(): void {
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  socket.deliver(state());
  socket.close();
}

test("a closed connection refuses every Issues command and changes no state", () => {
  closeConnection();
  expect(connection.open).toBe(false);
  const before = issues.snapshot;

  expect(issues.start()).toBe(false);
  expect(issues.pause()).toBe(false);
  expect(issues.resume()).toBe(false);
  expect(issues.stop()).toBe(false);
  expect(issues.check()).toBe(false);

  // A command that never went out cannot have answered: the projection the
  // page shows is the one it already had.
  expect(issues.snapshot).toBe(before);
});

test("a refused dispatch shows neither a busy word nor a ceiling notice", async () => {
  closeConnection();
  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
  await view.findByTestId("issues-pause");

  // Start is unavailable without a socket, so Pause is the control that
  // proves the refusal path: its command returns false and the label rests.
  expect(view.getByTestId("issues-start").hasAttribute("disabled")).toBe(true);
  await fireEvent.click(view.getByTestId("issues-pause"));
  expect(view.getByTestId("issues-pause").textContent?.trim()).toBe("Pause");
  expect(view.getByTestId("issues-pause").hasAttribute("aria-busy")).toBe(false);
  expect(view.queryByTestId("command-notice")).toBeNull();

  await fireEvent.click(view.getByTestId("issues-stop"));
  expect(view.getByTestId("issues-stop").textContent?.trim()).toBe("Stop");
  expect(view.queryByTestId("command-notice")).toBeNull();
});

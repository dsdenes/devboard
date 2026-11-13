import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so the Start's dispatch is observable. */
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

/** The overview tab, which carries the Automation panel. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

const REFUSAL =
  "this checkout already has an issues worker (pid 4242) using /elsewhere/state; " +
  "this dashboard's STATE_DIR is /repo/state";

/** A stopped snapshot: the state Start is pressed from. */
function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "stopped",
    enabled: false,
    paused: false,
    attached: false,
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

/** The worker record a start names, synthesized by the dashboard or published. */
function workerRecord(): Record<string, unknown> {
  return {
    pid: 4242,
    startedAt: "2026-11-13T00:00:01.000Z",
    stateDir: "/repo/state",
    harnessVersion: "1.48.0",
    argv: [],
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

/** Opens the page and presses Start, returning the rendered panel and socket. */
async function pressStart() {
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  socket.deliver(state());

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });
  await view.findByTestId("issues-start");
  const start = view.getByTestId("issues-start");
  await fireEvent.click(start);
  return { view, socket, start };
}

test("a refused Start stays on the card and never raises the ceiling notice", async () => {
  jest.useFakeTimers();
  try {
    const { view, socket } = await pressStart();
    expect(socket.sent.filter((frame) => frame.includes('"startIssues"')).length).toBe(1);

    // The server answered with the state that names the refusal.
    socket.deliver(state({ startError: REFUSAL }));
    await view.findByTestId("issues-start-error");

    expect(view.getByTestId("issues-start-error").textContent?.trim()).toBe(REFUSAL);
    expect(view.getByTestId("issues-start-error").getAttribute("role")).toBe("alert");
    // The answer released the control: no busy word and no ceiling notice.
    expect(view.getByTestId("issues-start").textContent?.trim()).toBe("Start");
    expect(view.getByTestId("issues-start").hasAttribute("aria-busy")).toBe(false);
    expect(view.queryByTestId("command-notice")).toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(view.queryByTestId("command-notice")).toBeNull();

    // A later read repeats the same state: the answer stays on the panel.
    socket.deliver(state({ startError: REFUSAL }));
    await view.findByTestId("issues-start-error");
    expect(view.getByTestId("issues-start-error").textContent?.trim()).toBe(REFUSAL);
    expect(view.getByTestId("issues-start").hasAttribute("disabled")).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("a started worker is shown by its pid and Start rests disabled", async () => {
  const { view, socket } = await pressStart();

  // The accepted answer names the start in flight.
  socket.deliver(state({ starting: true }));
  await view.findByTestId("issues-start");
  expect(view.getByTestId("issues-start").hasAttribute("disabled")).toBe(true);

  // The dashboard names the worker it spawned before that worker publishes.
  socket.deliver(state({ starting: true, worker: workerRecord() }));
  await view.findByTestId("issues-worker-pid");
  expect(view.getByTestId("issues-worker-pid").textContent).toContain("pid 4242");
  expect(view.getByTestId("issues-start").hasAttribute("disabled")).toBe(true);

  // The worker publishes the state that settles the start.
  socket.deliver(
    state({
      enabled: true,
      lifecycle: "running",
      attached: true,
      starting: false,
      worker: workerRecord(),
    }),
  );
  await view.findByTestId("issues-worker-pid");

  expect(view.getByTestId("issues-worker-pid").textContent).toContain("pid 4242");
  expect(view.queryByTestId("issues-start-error")).toBeNull();
  expect(view.getByTestId("issues-start").textContent?.trim()).toBe("Start");
  expect(view.getByTestId("issues-start").hasAttribute("aria-busy")).toBe(false);
  expect(view.getByTestId("issues-start").hasAttribute("disabled")).toBe(true);
  expect(view.queryByTestId("command-notice")).toBeNull();
});

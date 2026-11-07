import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { agents, AgentsStore } = await import("./agents.svelte");
const { createCommandBusy } = await import("./command-busy.svelte");
const { connection } = await import("./connection.svelte");
const { default: AgentPage } = await import("./components/AgentPage.svelte");

const REFUSAL =
  "Start did nothing: the Dead Code worker (pid 42) is already running for this dashboard.";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket: the frames the page sends are explicit. */
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
}

const originalGlobals = {
  WebSocket: (globalThis as unknown as Record<string, unknown>).WebSocket,
  window: (globalThis as unknown as Record<string, unknown>).window,
  location: (globalThis as unknown as Record<string, unknown>).location,
};

function installGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  target.WebSocket = FakeSocket;
  target.window = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  target.location = { protocol: "http:", host: "test.invalid" };
}

function restoreGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

function openSocket(): FakeSocket {
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

/** The snapshot the Dead Code page reads before its Start is answered. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dead-code",
    label: "Dead Code",
    description: "",
    scope: "repository",
    lifecycle: "stopped",
    paused: false,
    enabled: false,
    owned: false,
    attached: false,
    cadence: { minutes: 60, defaultMinutes: 60, lastRunAt: null, nextRunAt: null },
    limits: { maxPerHour: 10, maxPending: 5 },
    issues: [],
    documentation: [],
    releases: [],
    pending: 0,
    sync: { state: "ok", at: null, error: null },
    detail: { panel: "activity", scanId: "idle:0", entries: [] },
    notice: null,
    error: null,
    timer: null,
    workers: [],
    ...overrides,
  };
}

afterEach(() => {
  FakeSocket.instances = [];
  connection.dispose();
  restoreGlobals();
  cleanup();
});

test("a refusal frame releases the Start latch without the ceiling notice", () => {
  const store = new AgentsStore();
  const busy = createCommandBusy({
    label: "Start",
    evidence: () => store.revision("dead-code"),
  });

  busy.start();
  expect(busy.busy).toBe(true);

  store.handleEvent({ type: "agentState", agent: snapshot({ notice: REFUSAL }) });

  expect(busy.busy).toBe(false);
  expect(busy.notice).toBeNull();
});

test("a starting frame releases the Start latch the same way", () => {
  const store = new AgentsStore();
  const busy = createCommandBusy({
    label: "Start",
    evidence: () => store.revision("dead-code"),
  });

  busy.start();
  store.handleEvent({ type: "agentState", agent: snapshot({ lifecycle: "starting" }) });

  expect(busy.busy).toBe(false);
  expect(busy.notice).toBeNull();
});

test("the page renders the refusal and never claims Start received no answer", async () => {
  installGlobals();
  const socket = openSocket();
  agents.handleEvent({ type: "agentState", agent: snapshot() });

  const view = render(AgentPage, { props: { agentId: "dead-code" } });
  const start = within(view.container).getByTestId("agent-start");
  expect(start.hasAttribute("disabled")).toBe(false);

  await fireEvent.click(start);
  expect(start.getAttribute("aria-busy")).toBe("true");
  expect(socket.sent).toContain(JSON.stringify({ type: "startAgent", id: "dead-code" }));

  agents.handleEvent({ type: "agentState", agent: snapshot({ notice: REFUSAL }) });
  await tick();
  await Promise.resolve();

  expect(start.getAttribute("aria-busy")).toBeNull();
  expect(start.textContent?.trim()).toBe("Start");
  const notice = within(view.container).getByTestId("agent-notice");
  expect(notice.textContent).toContain("already running");
  expect(view.container.textContent).not.toContain("Start received no answer.");
});

test("a starting frame leaves the page neither busy nor waiting for the ceiling", async () => {
  installGlobals();
  openSocket();
  agents.handleEvent({ type: "agentState", agent: snapshot() });

  const view = render(AgentPage, { props: { agentId: "dead-code" } });
  const start = within(view.container).getByTestId("agent-start");

  await fireEvent.click(start);
  agents.handleEvent({ type: "agentState", agent: snapshot({ lifecycle: "starting" }) });
  await tick();
  await Promise.resolve();

  expect(start.getAttribute("aria-busy")).toBeNull();
  expect(start.hasAttribute("disabled")).toBe(true);
  expect(view.container.textContent).not.toContain("Start received no answer.");
});

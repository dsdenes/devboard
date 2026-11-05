import { afterEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import { ResourcesStore, type ResourceSettings } from "./resources.svelte";
import { saveFeedback } from "./save-feedback.svelte";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket: the server's frames are explicit. */
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

afterEach(() => {
  FakeSocket.instances = [];
  saveFeedback.dismiss();
  connection.dispose();
  restoreGlobals();
});

const DERIVED: ResourceSettings = {
  maxAgentPeers: 4,
  memoryHighMb: 38587,
  memoryMaxMb: 48234,
  memoryReserveMb: 24117,
};

const SAVED: ResourceSettings = {
  maxAgentPeers: 2,
  memoryHighMb: 1024,
  memoryMaxMb: 2048,
  memoryReserveMb: 512,
};

/** One `resourcesState` payload; a caller overrides one section at a time. */
function frame(
  options: {
    saved?: ResourceSettings | null;
    effective?: ResourceSettings;
    live?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    saved: options.saved === undefined ? null : options.saved,
    effective: options.effective ?? DERIVED,
    live: {
      activeAgents: 0,
      availableMb: 50000,
      slicePresent: true,
      memoryHighMb: 38587,
      memoryMaxMb: 48234,
      memoryCurrentMb: 0,
      ...options.live,
    },
  };
}

/** Connects a fresh store through the fake socket and leaves it open. */
function opened(store: ResourcesStore): FakeSocket {
  installGlobals();
  connection.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

test("request asks for one resources frame", () => {
  const store = new ResourcesStore();
  const socket = opened(store);

  store.request();

  expect(socket.sent).toContain(JSON.stringify({ type: "getResources" }));
});

test("save sends one setResources frame with every field", () => {
  const store = new ResourcesStore();
  const socket = opened(store);

  store.save(SAVED, "resources.budget");

  expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "setResources", ...SAVED }));

  // Settle the pending save; the connection keeps every test's handler, so a
  // stale pending scope would speak for a later test's frame.
  socket.deliver({ type: "resourcesState", state: frame({ saved: SAVED, effective: SAVED }) });
});

test("a resources frame updates the budget and confirms the pending save", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  expect(store.state).toBeNull();

  socket.deliver({ type: "resourcesState", state: frame() });
  expect(store.state?.saved).toBeNull();
  expect(store.state?.effective).toEqual(DERIVED);
  expect(store.state?.live).toEqual({
    activeAgents: 0,
    availableMb: 50000,
    slicePresent: true,
    memoryHighMb: 38587,
    memoryMaxMb: 48234,
    memoryCurrentMb: 0,
  });
  expect(saveFeedback.text).toBeNull();

  store.save(SAVED, "resources.budget");
  expect(saveFeedback.text).toBeNull();

  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(store.state?.saved).toEqual(SAVED);
  expect(store.state?.effective).toEqual(SAVED);
  expect(saveFeedback.text).toBe("Resource settings saved.");
  expect(saveFeedback.scope).toBe("resources.budget");
});

test("a malformed live figure drops the frame rather than storing NaN", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });
  expect(store.state).not.toBeNull();
  const accepted = store.state;

  socket.deliver({
    type: "resourcesState",
    state: frame({ live: { memoryCurrentMb: "unreadable" } }),
  });
  expect(store.state).toBe(accepted);

  store.handleEvent({
    type: "resourcesState",
    state: frame({ live: { memoryCurrentMb: Number.NaN } }),
  });
  expect(store.state).toBe(accepted);
  expect(Number.isNaN(store.state?.live.memoryCurrentMb)).toBe(false);
});

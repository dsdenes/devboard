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
    saved?: unknown;
    settingsError?: string | null;
    effective?: ResourceSettings;
    live?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    saved: options.saved === undefined ? null : options.saved,
    settingsError: options.settingsError === undefined ? null : options.settingsError,
    effective: options.effective ?? DERIVED,
    live: {
      activeAgents: 0,
      exemptAgents: 0,
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
    exemptAgents: 0,
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

test("a polled frame that still carries the pre-save budget confirms nothing", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });

  store.save(SAVED, "resources.budget");

  // A refused save produces no frame of its own, so the poll answers instead.
  socket.deliver({ type: "resourcesState", state: frame({ effective: DERIVED }) });
  expect(store.state?.effective).toEqual(DERIVED);
  expect(saveFeedback.text).toBeNull();

  // A second such poll leaves it unconfirmed too; it stays pending.
  socket.deliver({ type: "resourcesState", state: frame({ effective: DERIVED }) });
  expect(saveFeedback.text).toBeNull();

  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(saveFeedback.text).toBe("Resource settings saved.");
  expect(saveFeedback.scope).toBe("resources.budget");
});

test("the confirming frame clears the save, so a later poll never re-announces it", () => {
  const store = new ResourcesStore();
  const socket = opened(store);

  store.save(SAVED, "resources.budget");
  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(saveFeedback.text).toBe("Resource settings saved.");
  expect(saveFeedback.scope).toBe("resources.budget");

  // Once confirmed, the budget's own frame is a poll like any other.
  saveFeedback.dismiss();
  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(saveFeedback.text).toBeNull();
  expect(saveFeedback.scope).toBeNull();
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

test("a refused save keeps the server's message and answers its own dispatch", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });

  store.save(SAVED, "resources.budget");
  expect(store.refusal).toBeNull();

  socket.deliver({
    type: "error",
    command: "setResources",
    message: "Memory max plus reserve exceeds the host's total memory.",
  });
  expect(store.refusal).toBe("Memory max plus reserve exceeds the host's total memory.");

  // The refusal ended the save, so the poll that follows never confirms it.
  const before = store.confirmed;
  socket.deliver({ type: "resourcesState", state: frame({ effective: SAVED }) });
  expect(store.confirmed).toBe(before);
  expect(saveFeedback.text).toBeNull();

  // The next dispatch clears the refusal for the new answer.
  store.save(SAVED, "resources.budget");
  expect(store.refusal).toBeNull();
  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
});

test("another command's refusal leaves this store's save waiting for its own answer", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });

  store.save(SAVED, "resources.budget");
  socket.deliver({ type: "error", command: "checkIssues", message: "Not now." });
  expect(store.refusal).toBeNull();

  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(saveFeedback.text).toBe("Resource settings saved.");
  expect(store.confirmed).toBe(1);
});

test("only the pending save's own budget advances the confirmation revision", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });

  store.save(SAVED, "resources.budget");
  const before = store.confirmed;

  // A poll with the unchanged budget is not a confirmation.
  socket.deliver({ type: "resourcesState", state: frame({ effective: DERIVED }) });
  expect(store.confirmed).toBe(before);

  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: SAVED, effective: SAVED }),
  });
  expect(store.confirmed).toBe(before + 1);
});

test("a saved row that omits figures completes them from the effective budget", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  const keys = ["maxAgentPeers", "memoryHighMb", "memoryMaxMb", "memoryReserveMb"] as const;

  // The settings writer emits only the keys the file carries, so a single
  // saved figure must still reach the page as the budget in force.
  for (const key of keys) {
    socket.deliver({
      type: "resourcesState",
      state: frame({ saved: { [key]: 7 } }),
    });
    expect(store.state?.saved).toEqual({ ...DERIVED, [key]: 7 });
    expect(store.state?.effective).toEqual(DERIVED);
    expect(store.state?.live.activeAgents).toBe(0);
  }

  socket.deliver({
    type: "resourcesState",
    state: frame({ saved: { maxAgentPeers: 2 } }),
  });
  expect(store.state?.saved).toEqual({ ...DERIVED, maxAgentPeers: 2 });
});

test("a saved figure that is present and malformed drops the frame", () => {
  const store = new ResourcesStore();
  const socket = opened(store);
  socket.deliver({ type: "resourcesState", state: frame() });
  const accepted = store.state;

  for (const malformed of [null, -1, 2.5, "2", Number.NaN]) {
    store.handleEvent({
      type: "resourcesState",
      state: frame({ saved: { maxAgentPeers: malformed, memoryHighMb: 1024 } }),
    });
    expect(store.state).toBe(accepted);
  }
});

test("a refused settings file carries its reason instead of a saved row", () => {
  const store = new ResourcesStore();
  const socket = opened(store);

  const reason = "/state/resources/settings.json: maxAgentPeers must be a whole number";
  socket.deliver({
    type: "resourcesState",
    state: frame({ settingsError: reason }),
  });
  expect(store.state?.saved).toBeNull();
  expect(store.state?.settingsError).toBe(reason);
  expect(store.state?.effective).toEqual(DERIVED);

  // A reason of another type is a frame this client cannot trust.
  const accepted = store.state;
  store.handleEvent({
    type: "resourcesState",
    state: frame({ settingsError: 4 as unknown as string }),
  });
  expect(store.state).toBe(accepted);
});

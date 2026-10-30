import { afterEach, expect, test } from "bun:test";
import { AgentsStore } from "./agents.svelte";
import { ConnectionStore, connection } from "./connection.svelte";
import { saveFeedback } from "./save-feedback.svelte";
import type { AgentSnapshot } from "./types";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket: the server's snapshots are explicit. */
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

function scout(minutes: number, maxPerHour: number | null, maxPending: number | null): AgentSnapshot {
  return {
    id: "scout",
    label: "Auto Scout",
    description: "",
    scope: "issues",
    lifecycle: "running",
    enabled: true,
    owned: true,
    attached: true,
    cadence: { minutes, lastRunAt: null, nextRunAt: null },
    limits: { maxPerHour, maxPending },
    issues: [],
    pending: 0,
    sync: { state: "fresh", at: null, error: null },
    detail: { panel: "none" },
    notice: null,
    error: null,
    timer: null,
  } as unknown as AgentSnapshot;
}

test("settings feedback waits for the snapshot that echoes the saved values", () => {
  installGlobals();
  const store = new AgentsStore();
  connection.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  socket.deliver({ type: "agentState", agent: scout(30, 10, 5) });
  store.saveSettings("scout", 60, 2, 1);
  expect(socket.sent).toContain(
    JSON.stringify({
      type: "setAgentSettings",
      id: "scout",
      minutes: 60,
      maxPerHour: 2,
      maxPending: 1,
    }),
  );
  expect(saveFeedback.text).toBeNull();

  // An unrelated snapshot and a refused save's unchanged values do not confirm.
  socket.deliver({ type: "agentState", agent: scout(30, 10, 5) });
  expect(saveFeedback.text).toBeNull();

  socket.deliver({ type: "agentState", agent: scout(60, 2, 1) });
  expect(saveFeedback.text).toBe("Auto Scout settings saved.");
});

function filed(filedCount: number, pending: number): AgentSnapshot {
  return {
    ...scout(30, null, null),
    issues: Array.from({ length: filedCount }, (_, index) => ({
      title: `Filed issue ${index + 1}`,
      category: null,
      filedAt: "2026-10-30T00:00:00.000Z",
      url: `https://example.invalid/issues/${index + 1}`,
      state: "pending" as const,
      version: null,
    })),
    pending,
  };
}

test("the sidebar count matches the filed rows, not the pending-filing queue", () => {
  installGlobals();
  const store = new AgentsStore();
  connection.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  socket.deliver({ type: "agentState", agent: filed(2, 11) });
  expect(store.count("scout")).toBe(2);
  expect(store.count("missing")).toBe(0);
});

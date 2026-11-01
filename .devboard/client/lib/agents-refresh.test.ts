import { afterEach, expect, test } from "bun:test";
import { AgentsStore } from "./agents.svelte";
import { connection } from "./connection.svelte";

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

afterEach(() => {
  FakeSocket.instances = [];
  connection.dispose();
  restoreGlobals();
});

test("an opened agent page asks the server for one fresh read", () => {
  installGlobals();
  const store = new AgentsStore();
  const socket = openSocket();

  store.refresh("scout");

  expect(socket.sent).toContain(JSON.stringify({ type: "refreshAgent", id: "scout" }));
});

test("a page opened before the socket settles sends no command", () => {
  installGlobals();
  const store = new AgentsStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");

  store.refresh("scout");

  expect(socket.sent).toEqual([]);
  // The tracker the page's effect reads: connecting is not open, so nothing
  // is sent and no connection error is raised.
  expect(connection.open).toBe(false);
  expect(connection.lastError).toBeNull();
});

import { afterEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import { IssuesStore } from "./issues.svelte";
import type { QueuedIssue } from "./types";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so a reopen is an explicit event. */
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

interface InstalledGlobals {
  WebSocket?: unknown;
  window: unknown;
  location?: unknown;
}

const originalGlobals: InstalledGlobals = {
  WebSocket: (globalThis as unknown as Record<string, unknown>).WebSocket,
  window: (globalThis as unknown as Record<string, unknown>).window,
  location: (globalThis as unknown as Record<string, unknown>).location,
};

function installGlobals(values: InstalledGlobals): void {
  const target = globalThis as unknown as Record<string, unknown>;
  if (values.WebSocket !== undefined) target.WebSocket = values.WebSocket;
  target.window = values.window;
  if (values.location !== undefined) target.location = values.location;
}

function restoreGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

/** A window whose retry timer never reconnects on its own. */
function fakeWindow(): Record<string, unknown> {
  return {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
}

function queuedIssue(number: number): QueuedIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://tracker.test/issues/${number}`,
    createdAt: "2026-11-01T00:00:00Z",
    labels: [],
    handled: false,
    runId: null,
    agentRunId: null,
  };
}

/**
 * One store per test, wired to the socket singleton the store sends on. The
 * open handler is the reconnect reset App.svelte installs.
 */
let store: IssuesStore;

function wire(): IssuesStore {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  store = new IssuesStore();
  return store;
}

connection.onOpen(() => store.resetActiveOperations());
connection.onMessage((message) => {
  store.handleEvent(message as Record<string, unknown>);
});

function reconnect(): FakeSocket {
  connection.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

afterEach(() => {
  connection.dispose();
  FakeSocket.instances = [];
  restoreGlobals();
});

test("a reopen clears a close request the server never answered", () => {
  wire();

  const first = reconnect();
  expect(store.canClose(42)).toBe(true);
  store.closeIssue(42);
  expect(store.closing).toEqual([42]);
  expect(store.canClose(42)).toBe(false);

  // The frame is lost with the socket: the server never handles closeIssue.
  first.close();
  reconnect();

  expect(store.closing).toEqual([]);
  expect(store.canClose(42)).toBe(true);
});

test("a reopened close request is not revived by a queue that still lists the issue", () => {
  wire();

  const first = reconnect();
  store.closeIssue(42);
  expect(store.closing).toEqual([42]);

  first.close();
  const second = reconnect();
  second.deliver({
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    queue: [queuedIssue(42)],
    runs: [],
    agents: [],
  });

  expect(store.closing).toEqual([]);
  expect(store.canClose(42)).toBe(true);
});

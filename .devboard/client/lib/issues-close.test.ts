import { afterEach, expect, test } from "bun:test";
import { createCommandBusy } from "./command-busy.svelte";
import { connection } from "./connection.svelte";
import { IssuesStore } from "./issues.svelte";
import { notifications } from "./notifications.svelte";
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

/** A snapshot that still lists the given issues in the queue. */
function state(queue: QueuedIssue[]): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    queue,
    runs: [],
    agents: [],
  };
}

test("a refused close releases the row's label on the frame that carries its reason", () => {
  wire();
  const socket = reconnect();
  socket.deliver(state([queuedIssue(42)]));

  // The row's Close control latches the issue's close answer as its evidence.
  const control = createCommandBusy({ label: "Close", evidence: () => store.closeRevision(42) });
  control.start();
  store.closeIssue(42);
  expect(control.busy).toBe(true);
  expect(control.word).toBe("Closing…");
  expect(socket.sent.at(-1)).toContain('"closeIssue"');

  socket.deliver({
    type: "issuesClosed",
    number: 42,
    ok: false,
    message: "the forge refused the close",
  });

  // The refusal is an answer: the label rests at once and claims no silence.
  expect(control.busy).toBe(false);
  expect(control.notice).toBeNull();
  expect(store.closing).toEqual([]);
  expect(store.canClose(42)).toBe(true);
  const newest = notifications.live[0];
  expect(newest?.severity).toBe("error");
  expect(newest?.text).toBe("the forge refused the close");

  // The refused issue stays in the queue, and the row takes a retry at once.
  expect(store.snapshot?.queue.map((issue) => issue.number)).toEqual([42]);
  store.closeIssue(42);
  expect(store.closing).toEqual([42]);

  control.dismiss();
});

test("an accepted close releases the label but stays disabled until the queue drops the issue", () => {
  wire();
  const socket = reconnect();
  socket.deliver(state([queuedIssue(42)]));

  const control = createCommandBusy({ label: "Close", evidence: () => store.closeRevision(42) });
  control.start();
  store.closeIssue(42);

  socket.deliver({ type: "issuesClosed", number: 42, ok: true });

  expect(control.busy).toBe(false);
  expect(control.notice).toBeNull();
  expect(store.canClose(42)).toBe(false);

  socket.deliver(state([]));
  expect(store.canClose(42)).toBe(true);

  control.dismiss();
});

test("a close answer for one issue leaves another row's label pending", () => {
  wire();
  const socket = reconnect();
  socket.deliver(state([queuedIssue(42), queuedIssue(43)]));

  const control = createCommandBusy({ label: "Close", evidence: () => store.closeRevision(42) });
  control.start();
  store.closeIssue(42);

  socket.deliver({
    type: "issuesClosed",
    number: 43,
    ok: false,
    message: "the forge refused the close",
  });

  expect(control.busy).toBe(true);
  expect(store.closing).toEqual([42]);

  control.dismiss();
});

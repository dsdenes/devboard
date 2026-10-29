import { afterEach, expect, test } from "bun:test";
import { ConnectionStore, connection } from "./connection.svelte";
import { FlowStore } from "./flow.svelte";
import type { FlowSnapshot } from "./types";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so closed and open sends are explicit. */
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

function fakeWindow(): Record<string, unknown> {
  return {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
}

function snapshot(goal: string, decisions: string): FlowSnapshot {
  return { goal, decisions } as unknown as FlowSnapshot;
}

afterEach(() => {
  FakeSocket.instances = [];
  restoreGlobals();
});

test("a save on a closed connection keeps the drafts dirty", () => {
  const sockets = new ConnectionStore();
  expect(sockets.open).toBe(false);
  const store = new FlowStore();
  store.applySnapshot(snapshot("old goal", "old decisions"));

  store.setGoalDraft("edited goal");
  store.saveGoal();
  expect(store.goalDirty).toBe(true);
  expect(store.goalDraft).toBe("edited goal");

  store.setDecisionsDraft("edited decisions");
  store.saveDecisions();
  expect(store.decisionsDirty).toBe(true);
  expect(store.decisionsDraft).toBe("edited decisions");

  // The reconnect snapshot must not replace edits that were never sent.
  store.applySnapshot(snapshot("server goal", "server decisions"));
  expect(store.goalDraft).toBe("edited goal");
  expect(store.decisionsDraft).toBe("edited decisions");
});

test("a save on an open connection clears the matching dirty flag once confirmed", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new FlowStore();
  store.applySnapshot(snapshot("old goal", "old decisions"));

  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  store.setGoalDraft("edited goal");
  store.saveGoal();
  expect(store.goalDirty).toBe(true);
  expect(socket.sent).toContain(
    JSON.stringify({ type: "saveFlowGoal", text: "edited goal" }),
  );

  store.applySnapshot(snapshot("edited goal", "old decisions"));
  expect(store.goalDirty).toBe(false);
  expect(store.goalDraft).toBe("edited goal");

  store.setDecisionsDraft("edited decisions");
  store.saveDecisions();
  expect(store.decisionsDirty).toBe(false);
  expect(socket.sent).toContain(
    JSON.stringify({ type: "saveFlowDecisions", text: "edited decisions" }),
  );

  // A later disconnect must not let the next save look successful.
  socket.close();
  store.setGoalDraft("second edit");
  store.saveGoal();
  expect(store.goalDirty).toBe(true);
  expect(store.goalDraft).toBe("second edit");

  connection.dispose();
});

test("a refused goal save keeps the draft until the same text is confirmed", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new FlowStore();
  store.applySnapshot(snapshot("old goal", "old decisions"));

  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  store.setGoalDraft("edited goal");
  store.saveGoal();
  // The server refuses while the implementation runs and publishes the
  // persisted goal; that snapshot must not revert the editor.
  store.handleEvent({ type: "flowError", message: "The Flow implementation is running." });
  store.applySnapshot(snapshot("old goal", "old decisions"));
  expect(store.goalDirty).toBe(true);
  expect(store.goalDraft).toBe("edited goal");

  // The same text saved after the implementation stops is confirmed by the
  // snapshot carrying it.
  store.saveGoal();
  store.applySnapshot(snapshot("edited goal", "old decisions"));
  expect(store.goalDirty).toBe(false);
  expect(store.goalDraft).toBe("edited goal");

  connection.dispose();
});

test("a snapshot with a different goal never replaces a pending draft", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new FlowStore();
  store.applySnapshot(snapshot("old goal", "old decisions"));

  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  store.setGoalDraft("edited goal");
  store.saveGoal();
  store.applySnapshot(snapshot("another goal", "old decisions"));
  expect(store.goalDirty).toBe(true);
  expect(store.goalDraft).toBe("edited goal");

  // Editing away from the sent text drops the pending save, so later
  // snapshots cannot clear the newer draft either.
  store.setGoalDraft("newer edit");
  store.applySnapshot(snapshot("edited goal", "old decisions"));
  expect(store.goalDirty).toBe(true);
  expect(store.goalDraft).toBe("newer edit");

  connection.dispose();
});

import { afterEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import { IssuesStore } from "./issues.svelte";

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

  get runRequests(): string[] {
    return this.sent.filter((frame) => frame.includes('"getIssuesRun"'));
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

/** One store per test, wired to the socket singleton the store sends on. */
let store: IssuesStore;

function wire(): void {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  store = new IssuesStore();
}

// The open handler is the reconnect reset App.svelte installs.
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

/** A run that already ended: its snapshot lists it as history, not a live agent. */
function finishedState(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "idle",
    enabled: true,
    queue: [],
    runs: [
      {
        runId: "run-42",
        status: "succeeded",
        startedAt: "2026-11-09T10:00:00Z",
        finishedAt: "2026-11-09T10:04:00Z",
        exitCode: 0,
        issueNumbers: [42],
        activity: 2,
        firstStderrLine: null,
        harnessVersion: "1.44.10",
      },
    ],
    agents: [],
  };
}

/** One run's persisted history, as the `issuesRun` frame carries it. */
function finishedRun(): Record<string, unknown> {
  return {
    runId: "run-42",
    status: "succeeded",
    startedAt: "2026-11-09T10:00:00Z",
    finishedAt: "2026-11-09T10:04:00Z",
    exitCode: 0,
    issueNumbers: [42],
    activity: 2,
    firstStderrLine: null,
    harnessVersion: "1.44.10",
    repo: "dsdenes/devboard",
    argv: ["omp", "acp"],
    cwd: "/repo",
    issues: [],
    workerPid: 4242,
    activityLines: ["$ cargo test", "2 passed"],
  };
}

test("a reconnect re-requests a run whose history answer was lost", () => {
  wire();
  const first = reconnect();
  first.deliver(finishedState());

  // The focus tab's effect reads the history, and the answer never lands.
  store.loadRun("run-42");
  expect(first.runRequests.length).toBe(1);
  expect(store.run).toBeNull();

  first.close();
  const second = reconnect();

  store.loadRun("run-42");
  expect(second.runRequests.length).toBe(1);

  second.deliver({ type: "issuesRun", run: finishedRun() });
  expect(store.run?.activityLines).toEqual(["$ cargo test", "2 passed"]);
  expect(store.runError).toBeNull();

  // The answered detail is what the next effect pass reads; it asks again
  // only after another reconnect.
  store.loadRun("run-42");
  expect(second.runRequests.length).toBe(1);
});

test("an unanswered run asks once per open transition, never per render", () => {
  wire();
  const first = reconnect();
  first.deliver(finishedState());

  // The effect re-runs on every snapshot poll while the answer is missing.
  store.loadRun("run-42");
  store.loadRun("run-42");
  store.loadRun("run-42");
  expect(first.runRequests.length).toBe(1);

  first.close();
  const second = reconnect();
  store.loadRun("run-42");
  store.loadRun("run-42");
  expect(second.runRequests.length).toBe(1);
});

test("a missing run asks once per open transition and then stays unavailable", () => {
  wire();
  const first = reconnect();
  first.deliver(finishedState());

  store.loadRun("run-gone");
  first.deliver({ type: "issuesRunMissing", runId: "run-gone", message: "No such issues run." });
  expect(store.runError).toBe("No such issues run.");

  store.loadRun("run-gone");
  store.loadRun("run-gone");
  expect(first.runRequests.length).toBe(1);

  first.close();
  const second = reconnect();
  store.loadRun("run-gone");
  expect(second.runRequests.length).toBe(1);
});

test("a request the closed socket refused leaves the run free to ask again", () => {
  wire();
  // A socket that has not opened yet answers every send as refused.
  connection.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error("no socket created");

  store.loadRun("run-42");
  expect(socket.runRequests.length).toBe(0);
  expect(store.selectedRun).toBeNull();

  socket.open();
  store.loadRun("run-42");
  expect(socket.runRequests.length).toBe(1);
});

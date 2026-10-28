import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "../../server/app";
import { ConnectionStore, connection } from "./connection.svelte";
import { GoalStore, goal } from "./goal.svelte";

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

function fakeWindow(): Record<string, unknown> {
  return {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
}

afterEach(() => {
  FakeSocket.instances = [];
  restoreGlobals();
});

test("a reopen clears a missed goal creation stop so the goal snapshot applies", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new GoalStore();
  const sockets = new ConnectionStore();
  sockets.onOpen(() => store.resetActiveOperations());
  sockets.onMessage((message) => store.handleEvent(message as Record<string, unknown>));

  const reconnect = () => {
    sockets.connect();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error("no socket created");
    socket.open();
    return socket;
  };

  const first = reconnect();
  first.deliver({ type: "goal", text: "# Existing goal" });
  expect(store.goalText).toBe("# Existing goal");

  first.deliver({ type: "goalCreationStarted" });
  expect(store.creationActive).toBe(true);
  expect(store.controlsDisabled).toBe(true);

  // The server goes away and its stop frame is never delivered.
  first.close();
  const second = reconnect();

  expect(store.creationActive).toBe(false);
  expect(store.controlsDisabled).toBe(false);
  second.deliver({ type: "goal", text: "# Created goal" });

  expect(store.goalText).toBe("# Created goal");
  expect(store.creationActive).toBe(false);
  expect(store.controlsDisabled).toBe(false);
});

test("a reopen clears a missed skills stop so the skills snapshot applies", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new GoalStore();
  const sockets = new ConnectionStore();
  sockets.onOpen(() => store.resetActiveOperations());
  sockets.onMessage((message) => store.handleEvent(message as Record<string, unknown>));

  const reconnect = () => {
    sockets.connect();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error("no socket created");
    socket.open();
    return socket;
  };

  const first = reconnect();
  first.deliver({
    type: "skillsState",
    skills: [{ name: "old-skill", description: "Before the reconnect." }],
    contradictions: [],
  });
  expect(store.skills.map((skill) => skill.name)).toEqual(["old-skill"]);

  first.deliver({ type: "skillsPreparationStarted" });
  expect(store.skillsPrepActive).toBe(true);
  expect(store.controlsDisabled).toBe(true);

  first.close();
  const second = reconnect();

  expect(store.skillsPrepActive).toBe(false);
  expect(store.controlsDisabled).toBe(false);
  second.deliver({
    type: "skillsState",
    skills: [
      { name: "new-skill", description: "After the reconnect." },
      { name: "another-skill", description: "Also after the reconnect." },
    ],
    contradictions: [],
  });

  expect(store.skills.map((skill) => skill.name)).toEqual(["new-skill", "another-skill"]);
  expect(store.skillsPrepActive).toBe(false);
  expect(store.controlsDisabled).toBe(false);
});

const harnessRoot = resolve(import.meta.dir, "..", "..");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");

/**
 * Polls real sockets and server processes; deterministic timers cannot drive
 * their I/O, so this test waits on the platform clock.
 */
async function waitUntil(predicate: () => boolean, label: string, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test(
  "a server restart during goal creation leaves the Goal tab usable without a reload",
  async () => {
    await mkdir(join(harnessRoot, ".test-tmp"), { recursive: true });
    const root = await mkdtemp(join(harnessRoot, ".test-tmp", "goal-reconnect-"));
    const adrDir = join(root, "adrs");
    const staticDir = join(root, "static");
    const goalFile = join(root, "GOAL.md");
    await mkdir(adrDir, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Goal</title>");
    await writeFile(goalFile, "# Integration goal\n\nKeep this text.");

    const logPath = join(root, "agent.log");
    const agentCommand =
      `bun ${stubAgent} --log=${logPath} --create-goal --goal=${goalFile} --delay-ms=20000`;
    const host = (stateDir: string): Server<unknown> =>
      createApp({
        adrDir,
        staticDir,
        hostname: "127.0.0.1",
        port: 0,
        repoDir: root,
        stateDir,
        goalFile,
        agentCommand,
      });

    const location = { protocol: "http:", host: "" };
    installGlobals({
      window: {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
      },
      location,
    });

    connection.onOpen(() => goal.resetActiveOperations());
    connection.onMessage((message) => goal.handleEvent(message as Record<string, unknown>));

    const first = host(join(root, "state-1"));
    const second = host(join(root, "state-2"));
    try {
      location.host = `127.0.0.1:${first.port}`;
      connection.connect();
      await waitUntil(() => connection.open, "the first connection");
      await waitUntil(() => goal.goalText.startsWith("# Integration goal"), "the goal snapshot");

      goal.createGoal();
      await waitUntil(() => goal.creationActive, "goal creation to start");
      expect(goal.controlsDisabled).toBe(true);

      // The replacement server has no in-flight creation, so its open sends no
      // started frame and the reconnect's snapshot is the only authority.
      first.stop(true);
      location.host = `127.0.0.1:${second.port}`;
      await waitUntil(() => !connection.open, "the socket to drop");
      await waitUntil(() => connection.open, "the reconnection");

      await waitUntil(
        () =>
          !goal.creationActive &&
          goal.goalText.startsWith("# Integration goal") &&
          goal.goalReady,
        "the reconciled goal state",
      );
      expect(goal.creationActive).toBe(false);
      expect(goal.revisionActive).toBe(false);
      expect(goal.skillsPrepActive).toBe(false);
      expect(goal.controlsDisabled).toBe(false);
      expect(goal.goalEditingDisabled).toBe(false);
      expect(goal.runStartDisabled).toBe(false);
    } finally {
      connection.dispose();
      first.stop(true);
      second.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

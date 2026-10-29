import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "../../server/app";
import { testProviderService } from "../../server/fixtures/test-providers";
import { ConnectionStore, connection } from "./connection.svelte";
import { discover } from "./discover.svelte";
import { GoalStore } from "./goal.svelte";

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
  "a goal save refused by an active Discover run survives a reconnect",
  async () => {
    await mkdir(join(harnessRoot, ".test-tmp"), { recursive: true });
    const root = await mkdtemp(join(harnessRoot, ".test-tmp", "goal-discover-refusal-"));
    const adrDir = join(root, "adrs");
    const staticDir = join(root, "static");
    const goalFile = join(root, "GOAL.md");
    await mkdir(adrDir, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Goal</title>");
    await writeFile(goalFile, "# Integration goal\n\nKeep this text.");

    const logPath = join(root, "agent.log");
    const agentCommand =
      `bun ${stubAgent} --log=${logPath} --discover --discover-no-exit --delay-ms=60000`;
    const host = (stateDir: string): Server<unknown> =>
      createApp({
        adrDir,
        staticDir,
        hostname: "127.0.0.1",
        port: 0,
        repoDir: root,
        stateDir,
        providers: testProviderService(stateDir),
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

    // The editing refusal reads the Discover singleton, so both stores see the
    // same frames the real interface registers in App.svelte.
    const store = new GoalStore();
    connection.onOpen(() => {
      store.resetActiveOperations();
      discover.resetActiveOperations();
    });
    connection.onMessage((message) => {
      store.handleEvent(message as Record<string, unknown>);
      discover.handleEvent(message as Record<string, unknown>);
    });

    const first = host(join(root, "state-1"));
    const second = host(join(root, "state-2"));
    try {
      location.host = `127.0.0.1:${first.port}`;
      connection.connect();
      await waitUntil(() => connection.open, "the first connection");
      await waitUntil(() => store.goalText.startsWith("# Integration goal"), "the goal snapshot");

      discover.start();
      await waitUntil(() => discover.active, "the Discover run to start");
      expect(store.goalEditingDisabled).toBe(true);

      store.setGoalDraft("# Operator edit\n\nKeep this through the reconnect.\n");
      store.saveGoal();
      await waitUntil(
        () => connection.lastError !== null && connection.lastError.includes("Discover run"),
        "the save refusal",
      );
      expect(store.goalDirty).toBe(true);

      // The reconnect lands on a server without the Discover run, so its goal
      // snapshot is the old text. The unsaved draft and the flag the tab-close
      // guard reads must both survive it.
      first.stop(true);
      location.host = `127.0.0.1:${second.port}`;
      await waitUntil(() => !connection.open, "the socket to drop");
      await waitUntil(() => connection.open, "the reconnection");
      await waitUntil(
        () => store.goalText.startsWith("# Integration goal"),
        "the replayed goal snapshot",
      );

      expect(store.goalDraft).toBe("# Operator edit\n\nKeep this through the reconnect.\n");
      expect(store.goalDirty).toBe(true);
      // The replayed snapshot clears the run the client remembered from the
      // replaced process, so the Save control is usable again.
      expect(store.goalEditingDisabled).toBe(false);
    } finally {
      connection.dispose();
      first.stop(true);
      second.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test("a refused goal save stays dirty until the server echoes the saved text", () => {
  FakeSocket.instances = [];
  installGlobals({
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    window: fakeWindow(),
    location: { protocol: "http:", host: "test.invalid" },
  });
  const store = new GoalStore();
  connection.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  connection.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  try {
    socket.deliver({ type: "goal", text: "# Existing goal" });
    expect(store.goalDraft).toBe("# Existing goal");
    expect(store.goalDirty).toBe(false);

    store.setGoalDraft("# Edited goal");
    store.saveGoal();
    expect(socket.sent).toContain(JSON.stringify({ type: "saveGoal", text: "# Edited goal" }));
    expect(store.goalDirty).toBe(true);

    // The server refuses while a Discover run is active and answers with an
    // error frame instead of the confirming goal frame.
    socket.deliver({
      type: "error",
      message: "A Discover run is active. Finish or stop it before starting other work.",
    });
    expect(store.goalDirty).toBe(true);
    expect(store.goalDraft).toBe("# Edited goal");

    // A snapshot of the old text (a reconnect or another tab) must not replace
    // the unsaved draft.
    socket.deliver({ type: "goal", text: "# Existing goal" });
    expect(store.goalDirty).toBe(true);
    expect(store.goalDraft).toBe("# Edited goal");

    // Only the echo of the sent text confirms the save.
    socket.deliver({ type: "goal", text: "# Edited goal" });
    expect(store.goalDirty).toBe(false);
    expect(store.goalDraft).toBe("# Edited goal");
  } finally {
    connection.dispose();
  }
});

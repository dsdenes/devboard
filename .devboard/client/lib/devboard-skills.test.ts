import { afterEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import { DevboardSkillsStore } from "./devboard-skills.svelte";
import { notifications } from "./notifications.svelte";

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
  notifications.clear();
  connection.dispose();
  restoreGlobals();
});

const ROWS = [
  { name: "devboard-ui-ux", enabled: true, content: "", builtin: true, deletable: false },
  { name: "tidy-commits", enabled: true, content: "", builtin: false, deletable: true },
];

/** Connects a fresh store through the fake socket and leaves it open. */
function opened(store: DevboardSkillsStore): FakeSocket {
  installGlobals();
  connection.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

test("deleteSkill removes the row before the server answers", () => {
  const store = new DevboardSkillsStore();
  const socket = opened(store);
  socket.deliver({ type: "installedSkills", skills: ROWS });
  expect(store.skills.map((row) => row.name)).toEqual(["devboard-ui-ux", "tidy-commits"]);

  store.deleteSkill("tidy-commits");

  expect(store.skills.map((row) => row.name)).toEqual(["devboard-ui-ux"]);
  expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "deleteSkill", name: "tidy-commits" }));

  // A refusal answers with the authoritative rows; the row returns.
  socket.deliver({ type: "installedSkills", skills: ROWS });
  expect(store.skills.map((row) => row.name)).toEqual(["devboard-ui-ux", "tidy-commits"]);
});

test("deleteSkill keeps the row when no socket took the command", () => {
  const store = new DevboardSkillsStore();
  store.skills = [
    { name: "tidy-commits", enabled: true, content: "", builtin: false, deletable: true },
  ];
  store.skillsLoaded = true;

  store.deleteSkill("tidy-commits");

  expect(store.skills.map((row) => row.name)).toEqual(["tidy-commits"]);
});

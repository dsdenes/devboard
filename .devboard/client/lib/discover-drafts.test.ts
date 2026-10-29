import { afterEach, expect, test } from "bun:test";
import { ConnectionStore } from "./connection.svelte";
import { DiscoverStore } from "./discover.svelte";
import type { DiscoverSkill, DiscoverTarget } from "./types";

/**
 * Discover drafts are scoped to the target they were edited against. Every
 * project shares the five fixed skill names, so a target switch must never
 * carry one project's unsaved text into another project's save.
 */

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket; nothing here touches a server. */
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
  restoreGlobals();
});

const SKILL = "discover-testing-strategy";

function skill(live: string): DiscoverSkill {
  return { name: SKILL, state: "generated", baseline: live, live };
}

function remote(owner: string, repo: string): DiscoverTarget {
  return {
    kind: "remote",
    url: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    checkout: false,
  };
}

function deliver(socket: FakeSocket, target: DiscoverTarget, live: string): void {
  socket.deliver({
    type: "discoverState",
    state: { active: false, interrupted: false, target, skills: [skill(live)], warnings: [] },
  });
}

function sentFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

function assertDraftScope(store: DiscoverStore, socket: FakeSocket): void {
  const alpha = remote("octocat", "Alpha");
  const beta = remote("octocat", "Beta");

  deliver(socket, alpha, "a");
  expect(store.skillDraft(SKILL)).toBe("a");

  store.updateDraft(SKILL, "edited against alpha");
  expect(store.skillDirty(SKILL)).toBe(true);

  // The other project publishes its own text for the same fixed skill name.
  deliver(socket, beta, "b");
  expect(store.skillDraft(SKILL)).toBe("b");
  expect(store.skillDirty(SKILL)).toBe(false);

  store.saveSkill(SKILL);
  const saves = sentFrames(socket).filter((frame) => frame.type === "saveDiscoverSkill");
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    name: SKILL,
    text: "b",
    target: { kind: "remote", owner: "octocat", repo: "Beta" },
  });

  // Returning to the first project restores its unsaved text instead of the
  // second project's published content.
  deliver(socket, alpha, "a");
  expect(store.skillDraft(SKILL)).toBe("edited against alpha");
  expect(store.skillDirty(SKILL)).toBe(true);

  // The host target is a third scope, independent of both retained projects.
  deliver(socket, { kind: "host" }, "host text");
  expect(store.skillDraft(SKILL)).toBe("host text");
  expect(store.skillDirty(SKILL)).toBe(false);
}

test("a skill draft and its save stay with the target they were edited against", () => {
  FakeSocket.instances = [];
  installGlobals();
  const sockets = new ConnectionStore();
  const store = new DiscoverStore(sockets);
  sockets.onMessage((message) => store.handleEvent(message as Record<string, unknown>));
  sockets.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  try {
    assertDraftScope(store, socket);
  } finally {
    sockets.dispose();
  }
});

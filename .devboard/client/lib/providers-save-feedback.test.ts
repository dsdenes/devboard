import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { ProviderStore } from "./providers.svelte";
import { queryClient } from "./query-client";
import { saveFeedback } from "./save-feedback.svelte";

// The query harness mounts into a document, so it is loaded after the DOM
// runtime this file installs rather than beside the rune modules above.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket: the server's state frames are explicit. */
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

afterEach(() => {
  FakeSocket.instances = [];
  saveFeedback.dismiss();
  cleanup();
  queryClient.clear();
  connection.dispose();
  restoreGlobals();
});

/** A store attached to one open fake socket. */
function connected(): { store: ProviderStore; socket: FakeSocket } {
  installGlobals();
  const store = new ProviderStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return { store, socket };
}

/**
 * Installs the DOM runtime the query harness mounts into and remembers it as
 * the state `restoreGlobals` puts back, so a later test file still finds the
 * same document.
 */
function installDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  const target = globalThis as unknown as Record<string, unknown>;
  originalGlobals.window = target.window;
  originalGlobals.location = target.location;
  originalGlobals.WebSocket = target.WebSocket;
}

interface HttpRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Every frame one REST answer carries. */
function jsonFrames(frames: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ frames }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A refused answer, shaped the way the server reports a problem. */
function refusedAnswer(status: number, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: "Server Error", status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** Resolves the promise chains one command's answer starts. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

/**
 * A store behind the shipping HTTP transport: the app root's mutations are
 * mounted, and one command's answer is the response the handler returns
 * (null keeps the empty answer a read gets).
 */
async function httpConnected(
  answer: (request: HttpRequest) => Response | null,
): Promise<ProviderStore> {
  installDom();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: HttpRequest = {
        method: init?.method ?? "GET",
        url: String(input),
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null,
      };
      return answer(request) ?? jsonFrames([]);
    },
  });
  render(QueryHarness);
  connection.connect();
  const store = new ProviderStore();
  connection.onMessage((message) => {
    store.handleEvent(message);
  });
  return store;
}

test("a stale state frame neither confirms a save nor clears its wait", () => {
  const { store, socket } = connected();

  const requestId = store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  if (requestId === null) throw new Error("the save was not sent");
  expect(socket.sent).toContain(
    JSON.stringify({
      type: "createProvider",
      requestId,
      provider: "openrouter",
      label: "Work",
      key: "sk-test",
    }),
  );
  expect(store.busy).toBe(true);

  // The periodic refresh, a getProviders reply, and another client's change all
  // arrive as a plain broadcast: none of them answers this save.
  store.handleEvent({ type: "providersState", subscriptions: [], selection: null });
  expect(saveFeedback.text).toBeNull();
  expect(store.saveResult).toBeNull();
  expect(store.busy).toBe(true);

  expect(store.handleEvent({ type: "providerChanged", requestId })).toBe(true);
  expect(saveFeedback.text).toBe("Provider saved.");
  expect(saveFeedback.scope).toBe("providers.form");
  expect(store.saveResult).toEqual({ requestId, ok: true });
  expect(store.busy).toBe(false);

  // The same acknowledgement never settles a second time.
  expect(store.handleEvent({ type: "providerChanged", requestId })).toBe(false);
});

test("an edited provider updates its own resource", () => {
  const { store, socket } = connected();

  const requestId = store.save({
    id: "subscription-1",
    provider: "openrouter",
    label: "Work",
  });
  if (requestId === null) throw new Error("the save was not sent");
  expect(socket.sent).toContain(
    JSON.stringify({
      type: "saveProvider",
      requestId,
      id: "subscription-1",
      provider: "openrouter",
      label: "Work",
    }),
  );
});

test("a refused save keeps its own error and never announces success", () => {
  const { store } = connected();

  const requestId = store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  if (requestId === null) throw new Error("the save was not sent");
  store.handleEvent({ type: "providersState", subscriptions: [], selection: null });
  store.handleEvent({ type: "providerError", requestId, message: "The key is invalid." });

  expect(store.error).toBe("The key is invalid.");
  expect(saveFeedback.text).toBeNull();
  expect(store.saveResult).toEqual({ requestId, ok: false });
  expect(store.busy).toBe(false);
});

test("one save's answer leaves another request waiting", () => {
  const { store } = connected();

  const first = store.save({ provider: "openrouter", label: "Work", key: "sk-one" });
  const second = store.save({ provider: "openrouter", label: "Home", key: "sk-two" });
  if (first === null || second === null) throw new Error("a save was not sent");
  expect(first).not.toBe(second);

  store.handleEvent({ type: "providerChanged", requestId: second });
  expect(store.busy).toBe(true);
  expect(store.saveResult).toEqual({ requestId: second, ok: true });

  store.handleEvent({ type: "providerChanged", requestId: first });
  expect(store.busy).toBe(false);
});

test("a change on a closed socket leaves the store idle", () => {
  installGlobals();
  const store = new ProviderStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");

  expect(store.save({ provider: "openrouter", label: "Work", key: "sk-test" })).toBeNull();
  expect(store.remove("subscription")).toBeNull();
  expect(store.setEnabled("subscription", false)).toBeNull();
  expect(store.busy).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("a reconnect drops a change the lost socket can never answer", () => {
  const { store } = connected();

  store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  expect(store.busy).toBe(true);

  store.resetActiveOperations();
  expect(store.busy).toBe(false);
  expect(store.saveResult).toBeNull();
});

test("a key the provider refused is reported inline and raises no notification", () => {
  const { store } = connected();
  const before = notifications.items.length;

  const requestId = store.save({ provider: "openrouter", label: "Work", key: "sk-typo" });
  if (requestId === null) throw new Error("the save was not sent");
  expect(
    store.handleEvent({
      type: "providerError",
      requestId,
      keyRefused: true,
      message: "The provider rejected this key (HTTP 401).",
    }),
  ).toBe(true);

  expect(store.error).toBe("The provider rejected this key (HTTP 401).");
  expect(store.saveResult).toEqual({ requestId, ok: false });
  expect(notifications.items.length).toBe(before);
});

test("a provider change that failed on the server is still an error notification", () => {
  const { store } = connected();
  const before = notifications.items.length;

  const requestId = store.save({ provider: "openrouter", label: "Work", key: "sk-good" });
  if (requestId === null) throw new Error("the save was not sent");
  store.handleEvent({
    type: "providerError",
    requestId,
    message: "The credentials file could not be written: disk full",
  });

  expect(notifications.items.length).toBe(before + 1);
  expect(notifications.items[0]?.source).toBe("Providers");
  expect(notifications.items[0]?.text).toBe("The credentials file could not be written: disk full");
});

test("a save whose answer fails stops waiting and a later save still confirms", async () => {
  let saves = 0;
  const store = await httpConnected(({ method, url, body }) => {
    if (method !== "POST" || url !== "/providers") return null;
    saves += 1;
    if (saves === 1) {
      return refusedAnswer(500, "The credentials file could not be written: disk full");
    }
    return jsonFrames([{ type: "providerChanged", requestId: body?.requestId }]);
  });

  const refused = store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  if (refused === null) throw new Error("the save was not sent");
  expect(store.busy).toBe(true);
  await settle();

  // The refused answer produced no frame, so the failure itself settles it:
  // no id stays pending and nothing claims the save was applied.
  expect(store.busy).toBe(false);
  expect(store.saveResult).toBeNull();
  expect(saveFeedback.text).toBeNull();

  const confirmed = store.save({ provider: "openrouter", label: "Work", key: "sk-good" });
  if (confirmed === null) throw new Error("the save was not sent");
  expect(store.busy).toBe(true);
  await settle();

  expect(store.busy).toBe(false);
  expect(store.saveResult).toEqual({ requestId: confirmed, ok: true });
  expect(saveFeedback.text).toBe("Provider saved.");
  expect(saveFeedback.scope).toBe("providers.form");
});

test("a delete and an enable whose answer fails leave the store idle", async () => {
  let commands = 0;
  const store = await httpConnected(({ method, url }) => {
    if (url !== "/providers/subscription-1") return null;
    if (method !== "DELETE" && method !== "PATCH") return null;
    commands += 1;
    return refusedAnswer(500, "The credentials file could not be written: disk full");
  });

  expect(store.remove("subscription-1")).not.toBeNull();
  expect(store.busy).toBe(true);
  await settle();
  expect(store.busy).toBe(false);

  expect(store.setEnabled("subscription-1", false)).not.toBeNull();
  expect(store.busy).toBe(true);
  await settle();
  expect(store.busy).toBe(false);
  expect(commands).toBe(2);
});

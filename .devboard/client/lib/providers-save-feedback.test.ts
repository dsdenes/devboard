import { afterEach, expect, test } from "bun:test";
import { ConnectionStore, connection } from "./connection.svelte";
import { ProviderStore } from "./providers.svelte";
import { saveFeedback } from "./save-feedback.svelte";

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
  connection.dispose();
  restoreGlobals();
});

test("a provider save confirms only on the state frame that follows it", () => {
  installGlobals();
  const store = new ProviderStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  expect(socket.sent).toContain(
    JSON.stringify({
      type: "saveProvider",
      provider: "openrouter",
      label: "Work",
      key: "sk-test",
    }),
  );
  expect(saveFeedback.text).toBeNull();

  // A refusal leaves the failure to its own alert and shows no confirmation.
  store.handleEvent({ type: "providerError", message: "The key is invalid." });
  expect(saveFeedback.text).toBeNull();

  store.save({ provider: "openrouter", label: "Work", key: "sk-test" });
  store.handleEvent({ type: "providersState", subscriptions: [], selection: null });
  expect(saveFeedback.text).toBe("Provider saved.");
});

test("the indicator names the selected subscription and its next-peer role", () => {
  const store = new ProviderStore();
  store.handleEvent({
    type: "providersState",
    subscriptions: [],
    selection: {
      provider: "opencode-go",
      providerName: "OpenCode Go",
      label: "Go #3",
      model: "opencode-go/deepseek-v4.1-flash",
      remainingFraction: 1,
    },
    refusal: null,
  });
  expect(store.indicatorLabel).toBe("OpenCode Go · Go #3 · 100%");
  expect(store.indicatorTitle).toContain("selected for the next peer");
});

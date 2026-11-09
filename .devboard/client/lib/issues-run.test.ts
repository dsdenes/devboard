import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { ConnectionStore } = await import("./connection.svelte");
const { issues } = await import("./issues.svelte");
const { notifications } = await import("./notifications.svelte");

/** Resolves the promise chain `send` starts without waiting on a real timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

const original = {
  fetch: globalThis.fetch,
  window: (globalThis as unknown as Record<string, unknown>).window,
  WebSocket: (globalThis as unknown as Record<string, unknown>).WebSocket,
  sessionStorage: (globalThis as unknown as Record<string, unknown>).sessionStorage,
  location: (globalThis as unknown as Record<string, unknown>).location,
  document: (globalThis as unknown as Record<string, unknown>).document,
};

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function restore(): void {
  setGlobal("fetch", original.fetch);
  setGlobal("window", original.window);
  setGlobal("WebSocket", original.WebSocket);
  setGlobal("sessionStorage", original.sessionStorage);
  setGlobal("location", original.location);
  setGlobal("document", original.document);
}

/** A page whose every read answers the one frame the test supplies. */
function page(frame: unknown) {
  setGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(frame), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  setGlobal(
    "WebSocket",
    class Untracked {
      constructor() {
        throw new Error("no command socket may be constructed");
      }
    },
  );
  setGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  setGlobal("document", {
    visibilityState: "visible",
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });
  const store = new ConnectionStore();
  store.onMessage((message) => issues.handleEvent(message as Record<string, unknown>));
  store.state = "open";
  return store;
}

beforeEach(() => {
  restore();
});

afterEach(() => {
  restore();
});

test("a run whose history is gone reads as unavailable without a server error notification", async () => {
  const before = notifications.items.length;
  const store = page({
    frames: [
      { type: "issuesRunMissing", runId: "run-gone", message: "No such issues run." },
    ],
  });

  expect(store.send({ type: "getIssuesRun", runId: "run-gone" }, "operator")).toBe(true);
  await settle();

  expect(issues.runError).toBe("No such issues run.");
  expect(notifications.items.length).toBe(before);

  // The history read that follows clears the unavailable state; a pruned run
  // is an answer, not a page that stays broken.
  issues.handleEvent({ type: "issuesRun", run: { runId: "run-gone", activityLines: [] } });
  expect(issues.runError).toBeNull();
  expect(notifications.items.length).toBe(before);
  store.dispose();
});

test("a genuine server error still reaches the notification region", async () => {
  const before = notifications.items.length;
  const store = page({ frames: [{ type: "error", message: "The tracker is unreachable." }] });

  store.send({ type: "getIssuesRun", runId: "run-1" }, "operator");
  await settle();

  const added = notifications.items.slice(0, notifications.items.length - before);
  expect(added.some((item) => item.source === "Server")).toBe(true);
  store.dispose();
});

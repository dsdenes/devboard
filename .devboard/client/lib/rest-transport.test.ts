import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { ConnectionStore } = await import("./connection.svelte");
const { isStaleBundleProblem, reloadOnceForStaleBundle } = await import("./stale-bundle");

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

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function fakeDocument(state: "visible" | "hidden"): Document {
  return {
    visibilityState: state,
    hidden: state === "hidden",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
}

beforeEach(() => {
  restore();
});
afterEach(() => {
  restore();
});

test("polling_pauses_when_hidden", async () => {
  const requests: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
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
  setGlobal("document", fakeDocument("visible"));
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });

  const store = new ConnectionStore();
  store.send({ type: "getVersion" }, "initial");
  await settle();
  const afterFirst = requests.length;
  expect(afterFirst).toBeGreaterThan(0);

  setGlobal("document", fakeDocument("hidden"));
  for (let tick = 0; tick < 20; tick += 1) {
    (store as unknown as { pollTick(): void }).pollTick();
  }
  await settle();
  expect(requests.length).toBe(afterFirst);

  setGlobal("document", fakeDocument("visible"));
  (store as unknown as { pollTick(): void }).pollTick();
  await settle();
  expect(requests.length).toBeGreaterThan(afterFirst);
  store.dispose();
});

test("no_command_frames", async () => {
  const clientRoot = new URL("../", import.meta.url).pathname;
  const files = new Bun.Glob("**/*.{ts,svelte}").scanSync({
    cwd: clientRoot,
    absolute: true,
  });
  const socketFiles: string[] = [];
  const commandFrames: string[] = [];
  for (const file of files) {
    if (file.includes("node_modules")) continue;
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(file).text();
    if (text.includes("new WebSocket")) socketFiles.push(file);
    if (/JSON\.stringify\(\s*\{\s*type:/.test(text)) commandFrames.push(file);
  }
  expect(socketFiles.map((file) => file.split("/").pop())).toEqual(["run-output.svelte.ts"]);
  expect(commandFrames).toEqual([]);

  const requests: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  setGlobal(
    "WebSocket",
    class Untracked {
      constructor() {
        throw new Error("no command socket may be constructed");
      }
    },
  );
  setGlobal("document", fakeDocument("visible"));
  const store = new ConnectionStore();
  expect(store.send({ type: "getVersion" }, "initial")).toBe(true);
  await settle();
  expect(requests[0]).toBe("/version");
  expect(store.send({ type: "startIssues" }, "operator")).toBe(true);
  await settle();
  expect(requests[1]).toBe("/issues/workers");
  store.dispose();
});

test("stale_bundle_reloads_once", async () => {
  let reloads = 0;
  setGlobal("sessionStorage", fakeStorage());
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      reloads += 1;
    },
  });
  setGlobal("document", fakeDocument("visible"));
  setGlobal(
    "WebSocket",
    class Untracked {
      constructor() {
        throw new Error("no command socket may be constructed");
      }
    },
  );
  setGlobal("fetch", async () =>
    new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "The requested file was not found.",
      }),
      { status: 404, headers: { "content-type": "application/problem+json" } },
    ),
  );

  const store = new ConnectionStore();
  expect(isStaleBundleProblem(404, { method: "GET", path: "/version" })).toBe(true);
  expect(isStaleBundleProblem(404, undefined)).toBe(false);
  expect(isStaleBundleProblem(500, { method: "GET", path: "/version" })).toBe(false);

  store.send({ type: "getVersion" }, "initial");
  await settle();
  expect(reloads).toBe(1);
  store.send({ type: "getVersion" }, "initial");
  await settle();
  expect(reloads).toBe(1);
  expect(store.lastError).not.toBeNull();

  const storage = fakeStorage();
  let direct = 0;
  expect(reloadOnceForStaleBundle(storage, () => (direct += 1))).toBe(true);
  expect(reloadOnceForStaleBundle(storage, () => (direct += 1))).toBe(false);
  expect(direct).toBe(1);
  store.dispose();
});

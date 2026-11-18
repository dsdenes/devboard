import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { notifications } from "./notifications.svelte";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The connection store reads `document` as it constructs, so it loads after the
// DOM globals exist.
const { connection } = await import("./connection.svelte");
const { applyFrames } = await import("./frames");

const original = {
  fetch: globalThis.fetch,
  window: (globalThis as unknown as Record<string, unknown>).window,
  WebSocket: (globalThis as unknown as Record<string, unknown>).WebSocket,
  location: (globalThis as unknown as Record<string, unknown>).location,
  document: (globalThis as unknown as Record<string, unknown>).document,
  setTimeout: globalThis.setTimeout,
  now: Date.now,
};

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function restore(): void {
  setGlobal("fetch", original.fetch);
  setGlobal("window", original.window);
  setGlobal("WebSocket", original.WebSocket);
  setGlobal("location", original.location);
  setGlobal("document", original.document);
  setGlobal("setTimeout", original.setTimeout);
  Date.now = original.now;
}

function fakeDocument(): Document {
  return {
    visibilityState: "visible",
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
}

/** Resolves the promise chain the store starts without waiting on a real timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

interface Request {
  url: string;
  method: string;
}

/**
 * Replaces the watch's 250 ms probe delay with a queue the test drains, so one
 * `advance` is one probe round and the 30 s deadline never runs on a real clock.
 */
function deferredTimers(): { waits: Array<() => void>; advance(): void } {
  const waits: Array<() => void> = [];
  setGlobal(
    "setTimeout",
    ((handler: () => void) => {
      waits.push(handler);
      return 1;
    }) as unknown as typeof setTimeout,
  );
  return {
    waits,
    advance(): void {
      for (const resolve of waits.splice(0)) resolve();
    },
  };
}

function versionFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "versionState",
    running: "1.45.1",
    installed: "1.46.0",
    latest: "1.46.0",
    stale: true,
    ...extra,
  };
}

function receive(frame: Record<string, unknown>): void {
  // Every pushed frame reaches the same cache-then-stores path.
  applyFrames([frame as { type: string } & Record<string, unknown>]);
}

function count(requests: Request[], method: string, url: string): number {
  return requests.filter((request) => request.method === method && request.url === url).length;
}

beforeEach(() => {
  restore();
  setGlobal("window", {
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  setGlobal(
    "WebSocket",
    class Untracked {
      constructor() {
        throw new Error("no command socket may be constructed");
      }
    },
  );
  setGlobal("document", fakeDocument());
});

afterEach(() => {
  restore();
});

test("an accepted restart reloads once the answering pid changes", async () => {
  const requests: Request[] = [];
  // The pid that answered before the restart, then the process being replaced
  // answering one probe, then the replacement.
  const pids = [100, 100, 200];
  let answered = 0;
  let reloads = 0;
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      reloads += 1;
    },
  });
  setGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/ready") {
      if (method === "HEAD") return new Response(null, { status: 200 });
      const pid = pids[answered] ?? 200;
      answered += 1;
      return new Response(JSON.stringify({ pid }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/server-restarts") {
      return new Response(JSON.stringify({ frames: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const timers = deferredTimers();
  const store = connection;

  store.requestRestart();
  await settle();
  expect(requests.slice(0, 2)).toEqual([
    { url: "/ready", method: "GET" },
    { url: "/server-restarts", method: "POST" },
  ]);
  expect(answered).toBe(2);

  // The old process answers `/ready` throughout the handoff, so its 200 is not
  // the replacement: the first probe round issues the request and reloads
  // nothing.
  expect(count(requests, "HEAD", "/ready")).toBe(1);
  expect(reloads).toBe(0);
  expect(timers.waits).toHaveLength(1);

  // A frame carrying `restarting` joins the running watch instead of starting a
  // second one.
  receive(versionFrame({ restarting: true }));
  await settle();
  expect(store.restarting).toBe(true);
  expect(count(requests, "HEAD", "/ready")).toBe(1);
  expect(timers.waits.length).toBeGreaterThanOrEqual(1);

  timers.advance();
  await settle();
  expect(reloads).toBe(1);
  expect(count(requests, "GET", "/ready")).toBe(3);
  store.dispose();
});

test("a reported replacement failure clears the restart latch and resumes polling", async () => {
  const requests: Request[] = [];
  const failure = "The replacement could not start: the port was taken.";
  const frame = versionFrame({
    replacement: { running: "1.45.1", installed: "1.46.0", error: failure },
  });
  let reloads = 0;
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      reloads += 1;
    },
  });
  setGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/ready") {
      if (method === "HEAD") return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ pid: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/server-restarts") {
      return new Response(JSON.stringify({ frames: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/version") {
      return new Response(JSON.stringify({ frames: [frame] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const timers = deferredTimers();
  const store = connection;
  store.state = "open";
  receive(frame);
  await settle();
  expect(store.version?.replacement?.error).toBe(failure);
  expect(store.restarting).toBe(false);

  store.requestRestart();
  await settle();
  expect(store.restarting).toBe(true);
  expect(store.awaitingRestart).toBe(true);

  // The version query keeps reading through the restart, and its failure
  // frame is the only outcome that arrives: it clears both flags and records
  // the error.
  receive(frame);
  await settle();
  expect(store.restarting).toBe(false);
  expect(store.awaitingRestart).toBe(false);
  expect(store.lastError).toBe(failure);
  expect(reloads).toBe(0);

  timers.advance();
  await settle();
  expect(reloads).toBe(0);
  store.dispose();
});

test("a failure recorded after the watch's deadline reports its reason, not the timeout", async () => {
  const failure = "The replacement could not start: the port was never announced.";
  const frame = versionFrame({
    replacement: { running: "1.45.1", installed: "1.46.0", error: failure },
  });
  const requests: Request[] = [];
  let versionReads = 0;
  let reloads = 0;
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      reloads += 1;
    },
  });
  setGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/ready") {
      if (method === "HEAD") return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ pid: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/server-restarts") {
      return new Response(JSON.stringify({ frames: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/version") {
      versionReads += 1;
      return new Response(JSON.stringify({ frames: [frame] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const timers = deferredTimers();
  let now = original.now();
  Date.now = () => now;
  const store = connection;
  notifications.clear();
  store.state = "open";
  store.requestRestart();
  await settle();
  expect(store.restarting).toBe(true);

  // The old process keeps answering and no frame reaches the page: the watch
  // reaches its own deadline with the server's failure already recorded.
  now += 30_001;
  timers.advance();
  await settle();
  expect(versionReads).toBe(1);
  expect(store.awaitingRestart).toBe(false);
  expect(store.restarting).toBe(false);
  const errors = notifications.items.filter((item) => item.severity === "error");
  expect(errors.map((item) => item.text)).toEqual([failure]);
  expect(reloads).toBe(0);

  // The late frame reports nothing a second time and never contradicts it.
  receive(frame);
  await settle();
  expect(
    notifications.items.filter((item) => item.severity === "error").map((item) => item.text),
  ).toEqual([failure]);
  store.dispose();
});

test("a server that names no replacement failure still reports the timeout", async () => {
  const requests: Request[] = [];
  let versionReads = 0;
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => undefined,
  });
  setGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/ready") {
      if (method === "HEAD") return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ pid: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/server-restarts") {
      return new Response(JSON.stringify({ frames: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/version") versionReads += 1;
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const timers = deferredTimers();
  let now = original.now();
  Date.now = () => now;
  const store = connection;
  notifications.clear();
  store.state = "open";
  store.requestRestart();
  await settle();
  expect(store.restarting).toBe(true);

  now += 30_001;
  timers.advance();
  await settle();
  expect(versionReads).toBe(1);
  expect(store.restarting).toBe(false);
  expect(store.awaitingRestart).toBe(false);
  expect(store.state).toBe("open");
  expect(notifications.items.map((item) => item.text)).toEqual([
    "The replacement did not answer within 30 seconds.",
  ]);
  store.dispose();
});

test("a refused restart reports the answer's own message and starts no watch", async () => {
  const requests: Request[] = [];
  const refusal = "A server restart is already in progress.";
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      throw new Error("a refused restart reloads nothing");
    },
  });
  setGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/ready") {
      return new Response(JSON.stringify({ pid: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/server-restarts") {
      return new Response(
        JSON.stringify({
          frames: [{ type: "error", message: refusal, command: "restartServer" }],
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const timers = deferredTimers();
  const store = connection;
  const before = store.restartAnswerRevision;

  store.requestRestart();
  await settle();

  expect(store.lastError).toBe(refusal);
  expect(store.restarting).toBe(false);
  expect(store.awaitingRestart).toBe(false);
  expect(store.restartAnswerRevision).toBe(before + 1);
  // The refusal is the whole answer: no handoff watch is started, so the
  // replacement probe never runs and no 30-second notice can follow.
  timers.advance();
  await settle();
  expect(count(requests, "HEAD", "/ready")).toBe(0);
  expect(store.awaitingRestart).toBe(false);
  store.dispose();
});

test("a restart whose fetch throws reports it and settles the answer revision", async () => {
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      throw new Error("a failed request reloads nothing");
    },
  });
  setGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/ready") {
      return new Response(JSON.stringify({ pid: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new TypeError("the network is down");
  }) as typeof fetch);
  const timers = deferredTimers();
  const store = connection;
  const before = store.restartAnswerRevision;

  store.requestRestart();
  await settle();

  expect(store.lastError).toBe("Could not reach the server.");
  expect(store.restarting).toBe(false);
  expect(store.awaitingRestart).toBe(false);
  expect(store.restartAnswerRevision).toBe(before + 1);
  // A thrown fetch never starts the watch, so nothing waits on a replacement.
  timers.advance();
  await settle();
  expect(store.awaitingRestart).toBe(false);
  store.dispose();
});

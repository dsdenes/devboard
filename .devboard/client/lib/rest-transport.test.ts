import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlowUiActionSink } from "./slow-ui-action";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { ConnectionStore } = await import("./connection.svelte");
const { isStaleBundleProblem, reloadOnceForStaleBundle } = await import("./stale-bundle");
const { SLOW_UI_ACTION_BUDGET_MS, slowUiAction } = await import("./slow-ui-action");

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
  slowUiAction.uninstall();
  jest.useRealTimers();
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

test("first_paint_reads_precede_surface_reads", async () => {
  // A browser opens six connections to one origin and queues the rest. The
  // six first-paint reads must take those six, because a read that queues
  // behind a slow mode read breaches its 1000 ms budget even when its own
  // handler answers in milliseconds.
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
  store.onOpen(() => {
    store.send({ type: "getIssues" }, "refresh");
    store.send({ type: "getAgents" }, "refresh");
  });
  store.connect();
  await settle();
  expect(requests).toEqual([
    "/records",
    "/goal",
    "/skills",
    "/project",
    "/version",
    "/providers",
    "/issues",
    "/agents",
  ]);
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

const DRAFT_PATH = ".devboard/goal-proposals/example.md";
const DRAFT_URL = "/goal-drafts/.devboard%2Fgoal-proposals%2Fexample.md";

/** The slow-action sink: it records the breach a page would have filed. */
function breachSink(breaches: string[]): SlowUiActionSink {
  return {
    reportingEnabled: () => false,
    captureContext: () => ({
      route: "/",
      url: "http://test.invalid/",
      selector: "#issues-draft",
      domExcerpt: '<button data-testid="issues-draft"></button>',
      visibleText: "example.md",
      viewport: "800x600 @1x",
      capturedAt: "2026-11-08T08:07:19.675Z",
    }),
    show: (notice) => {
      breaches.push(notice.text);
      return breaches.length;
    },
    update: () => undefined,
    file: async () => ({ ok: false as const, error: "reporting is off" }),
  };
}

/** The HTTP transport with the DOM globals a page read touches. */
function installHttpTransport(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  setGlobal("fetch", handler);
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
}

test("a repeated operator read asks for the draft instead of a validator", async () => {
  jest.useFakeTimers();
  const validators: Array<string | null> = [];
  // The server answers a matching If-None-Match with 304 and no body, exactly
  // as `representation` does.
  installHttpTransport(async (_input, init) => {
    const validator = new Headers(init?.headers).get("if-none-match");
    validators.push(validator);
    if (validator === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    return new Response(
      JSON.stringify({
        frames: [
          { type: "issuesDraftDetail", draft: { path: DRAFT_PATH, name: "example.md", text: "text" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json", etag: '"v1"' } },
    );
  });

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  const store = new ConnectionStore();
  store.state = "open";
  const frames: string[] = [];
  store.onMessage((message) => {
    frames.push(String(message.type));
  });

  // `openDraft` drops the text before it reads the draft again, so the second
  // read is a request for the representation and never a revalidation.
  store.send({ type: "getGoalDraft", path: DRAFT_PATH });
  await settle();
  store.send({ type: "getGoalDraft", path: DRAFT_PATH });
  await settle();

  expect(validators).toEqual([null, null]);
  expect(frames).toEqual(["issuesDraftDetail", "issuesDraftDetail"]);
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(breaches).toEqual([]);

  store.dispose();
});

test("a read answered with a problem completes without filing it as slow", async () => {
  jest.useFakeTimers();
  installHttpTransport(async () =>
    new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "The draft is being elaborated.",
      }),
      { status: 409, headers: { "content-type": "application/problem+json" } },
    ),
  );

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  const store = new ConnectionStore();
  store.state = "open";

  store.send({ type: "getGoalDraft", path: DRAFT_PATH });
  await settle();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(breaches).toEqual([]);
  expect(store.lastError).toBe("The draft is being elaborated.");

  store.dispose();
});

test("a draft read that never answers still files one issue at the budget", async () => {
  jest.useFakeTimers();
  installHttpTransport(() => new Promise<Response>(() => undefined));

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  const store = new ConnectionStore();
  store.state = "open";

  store.send({ type: "getGoalDraft", path: DRAFT_PATH });
  await settle();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS - 1);
  expect(breaches).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(breaches).toEqual([
    `Slow UI action: getGoalDraft ${DRAFT_PATH} exceeded the ${SLOW_UI_ACTION_BUDGET_MS} ms budget.`,
  ]);

  store.dispose();
});

test("a read whose connection was lost files no slow action", async () => {
  jest.useFakeTimers();
  // A replacement's page load reaches a listener with no server behind it: the
  // request settles without an answer, so it measured no server work.
  installHttpTransport(async () => {
    throw new TypeError("Failed to fetch");
  });

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  const store = new ConnectionStore();
  store.state = "open";

  store.send({ type: "refreshAgent", id: "release-train" });
  await settle();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(breaches).toEqual([]);
  expect(store.lastError).toBe("Could not reach the server.");

  store.dispose();
});

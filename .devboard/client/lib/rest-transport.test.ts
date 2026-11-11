import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlowUiActionSink } from "./slow-ui-action";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { ConnectionStore } = await import("./connection.svelte");
const { isStaleBundleProblem, reloadOnceForStaleBundle } = await import("./stale-bundle");
const { notifications } = await import("./notifications.svelte");
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
  expect(socketFiles.map((file) => file.split("/").pop())).toEqual([]);
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
  store.state = "open";
  expect(store.send({ type: "getVersion" }, "initial")).toBe(true);
  await settle();
  expect(requests[0]).toBe("/version");
  expect(store.send({ type: "startIssues" }, "operator")).toBe(true);
  await settle();
  expect(requests[1]).toBe("/issues/workers");
  store.dispose();
});

test("provider creates post to the collection and edits put to the item", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  installHttpTransport(async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ frames: [] }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });

  const store = new ConnectionStore();
  expect(
    store.send(
      {
        type: "createProvider",
        requestId: 1,
        provider: "opencode-go",
        label: "main",
        key: "sk-test",
      },
      "operator",
    ),
  ).toBe(true);
  await settle();
  expect(
    store.send(
      {
        type: "saveProvider",
        id: "subscription-1",
        requestId: 2,
        provider: "opencode-go",
        label: "main",
      },
      "operator",
    ),
  ).toBe(true);
  await settle();

  expect(calls).toEqual([
    {
      method: "POST",
      url: "/providers",
      body: { requestId: 1, provider: "opencode-go", label: "main", key: "sk-test" },
    },
    {
      method: "PUT",
      url: "/providers/subscription-1",
      body: { requestId: 2, provider: "opencode-go", label: "main" },
    },
  ]);
  store.dispose();
});

test("an open reads the project path and every planned resource once", async () => {
  // The page reads what its surfaces show, in one pass: the once-per-connect
  // project path and one read per planned resource. Nothing else is read, and
  // a read dispatched before the connect waits for the open.
  const issued: string[] = [];
  installHttpTransport(async (input) => {
    issued.push(String(input));
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const store = new ConnectionStore();
  store.setSurfaceClaims([
    { command: { type: "getIssues" }, scope: "body" },
    { command: { type: "getAgents" }, scope: "background" },
  ]);
  store.send({ type: "getIssues" }, "refresh");
  await settle();
  expect(issued).toEqual([]);

  store.connect();
  await settle();
  expect([...issued].sort()).toEqual(["/agents", "/issues", "/project"]);
  store.dispose();
});

/** The body-scoped reads the plan below claims. */
const PLANNED_COMMANDS = [
  "getIssues",
  "getAgents",
  "getComplexity",
  "getInstalledSkills",
  "getMcpTools",
  "getGoalDrafts",
  "getResources",
];
const PLANNED_PATHS = [
  "/issues",
  "/agents",
  "/complexity",
  "/installed-skills",
  "/mcp-tools",
  "/goal-drafts",
  "/resources",
];

/**
 * One origin's connections. A browser opens six and queues every request past
 * them; a request starts when a slot frees and answers only when released.
 */
interface OriginPool {
  started: string[];
  inFlight(): number;
  request(input: RequestInfo | URL): Promise<Response>;
  releaseOne(): void;
}

function originPool(limit: number): OriginPool {
  const started: string[] = [];
  const waiting: Array<() => void> = [];
  const open: Array<() => void> = [];
  let connections = 0;
  const admit = (): void => {
    while (connections < limit && waiting.length > 0) {
      const start = waiting.shift();
      if (start === undefined) return;
      connections += 1;
      start();
    }
  };
  return {
    started,
    inFlight: () => connections,
    request: (input) => {
      const { promise, resolve } = Promise.withResolvers<Response>();
      waiting.push(() => {
        started.push(String(input));
        open.push(() => {
          connections -= 1;
          resolve(
            new Response(JSON.stringify({ frames: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
          admit();
        });
      });
      admit();
      return promise;
    },
    releaseOne: () => open.shift()?.(),
  };
}

async function drainPool(pool: OriginPool): Promise<void> {
  for (let round = 0; round < 200 && pool.inFlight() > 0; round += 1) {
    pool.releaseOne();
    await settle();
  }
  await settle();
}

test("a planned poll cycle never holds every origin connection", async () => {
  // A browser queues every request past its six connections. A tick that
  // dispatches its whole plan at once takes all six, so the read the operator
  // waits on queues behind the page's own refreshes: the server answered
  // /providers in 5 ms while the page waited 842 ms. The plan drains through
  // the page's reserved three, so the foreground read starts at once.
  const pool = originPool(6);
  installHttpTransport((input) => pool.request(input));

  const store = new ConnectionStore();
  store.setSurfaceClaims(
    PLANNED_COMMANDS.map((type) => ({ command: { type }, scope: "body" as const })),
  );
  store.state = "open";
  await settle();
  const before = pool.started.length;
  expect(before).toBe(0);

  (store as unknown as { pollTick(): void }).pollTick();
  await settle();
  const refreshing = pool.started.length - before;
  expect(refreshing).toBeGreaterThan(0);
  expect(refreshing).toBeLessThan(6);

  // The foreground read starts while the refreshes run instead of queueing.
  store.send({ type: "getProviders" });
  await settle();
  expect(pool.started).toContain("/providers");

  // Every planned read still runs as its slot frees.
  await drainPool(pool);
  expect(pool.started.slice(before)).toEqual(expect.arrayContaining(PLANNED_PATHS));
  store.dispose();
});

test("a page's own read is not queued behind the open's planned reads", async () => {
  // A page load reads every planned resource at once, and the six connections
  // a browser opens are then all busy. A read the page dispatches at mount —
  // the Resources tab asks for its budget as it mounts — joined the back of
  // that queue: /issues measured 970 ms and /goal-drafts 4469 ms on one live
  // load, so getResources waited more than a second for a connection the
  // server answers in 2 ms. The open holds at most three connections, so the
  // page's own read starts on the first freed one.
  const pool = originPool(6);
  const issued: string[] = [];
  installHttpTransport((input) => {
    issued.push(String(input));
    return pool.request(input);
  });

  const store = new ConnectionStore();
  store.setSurfaceClaims(
    PLANNED_COMMANDS.map((type) => ({ command: { type }, scope: "body" as const })),
  );
  store.connect();
  store.send({ type: "getResources" });
  await settle();

  // The project read leads, the page's own read starts before the planned
  // queue drains, and the open holds at most its reserved three plus it.
  expect(issued[0]).toBe("/project");
  expect(issued).toContain("/resources");
  expect(issued.length).toBeLessThanOrEqual(4);

  // The planned reads still run once slots free, and the open never holds more
  // connections than a tick already may.
  await drainPool(pool);
  expect(pool.inFlight()).toBe(0);
  expect(issued).toEqual(expect.arrayContaining(PLANNED_PATHS));
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
  store.state = "open";
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

test("an_operation_without_its_path_parameter_is_refused", async () => {
  const requested: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    requested.push(String(input));
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
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });
  setGlobal("document", fakeDocument("visible"));

  const store = new ConnectionStore();
  store.state = "open";
  expect(store.send({ type: "getIssuesRun" }, "operator")).toBe(false);
  expect(store.send({ type: "getIssuesRun", runId: "" }, "operator")).toBe(false);
  await settle();
  expect(requested).toEqual([]);
  expect(store.lastError).toBe("This action is missing its runId.");

  expect(store.send({ type: "getIssuesRun", runId: "run-1" }, "operator")).toBe(true);
  await settle();
  expect(requested).toEqual(["/issues/runs/run-1"]);
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

test("a body cut mid-answer is a lost connection, not an unreadable body", async () => {
  // A server that exits or hands its port over while a response streams leaves
  // the answer short. That is the reconnect the page already handles, so it
  // raises no error notification and files nothing.
  installHttpTransport(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"frames":['));
        controller.error(new TypeError("The connection closed."));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  notifications.clear();

  const store = new ConnectionStore();
  store.state = "open";
  const frames: string[] = [];
  store.onMessage((message) => frames.push(String(message.type)));

  store.send({ type: "getVersion" }, "initial");
  await settle();
  expect(frames).toEqual([]);
  expect(store.lastError).toBe("Could not reach the server.");
  expect(notifications.items.map((item) => item.severity)).toEqual(["warning"]);

  notifications.clear();
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

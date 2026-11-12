import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load the rune modules first and capture the wrong document.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { connection } = await import("./connection.svelte");
const { mutationFor } = await import("./command-mutations");
const { queryClient } = await import("./query-client");
const { readResource, sendCommand } = await import("./rest-transport");
const { isStaleBundleProblem, reloadOnceForStaleBundle } = await import("./stale-bundle");
const { notifications } = await import("./notifications.svelte");
const { SLOW_UI_ACTION_BUDGET_MS, slowUiAction } = await import("./slow-ui-action");
import type { SlowUiActionSink } from "./slow-ui-action";

/** Resolves the promise chains a send starts without waiting on a real timer. */
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

/** The HTTP transport with the DOM globals a page request touches. */
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
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });
}

function jsonFrames(frames: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ frames }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  restore();
});
afterEach(() => {
  slowUiAction.uninstall();
  jest.useRealTimers();
  cleanup();
  queryClient.clear();
  connection.dispose();
  restore();
});

test("only_the_transport_calls_fetch", async () => {
  const clientRoot = new URL("../", import.meta.url).pathname;
  const files = new Bun.Glob("**/*.{ts,svelte}").scanSync({
    cwd: clientRoot,
    absolute: true,
  });
  const socketFiles: string[] = [];
  const fetchFiles: string[] = [];
  const schedulerFiles: string[] = [];
  for (const file of files) {
    if (file.includes("node_modules")) continue;
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(file).text();
    if (text.includes("new WebSocket")) socketFiles.push(file);
    if (text.includes("fetch(") && !file.endsWith("rest-transport.ts")) {
      fetchFiles.push(file);
    }
    if (text.includes("setSurfaceClaims") || text.includes("connection.claim(")) {
      schedulerFiles.push(file);
    }
  }
  expect(socketFiles.map((file) => file.split("/").pop())).toEqual([]);
  expect(fetchFiles.map((file) => file.split("/").pop())).toEqual([]);
  expect(schedulerFiles.map((file) => file.split("/").pop())).toEqual([]);
});

test("a_command_posts_its_method_and_fields", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  installHttpTransport(async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return jsonFrames([], 201);
  });

  await sendCommand({
    type: "createProvider",
    requestId: 1,
    provider: "opencode-go",
    label: "main",
    key: "sk-test",
  });
  await sendCommand({
    type: "saveProvider",
    id: "subscription-1",
    requestId: 2,
    provider: "opencode-go",
    label: "main",
  });

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
});

test("a_read_answers_its_frames_and_a_problem_is_an_error", async () => {
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
  await expect(readResource({ type: "getGoalDraft", path: "a.md" })).rejects.toThrow(
    "The draft is being elaborated.",
  );

  installHttpTransport(async () =>
    jsonFrames([{ type: "versionState", running: "1.0.0" }]),
  );
  const frames = await readResource({ type: "getVersion" });
  expect(frames).toEqual([{ type: "versionState", running: "1.0.0" }]);
});

test("a_stale_bundle_reloads_once", async () => {
  let reloads = 0;
  installHttpTransport(async () =>
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

  setGlobal("sessionStorage", fakeStorage());
  setGlobal("location", {
    protocol: "http:",
    host: "test.invalid",
    reload: () => {
      reloads += 1;
    },
  });
  expect(
    isStaleBundleProblem(404, { method: "GET", path: "/version" }),
  ).toBe(true);
  expect(isStaleBundleProblem(404, undefined)).toBe(false);
  expect(
    isStaleBundleProblem(500, { method: "GET", path: "/version" }),
  ).toBe(false);

  expect(await readResource({ type: "getVersion" })).toEqual([]);
  expect(reloads).toBe(1);
  // The one reload is spent: a second refusal is the page's own frame and is
  // reported, never a reload loop.
  await expect(readResource({ type: "getVersion" })).rejects.toThrow(
    "The requested file was not found.",
  );
  expect(reloads).toBe(1);

  const storage = fakeStorage();
  let direct = 0;
  expect(reloadOnceForStaleBundle(storage, () => (direct += 1))).toBe(true);
  expect(reloadOnceForStaleBundle(storage, () => (direct += 1))).toBe(false);
  expect(direct).toBe(1);
});

test("an_operation_without_its_path_parameter_is_refused", async () => {
  const requested: string[] = [];
  installHttpTransport(async (input) => {
    requested.push(String(input));
    return jsonFrames([]);
  });
  connection.connect();

  expect(connection.send({ type: "getIssuesRun" }, "operator")).toBe(false);
  expect(connection.send({ type: "getIssuesRun", runId: "" }, "operator")).toBe(false);
  await settle();
  expect(requested).toEqual([]);
  expect(connection.lastError).toBe("This action is missing its runId.");

  expect(connection.send({ type: "answerIssues", id: 1, value: "x" }, "operator")).toBe(false);
  expect(requested).toEqual([]);
});

test("a_command_runs_as_a_mutation_and_refetches_only_its_resources", async () => {
  const reads: string[] = [];
  installHttpTransport(async (input) => {
    reads.push(String(input));
    return jsonFrames([]);
  });
  render(QueryHarness);
  connection.connect();
  await settle();

  const mutation = mutationFor("startIssues");
  expect(mutation).toBeDefined();
  const before = { issues: reads.filter((p) => p === "/issues").length, goal: reads.filter((p) => p === "/goal").length };
  const settled = Promise.withResolvers<void>();
  mutation?.mutate({ type: "startIssues" }, settled.resolve);
  await settled.promise;
  await settle();

  expect(reads.filter((p) => p === "/issues").length).toBe(before.issues + 1);
  expect(reads.filter((p) => p === "/goal").length).toBe(before.goal);
});

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

test("a_stalled_command_files_one_slow_action_at_the_budget", async () => {
  jest.useFakeTimers();
  installHttpTransport(() => new Promise<Response>(() => undefined));
  render(QueryHarness);
  connection.connect();
  await settle();

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  expect(connection.send({ type: "startIssues" }, "operator")).toBe(true);
  await settle();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS - 1);
  expect(breaches).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(breaches).toEqual([
    `Slow UI action: startIssues exceeded the ${SLOW_UI_ACTION_BUDGET_MS} ms budget.`,
  ]);
});

test("a_command_whose_connection_was_lost_files_no_slow_action", async () => {
  jest.useFakeTimers();
  installHttpTransport(async () => {
    throw new TypeError("Failed to fetch");
  });
  render(QueryHarness);
  connection.connect();
  await settle();
  notifications.clear();

  const breaches: string[] = [];
  slowUiAction.install(breachSink(breaches));
  expect(connection.send({ type: "refreshAgent", id: "release-train" }, "operator")).toBe(true);
  await settle();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(breaches).toEqual([]);
  expect(connection.lastError).toBe("Could not reach the server.");
});

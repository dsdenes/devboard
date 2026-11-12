import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { default: SharedResourceHarness } = await import("./components/SharedResourceHarness.svelte");
const { applyFrames } = await import("./frames");
const { connection } = await import("./connection.svelte");
const { layout } = await import("./layout.svelte");
const { plannedQueries } = await import("./poll-plan");
const { queryClient } = await import("./query-client");
const { RESOURCE_CADENCE_MS, cadenceFor } = await import("./cadence");
const { SLOW_UI_ACTION_BUDGET_MS } = await import("./slow-ui-action");
const { COMMAND_CEILING_MS } = await import("./command-busy.svelte");

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

const realWindow = (globalThis as unknown as Record<string, unknown>).window;

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function installFetch(handler: (input: RequestInfo | URL) => Promise<Response>): string[] {
  const reads: string[] = [];
  setGlobal("fetch", (input: RequestInfo | URL) => {
    reads.push(String(input));
    return handler(input);
  });
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });
  return reads;
}

function frames(frames: unknown[]): Response {
  return new Response(JSON.stringify({ frames }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  connection.state = "closed";
  layout.reset();
  setGlobal("window", realWindow);
});

test("two surfaces showing one resource cost one request", async () => {
  const reads = installFetch(async () => frames([]));
  render(SharedResourceHarness);
  await settle();
  expect(reads).toEqual(["/issues"]);
});

test("two concurrent mounts of one key share the in-flight request", async () => {
  const reads: string[] = [];
  const held = Promise.withResolvers<void>();
  installFetch((input) => {
    reads.push(String(input));
    return held.promise.then(() => frames([]));
  });
  render(SharedResourceHarness);
  await settle();
  expect(reads).toEqual(["/issues"]);
  held.resolve();
  await settle();
  expect(reads).toEqual(["/issues"]);
});

test("a pushed frame writes the cache and issues no request", async () => {
  const reads = installFetch(async () => frames([]));
  connection.state = "open";
  queryClient.clear();
  applyFrames([
    {
      type: "issuesState",
      root: "/repo",
      lifecycle: "idle",
      enabled: true,
      queue: [],
      runs: [],
    },
  ]);
  expect(reads).toEqual([]);
  expect(queryClient.getQueryData(["getIssues", "/issues"])).toMatchObject({
    type: "issuesState",
    lifecycle: "idle",
  });
});

test("a resource no surface shows issues no request", async () => {
  const reads = installFetch(async () => frames([]));
  layout.reset();
  layout.setMode("goal");
  render(QueryHarness);
  connection.connect();
  await settle();
  expect(reads).not.toContain("/mcp-tools");
  expect(reads).not.toContain("/resources");
  expect(
    plannedQueries().some((query) => query.command.type === "getMcpTools"),
  ).toBe(false);
});

test("the effective interval is the finest cadence of the surfaces showing a resource", async () => {
  // The table is the contract: getIssues is the always-mounted background
  // chrome's 10,000 ms and the Issues body's 2,000 ms.
  expect(RESOURCE_CADENCE_MS.getIssues).toEqual({ background: 10_000, body: 2_000, live: 0 });
  expect(cadenceFor("getIssues", "background")).toBe(10_000);
  expect(cadenceFor("getIssues", "body")).toBe(2_000);

  layout.reset();
  layout.setMode("goal");
  render(QueryHarness);
  connection.connect();
  await settle();
  const background = plannedQueries().find((query) => query.command.type === "getIssues");
  expect(background?.interval).toBe(10_000);

  layout.setMode("issues");
  layout.openTab("issues", {
    id: "overview",
    kind: "overview",
    resourceId: "overview",
    title: "Overview",
  });
  await settle();
  const body = plannedQueries().find((query) => query.command.type === "getIssues");
  expect(body?.interval).toBe(2_000);
  // The remaining rows are the table's, unchanged.
  for (const [type, row] of Object.entries(RESOURCE_CADENCE_MS)) {
    if (type === "getIssues") continue;
    expect(cadenceFor(type, "background")).toBe(row.background);
    expect(cadenceFor(type, "body")).toBe(row.body);
    expect(cadenceFor(type, "live")).toBe(row.live);
  }
});

test("a live run keeps the one-second run-output refresh", async () => {
  expect(SLOW_UI_ACTION_BUDGET_MS).toBe(1_000);
  expect(COMMAND_CEILING_MS).toBe(10_000);
  expect(cadenceFor("getIssuesRun", "live")).toBe(1_000);
  layout.reset();
  layout.setMode("issues");
  layout.openTab("issues", {
    id: "agent:run-live",
    kind: "agent",
    resourceId: "run-live",
    title: "#1 live run",
  });
  const { issues } = await import("./issues.svelte");
  issues.snapshot = {
    agents: [{ runId: "run-live" }],
    runs: [],
  } as unknown as Parameters<typeof JSON.stringify>[0];
  await settle();
  const live = plannedQueries().find((query) => query.command.type === "getIssuesRun");
  expect(live?.interval).toBe(1_000);
  issues.snapshot = null;
});

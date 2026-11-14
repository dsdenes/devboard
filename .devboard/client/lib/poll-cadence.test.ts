import { afterEach, expect, test } from "bun:test";
import { Event as DomEvent } from "happy-dom";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers the DOM globals before these modules evaluate; a
// static import would load the rune modules first and capture the wrong
// document.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { default: AgentPromptSection } = await import("./components/AgentPromptSection.svelte");
const { connection } = await import("./connection.svelte");
const { queryClient } = await import("./query-client");
const { installVisibilityCadence } = await import("./query-client");
const { plannedQueries } = await import("./poll-plan");
const { goalDrafts } = await import("./goal-drafts.svelte");

// The app root installs the visibility cadence; the plan tests read the same
// focus state the page uses to stop while hidden.
installVisibilityCadence();
const { layout } = await import("./layout.svelte");
const { agents } = await import("./agents.svelte");
const { issues } = await import("./issues.svelte");
const { flow } = await import("./flow.svelte");
const { discover } = await import("./discover.svelte");
const { REST_OPERATIONS } = await import("./rest-map");
const { RESOURCE_CADENCE_MS, ONE_SHOT_READS, cadenceFor } = await import("./cadence");
const { pollClaims } = await import("./poll-plan");

import type { AgentSnapshot, DiscoverStatePayload, IssuesSnapshot, Mode } from "./types";
import type { WorkspaceTab } from "./layout.svelte";

/** Resolves the promise chains a read starts without waiting on real timers. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

interface Timer {
  at: number;
  every: number;
  run: () => void;
}

/**
 * The browser's timers and clock, driven by hand. `Date.now` and every timer
 * callback move together, so a cadence asserted over a fake window is the one
 * the page would keep over a real one.
 */
class Clock {
  now = 0;
  private next = 1;
  private timers = new Map<number, Timer>();

  window = {
    setInterval: (handler: () => void, ms: number): number => this.add(handler, ms, ms),
    clearInterval: (id: number): boolean => this.timers.delete(id),
    setTimeout: (handler: () => void, ms: number): number => this.add(handler, ms, 0),
    clearTimeout: (id: number): boolean => this.timers.delete(id),
  };

  /** Installs the clock as the platform timers too: the query core schedules
   * its own intervals through the global functions. */
  installGlobals(): void {
    setGlobal("setInterval", this.window.setInterval);
    setGlobal("clearInterval", this.window.clearInterval);
    setGlobal("setTimeout", this.window.setTimeout);
    setGlobal("clearTimeout", this.window.clearTimeout);
  }

  private add(handler: () => void, ms: number, every: number): number {
    const id = this.next;
    this.next += 1;
    this.timers.set(id, { at: this.now + ms, every, run: handler });
    return id;
  }

  /** Runs every timer due inside the window, one settle behind each firing. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueId = 0;
      let due: Timer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (due === null || timer.at < due.at) {
          due = timer;
          dueId = id;
        }
      }
      if (due === null) break;
      this.now = due.at;
      if (due.every > 0) due.at += due.every;
      else this.timers.delete(dueId);
      due.run();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

const realWindow = (globalThis as unknown as Record<string, unknown>).window;
const realFetch = globalThis.fetch;
const realNow = Date.now;
const realTimers = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/** Records every GET path the page issues and answers it with no frames. */
function recordPaths(): string[] {
  const paths: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    if (process.env.DEVBOARD_TRACE_READS) console.trace("fetch", String(input));
    paths.push(String(input));
    return new Response(JSON.stringify({ frames: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return paths;
}

/** Records the same reads but answers none of them until `release`. */
function holdReads(): { paths: string[]; release: () => Promise<void> } {
  const paths: string[] = [];
  const waiting: Array<() => void> = [];
  setGlobal("fetch", (input: RequestInfo | URL) => {
    paths.push(String(input));
    const { promise, resolve } = Promise.withResolvers<Response>();
    waiting.push(() =>
      resolve(
        new Response(JSON.stringify({ frames: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    return promise;
  });
  return {
    paths,
    release: async () => {
      while (waiting.length > 0) {
        waiting.shift()?.();
        await settle();
      }
    },
  };
}

interface Page {
  paths: string[];
  clock: Clock;
  release?: () => Promise<void>;
}

/**
 * Mounts the page's one poll planner over the given mode and tab, then opens
 * the connection: the plan is what the surfaces on screen claim, and the open
 * reads it once.
 */
async function openPage(
  mode: Mode,
  tab?: WorkspaceTab,
  transport: "instant" | "held" = "instant",
): Promise<Page> {
  const clock = new Clock();
  setGlobal("window", clock.window);
  clock.installGlobals();
  Date.now = () => clock.now;
  queryClient.clear();
  const held = transport === "held" ? holdReads() : null;
  const paths = held === null ? recordPaths() : null;
  layout.reset();
  layout.setMode(mode);
  if (tab !== undefined) layout.openTab(mode, tab);
  render(QueryHarness);
  await settle();
  connection.connect();
  await settle();
  return { paths: held?.paths ?? paths ?? [], clock, release: held?.release };
}

/** How many reads the page issued for one path. */
function reads(paths: readonly string[], path: string): number {
  return paths.filter((entry) => entry === path).length;
}

/** Every recorded path and its count, for a failure that shows the window. */
function tally(paths: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of paths) counts[path] = (counts[path] ?? 0) + 1;
  return counts;
}

/** Asserts one path's reads fall inside the table's tolerance. */
function expectCadence(
  paths: readonly string[],
  path: string,
  min: number,
  max: number,
): void {
  const actual = reads(paths, path);
  if (actual < min || actual > max) {
    throw new Error(
      `${path}: ${actual} reads, expected ${min}..${max}; recorded ${JSON.stringify(tally(paths))}`,
    );
  }
}

/** Asserts one path nothing on screen claims recorded no read at all. */
function expectSilent(paths: readonly string[], path: string): void {
  expect({ path, reads: reads(paths, path) }).toEqual({ path, reads: 0 });
}

const GOAL_IMPLEMENTATION: WorkspaceTab = {
  id: "overview",
  kind: "overview",
  resourceId: "overview",
  title: "Implementation",
};

const ISSUES_OVERVIEW: WorkspaceTab = {
  id: "overview",
  kind: "overview",
  resourceId: "overview",
  title: "Overview",
};

const DEVBOARD_MCP: WorkspaceTab = {
  id: "tools",
  kind: "mcp-tools",
  resourceId: "tools",
  title: "MCP tools",
};

const DEVBOARD_SCOUT: WorkspaceTab = {
  id: "scout",
  kind: "scout",
  resourceId: "scout",
  title: "Auto Scout",
};

const DEVBOARD_RESOURCES: WorkspaceTab = {
  id: "resources",
  kind: "devboard-resources",
  resourceId: "resources",
  title: "Resources",
};

const DEVBOARD_SKILLS: WorkspaceTab = {
  id: "devboard-skills",
  kind: "devboard-skills",
  resourceId: "devboard-skills",
  title: "Skills",
};

const DEVBOARD_COMPLEXITY: WorkspaceTab = {
  id: "complexity",
  kind: "devboard-complexity",
  resourceId: "complexity",
  title: "Complexity",
};

/** One agent page whose agent reports the given lifecycle. */
function liveAgent(lifecycle: string): AgentSnapshot {
  return { lifecycle, paused: false } as unknown as AgentSnapshot;
}

function hideDocument(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    value: hidden ? "hidden" : "visible",
    configurable: true,
  });
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  connection.state = "closed";
  layout.reset();
  agents.snapshots = {};
  agents.requestedPrompts = [];
  goalDrafts.clearDraft();
  issues.snapshot = null;
  issues.selectedRun = null;
  issues.run = null;
  issues.runError = null;
  issues.resetActiveOperations();
  flow.status = "none";
  flow.goalCreation = null;
  discover.active = false;
  discover.starting = false;
  discover.runningAll = false;
  Date.now = realNow;
  setGlobal("window", realWindow);
  setGlobal("fetch", realFetch);
  setGlobal("setInterval", realTimers.setInterval);
  setGlobal("clearInterval", realTimers.clearInterval);
  setGlobal("setTimeout", realTimers.setTimeout);
  setGlobal("clearTimeout", realTimers.clearTimeout);
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "hidden");
});

test("cadence table accounts for every GET operation the client reads", () => {
  const gets = Object.entries(REST_OPERATIONS)
    .filter(([, operation]) => operation.method === "GET")
    .map(([type]) => type);
  const unaccounted = gets.filter(
    (type) => RESOURCE_CADENCE_MS[type] === undefined && ONE_SHOT_READS[type] !== true,
  );
  expect(unaccounted).toEqual([]);
  for (const [type, row] of Object.entries(RESOURCE_CADENCE_MS)) {
    expect({ type, method: REST_OPERATIONS[type]?.method }).toEqual({ type, method: "GET" });
    expect(row.background + row.body + row.live).toBeGreaterThan(0);
  }
  // No resource falls back to a default cadence: an operation the table does
  // not name has no cadence in any scope.
  expect(cadenceFor("getAgent", "background")).toBe(0);
  expect(cadenceFor("startIssues", "body")).toBe(0);
});

test("cadence claims never fall back to a default cadence", () => {
  layout.reset();
  layout.setMode("goal");
  for (const claim of pollClaims()) {
    expect(cadenceFor(claim.command.type, claim.scope)).toBeGreaterThan(0);
  }
});

test("cadence of the Goal mode: background chrome and the Implementation body", async () => {
  const page = await openPage("goal", GOAL_IMPLEMENTATION);
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/goal", 29, 31);
  expectCadence(page.paths, "/records", 5, 7);
  expectCadence(page.paths, "/skills", 5, 7);
  expectCadence(page.paths, "/issues", 5, 7);
  expectCadence(page.paths, "/flows", 5, 7);
  expectCadence(page.paths, "/discoveries/workspace", 5, 7);
  expectCadence(page.paths, "/goal-drafts", 5, 7);
  expectCadence(page.paths, "/version", 1, 3);
  expectCadence(page.paths, "/agents", 0, 2);
  expectCadence(page.paths, "/providers", 0, 2);
  expectCadence(page.paths, "/project", 1, 1);
  for (const path of ["/installed-skills", "/resources", "/complexity", "/mcp-tools"]) {
    expectSilent(page.paths, path);
  }
  expect(page.paths.filter((path) => path.startsWith("/issues/runs/"))).toEqual([]);
});

test("cadence of the Issues Overview body", async () => {
  const page = await openPage("issues", ISSUES_OVERVIEW);
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/issues", 29, 31);
  expectCadence(page.paths, "/goal", 5, 7);
  expectCadence(page.paths, "/flows", 5, 7);
  expectCadence(page.paths, "/discoveries/workspace", 5, 7);
  expectCadence(page.paths, "/goal-drafts", 5, 7);
  expectCadence(page.paths, "/version", 1, 3);
  expectCadence(page.paths, "/agents", 0, 2);
  expectCadence(page.paths, "/providers", 0, 2);
  for (const path of [
    "/records",
    "/skills",
    "/installed-skills",
    "/resources",
    "/complexity",
    "/mcp-tools",
  ]) {
    expectSilent(page.paths, path);
  }
});

test("cadence of the Devboard Auto Scout body", async () => {
  const page = await openPage("devboard", DEVBOARD_SCOUT);
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/agents", 11, 13);
  expectCadence(page.paths, "/goal", 5, 7);
  expectCadence(page.paths, "/issues", 5, 7);
  expectCadence(page.paths, "/flows", 5, 7);
  expectCadence(page.paths, "/discoveries/workspace", 5, 7);
  expectCadence(page.paths, "/goal-drafts", 5, 7);
  expectCadence(page.paths, "/version", 1, 3);
  expectCadence(page.paths, "/providers", 0, 2);
  for (const path of [
    "/mcp-tools",
    "/resources",
    "/installed-skills",
    "/complexity",
    "/records",
    "/skills",
  ]) {
    expectSilent(page.paths, path);
  }
});

test("cadence of each Devboard tab reads only its own resource", async () => {
  const mcp = await openPage("devboard", DEVBOARD_MCP);
  await mcp.clock.advance(60_000);
  expectCadence(mcp.paths, "/mcp-tools", 1, 2);
  for (const path of ["/resources", "/installed-skills", "/complexity"]) {
    expectSilent(mcp.paths, path);
  }
  cleanup();
  connection.dispose();

  const resources = await openPage("devboard", DEVBOARD_RESOURCES);
  await resources.clock.advance(60_000);
  expectCadence(resources.paths, "/resources", 1, 3);
  expectSilent(resources.paths, "/mcp-tools");
  cleanup();
  connection.dispose();

  const skills = await openPage("devboard", DEVBOARD_SKILLS);
  await skills.clock.advance(60_000);
  expectCadence(skills.paths, "/installed-skills", 1, 3);
  cleanup();
  connection.dispose();

  const complexity = await openPage("devboard", DEVBOARD_COMPLEXITY);
  await complexity.clock.advance(60_000);
  expectCadence(complexity.paths, "/complexity", 1, 3);
});

test("cadence of a live agent page follows the run every second", async () => {
  agents.snapshots.scout = liveAgent("running");
  const page = await openPage("devboard", DEVBOARD_SCOUT);
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/agents", 59, 61);
  expectCadence(page.paths, "/goal", 5, 7);
  expectCadence(page.paths, "/providers", 0, 2);
});

test("cadence of a live run tab follows the run every second", async () => {
  issues.snapshot = {
    agents: [{ runId: "run-live" }],
    runs: [],
  } as unknown as IssuesSnapshot;
  const page = await openPage("issues", {
    id: "agent:run-live",
    kind: "agent",
    resourceId: "run-live",
    title: "#1 live run",
  });
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/issues/runs/run-live", 59, 61);
  expectCadence(page.paths, "/issues", 29, 31);
  expectCadence(page.paths, "/goal", 5, 7);
  for (const path of ["/records", "/skills", "/mcp-tools"]) expectSilent(page.paths, path);
});

test("cadence of a live Flow body follows its run every second", async () => {
  flow.status = "running";
  const page = await openPage("flow");
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/flows", 59, 61);
  expectCadence(page.paths, "/goal", 5, 7);
});

test("cadence of a live Discover body follows its run every second", async () => {
  discover.active = true;
  const page = await openPage("discover");
  await page.clock.advance(60_000);
  expectCadence(page.paths, "/discoveries/workspace", 59, 61);
  expectCadence(page.paths, "/goal", 5, 7);
});

test("cadence returns to the page cadence once the run settles", async () => {
  agents.snapshots.scout = liveAgent("running");
  const page = await openPage("devboard", DEVBOARD_SCOUT);
  await page.clock.advance(10_000);
  agents.snapshots.scout = liveAgent("stopped");
  await settle();

  const settled = reads(page.paths, "/agents");
  await page.clock.advance(1_000);
  expect(reads(page.paths, "/agents")).toBe(settled);
  await page.clock.advance(4_000);
  expect(reads(page.paths, "/agents")).toBe(settled + 1);
});

test("cadence reads a newly opened tab at once and stops it when it closes", async () => {
  const page = await openPage("goal", GOAL_IMPLEMENTATION);
  await page.clock.advance(5_000);
  expectSilent(page.paths, "/mcp-tools");

  layout.setMode("devboard");
  layout.openTab("devboard", DEVBOARD_MCP);
  await settle();
  // The open's own read lands before any cadence tick.
  expect(reads(page.paths, "/mcp-tools")).toBe(1);
  await page.clock.advance(100);
  expect(reads(page.paths, "/mcp-tools")).toBe(1);

  layout.setMode("goal");
  layout.openTab("goal", GOAL_IMPLEMENTATION);
  await settle();
  await page.clock.advance(60_000);
  expect(reads(page.paths, "/mcp-tools")).toBe(1);
});

test("cadence stops reading a resource whose surface closed", async () => {
  const page = await openPage("devboard", DEVBOARD_MCP);
  await page.clock.advance(2_000);
  expect(reads(page.paths, "/mcp-tools")).toBe(1);

  layout.setMode("goal");
  layout.openTab("goal", GOAL_IMPLEMENTATION);
  await settle();
  expect(
    plannedQueries().some((query) => query.command.type === "getMcpTools"),
  ).toBe(false);

  await page.clock.advance(120_000);
  expect(reads(page.paths, "/mcp-tools")).toBe(1);
});

test("cadence issues nothing while the document is hidden", async () => {
  const page = await openPage("goal", GOAL_IMPLEMENTATION);
  await page.clock.advance(20_000);
  const recorded = page.paths.length;

  hideDocument(true);
  document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
  await settle();
  await page.clock.advance(60_000);
  expect(page.paths.length).toBe(recorded);

  hideDocument(false);
  // The document's own Event class: a native one is not an instance of the
  // document's event realm and `dispatchEvent` refuses it.
  document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
  await settle();
  const returned = page.paths.slice(recorded);
  for (const path of [
    "/version",
    "/goal",
    "/issues",
    "/flows",
    "/discoveries/workspace",
    "/goal-drafts",
    "/records",
    "/skills",
    "/agents",
    "/providers",
  ]) {
    expectCadence(returned, path, 1, 1);
  }
});

test("cadence of a live Discover body keeps the background reads on time", async () => {
  // One agent reporting itself running is the live body; its snapshot replaces
  // the store's state on every read, exactly as the real one does. A plan
  // recomputation may not postpone the resources the body does not own.
  const running = {
    agents: [{ id: "scout", label: "Scout", command: "discover", state: "running" }],
  } as unknown as DiscoverStatePayload;
  discover.state = running;
  const page = await openPage("discover");
  for (let step = 0; step < 10; step += 1) {
    await page.clock.advance(2_000);
    discover.state = { ...running } as unknown as DiscoverStatePayload;
    await settle();
  }
  expectCadence(page.paths, "/goal", 2, 3);
  expectCadence(page.paths, "/providers", 0, 2);
});

test("cadence of a fresh Issues connect reads only what is on screen", async () => {
  const page = await openPage("issues", ISSUES_OVERVIEW);
  expect([...page.paths].sort()).toEqual([
    "/agents",
    "/discoveries/workspace",
    "/flows",
    "/goal",
    "/goal-drafts",
    "/issues",
    "/project",
    "/providers",
    "/version",
  ]);
});

const ISSUES_RUNS: WorkspaceTab = { id: "runs", kind: "runs", resourceId: "runs", title: "Runs" };

const ISSUES_DRAFTS: WorkspaceTab = {
  id: "drafts",
  kind: "drafts",
  resourceId: "drafts",
  title: "Draft goals",
};

/** The ids the plan claims for one one-shot operation, in order. */
function claimedIds(type: string, field: string): string[] {
  return plannedQueries()
    .filter((query) => query.command.type === type)
    .map((query) => String(query.command[field]));
}

test("a prompt section a hidden mode holds claims nothing", async () => {
  const page = await openPage("devboard", DEVBOARD_SCOUT);
  render(AgentPromptSection, { props: { agentId: "scout" } });
  await settle();
  const promptPath = (id: string) => `/agents/${id}/prompt`;
  expect(claimedIds("getAgentPrompt", "id")).toEqual(["scout"]);
  expect(reads(page.paths, promptPath("scout"))).toBe(1);

  // Every mode workspace stays mounted, so the section is still open behind
  // the Goal mode; the plan claims nothing for a surface that is not on
  // screen, and the section keeps its own claim on the store.
  layout.setMode("goal");
  await settle();
  expect(agents.requestedPrompts).toContain("scout");
  expect(claimedIds("getAgentPrompt", "id")).toEqual([]);
  const hidden = reads(page.paths, promptPath("scout"));

  // A reconnect revalidates every mounted query, and a visibility return does
  // the same: neither reads a prompt no surface on screen shows.
  connection.connect();
  await settle();
  expect(reads(page.paths, promptPath("scout"))).toBe(hidden);

  hideDocument(true);
  document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
  await settle();
  hideDocument(false);
  document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
  await settle();
  expect(reads(page.paths, promptPath("scout"))).toBe(hidden);
});

test("a closed prompt section retires its claim and its document", async () => {
  const page = await openPage("devboard", DEVBOARD_SCOUT);
  const view = render(AgentPromptSection, { props: { agentId: "scout" } });
  await settle();
  expect(queryClient.getQueryData(["getAgentPrompt", "/agents/scout/prompt"])).toBeDefined();

  // Switching the section to another agent closes the first one: the store
  // forgets it and the cache drops the document it read.
  await view.rerender({ agentId: "release-train" });
  await settle();
  expect(agents.requestedPrompts).toEqual(["release-train"]);
  expect(queryClient.getQueryData(["getAgentPrompt", "/agents/scout/prompt"])).toBeUndefined();
  // The agent page on screen is the scout page, so neither section claims:
  // closing the first one issues no read of its own, and the second section's
  // new claim is not on screen either.
  expect(claimedIds("getAgentPrompt", "id")).toEqual([]);
  expect(reads(page.paths, "/agents/scout/prompt")).toBe(1);
  expect(reads(page.paths, "/agents/release-train/prompt")).toBe(0);

  const closed = reads(page.paths, "/agents/scout/prompt");
  connection.connect();
  await settle();
  expect(reads(page.paths, "/agents/scout/prompt")).toBe(closed);
});

test("an Issues run claims its history only while a surface shows it", async () => {
  const page = await openPage("issues", ISSUES_RUNS);
  issues.openRun("run-42");
  await settle();
  expect(claimedIds("getIssuesRun", "runId")).toEqual(["run-42"]);
  expect(reads(page.paths, "/issues/runs/run-42")).toBe(1);

  // Closing the run surface leaves the selection behind; no surface shows the
  // run, so the plan derives no claim from it and nothing re-reads it.
  layout.openTab("issues", ISSUES_OVERVIEW);
  await settle();
  expect(claimedIds("getIssuesRun", "runId")).toEqual([]);
  await page.clock.advance(60_000);
  expect(reads(page.paths, "/issues/runs/run-42")).toBe(1);
});

test("a stored draft claims its document only while the Draft goals tab is active", async () => {
  const path = ".devboard/goal-proposals/002-example.md";
  goalDrafts.draftPath = path;
  const page = await openPage("issues", ISSUES_DRAFTS);
  const draftReads = page.paths.filter((entry) => entry.startsWith("/goal-drafts/")).length;
  expect(claimedIds("getGoalDraft", "path")).toEqual([path]);
  expect(draftReads).toBe(1);

  // The selection is restored from storage on reload, so a draft stays
  // selected after its page closes: only the page on screen claims it.
  layout.openTab("issues", ISSUES_OVERVIEW);
  await settle();
  expect(claimedIds("getGoalDraft", "path")).toEqual([]);
  await page.clock.advance(60_000);
  expect(page.paths.filter((entry) => entry.startsWith("/goal-drafts/")).length).toBe(1);
});

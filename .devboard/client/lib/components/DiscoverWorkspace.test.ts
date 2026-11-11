import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DiscoverAgentState, DiscoverStatePayload, Glossary } from "../types";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, render, waitFor } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DiscoverWorkspace } = await import("./DiscoverWorkspace.svelte");
const { layout } = await import("../layout.svelte");
const { discover } = await import("../discover.svelte");
const { DISCOVER_AGENTS } = await import("../../../lib/agent-registry.ts");

function agentStates(states: Record<string, string> = {}): DiscoverAgentState[] {
  return DISCOVER_AGENTS.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    command: descriptor.command,
    state: (states[descriptor.id] ?? "idle") as DiscoverAgentState["state"],
    startedAt: states[descriptor.id] === "running" ? "2026-11-02T15:20:23.238Z" : null,
    endedAt: null,
    error: null,
    prompt: null,
  }));
}

function payload(
  options: {
    states?: Record<string, string>;
    activeAgent?: string | null;
    runningAll?: boolean;
    glossaries?: Glossary[];
  } = {},
): DiscoverStatePayload {
  const activeAgent = options.activeAgent ?? null;
  return {
    active: activeAgent !== null,
    runId: null,
    startedAt: activeAgent === null ? null : "2026-11-02T15:20:23.238Z",
    activeAgent,
    runningAll: options.runningAll ?? false,
    allFailed: null,
    agents: agentStates(options.states),
    interrupted: false,
    stale: false,
    warnings: [],
    busy: null,
    error: null,
    remoteAvailable: false,
    retained: [],
    repository: null,
    target: { kind: "host" },
    cloning: null,
    manifest: null,
    freshness: null,
    sheet: null,
    dependencyRepositories: {},
    overviewLinks: {},
    contribution: null,
    glossaries: options.glossaries ?? [],
    glossaryUsage: {},
    glossarySignificance: {},
    decisions: [],
    skills: [],
  };
}

function resetDiscover(): void {
  discover.state = null;
  discover.active = false;
  discover.activeAgent = null;
  discover.runningAll = false;
  discover.allFailed = null;
  discover.question = null;
  discover.agentQuestions = {};
  discover.activity = [];
  discover.error = null;
  discover.errorAgent = null;
  discover.resetGlossaryFilters();
}

beforeEach(() => {
  resetDiscover();
  layout.mode = "discover";
});

afterEach(() => {
  cleanup();
  resetDiscover();
});

async function show(
  tab: { id: string; kind: string; resourceId: string; title: string },
  state: DiscoverStatePayload,
): Promise<void> {
  discover.handleEvent({ type: "discoverState", state });
  render(DiscoverWorkspace, { props: { tab } });
  await tick();
}

function bar(): Element {
  const element = document.querySelector('[data-testid="agent-activity-bar"]');
  if (element === null) throw new Error("the page renders no activity bar");
  return element;
}

function controlTestId(): string {
  const control = bar().querySelector('[data-testid="agent-activity-control"]');
  if (control === null) return "none";
  for (const id of [
    "discover-start",
    "discover-stop",
    "discover-agent-start",
    "discover-agent-stop",
  ]) {
    if (control.querySelector(`[data-testid="${id}"]`) !== null) return id;
  }
  return "none";
}

function controlCommand(): string {
  const element = bar().querySelector('[data-testid="agent-activity-control"] [data-command]');
  return element?.getAttribute("data-command") ?? "none";
}

test("the Overview page owns the seven-agent Run all control", async () => {
  await show(
    { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Discover activity");
  expect(controlTestId()).toBe("discover-start");
  expect(controlCommand()).toBe("discover.start");
});

test("the running Overview run stops through the quiet destructive control", async () => {
  await show(
    { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" },
    payload(),
  );
  discover.runningAll = true;
  await tick();
  await waitFor(() => expect(controlTestId()).toBe("discover-stop"), { timeout: 5000 });
  const stop = bar().querySelector('[data-testid="discover-stop"]');
  expect(stop?.classList.contains("discover-run__stop")).toBe(true);
  expect(stop?.getAttribute("data-variant")).toBe("bare");
});

test("a single agent's live run never marks the Overview bar", async () => {
  await show(
    { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" },
    payload({
      states: { "discover-contribution": "running" },
      activeAgent: "discover-contribution",
    }),
  );
  discover.handleEvent({
    type: "discoverActivity",
    agent: "discover-contribution",
    text: "- contribution: recorded a staged contribution.",
  });
  discover.handleEvent({
    type: "discoverQuestion",
    agent: "discover-contribution",
    id: "q-1",
    message: "Which tier?",
    options: [{ id: "one", label: "One" }],
  });
  await tick();
  expect(bar().getAttribute("aria-label")).toBe("Discover activity");
  expect(
    bar().querySelector('[data-testid="agent-activity-dot"]')?.getAttribute("data-state"),
  ).toBe("idle");
  expect(bar().querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim()).toBe(
    "No activity yet.",
  );
  expect(bar().querySelector('[data-testid="agent-activity-question"]')).toBeNull();
  expect(controlTestId()).toBe("discover-start");
  expect(document.querySelector('[data-testid="discover-start"]')?.hasAttribute("disabled")).toBe(
    true,
  );
});

test("the Run all suite paints the Overview bar running with its start time", async () => {
  await show(
    { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" },
    payload({
      states: { "discover-contribution": "running" },
      activeAgent: "discover-contribution",
      runningAll: true,
    }),
  );
  const dot = bar().querySelector('[data-testid="agent-activity-dot"]');
  expect(dot?.getAttribute("data-state")).toBe("running");
  expect(dot?.getAttribute("aria-label")).toBe(
    "Discover is running since 2026-11-02T15:20:23.238Z",
  );
});

test("a Contribution skill page starts the Contribution agent only", async () => {
  await show(
    {
      id: "contribution-skill",
      kind: "skill",
      resourceId: "discover-contribution",
      title: "Contribution",
    },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Contribution Agent activity");
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.discover-contribution");
});

test("a skill page stops only its own running agent", async () => {
  await show(
    {
      id: "contribution-skill",
      kind: "skill",
      resourceId: "discover-contribution",
      title: "Contribution",
    },
    payload({
      states: { "discover-contribution": "running" },
      activeAgent: "discover-contribution",
    }),
  );
  expect(controlTestId()).toBe("discover-agent-stop");
  expect(controlCommand()).toBe("discover.agent.stop.discover-contribution");
});

test("the Contribution page starts the Contribution Agent only", async () => {
  await show(
    {
      id: "contribution",
      kind: "contribution",
      resourceId: "contribution",
      title: "Contribution",
    },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Contribution Agent activity");
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.discover-contribution");
});

test("the Contribution page stops only its own running agent", async () => {
  await show(
    {
      id: "contribution",
      kind: "contribution",
      resourceId: "contribution",
      title: "Contribution",
    },
    payload({
      states: { "discover-contribution": "running" },
      activeAgent: "discover-contribution",
    }),
  );
  expect(controlTestId()).toBe("discover-agent-stop");
  expect(controlCommand()).toBe("discover.agent.stop.discover-contribution");
});

test("another agent's live run never marks the Contribution page", async () => {
  await show(
    {
      id: "contribution",
      kind: "contribution",
      resourceId: "contribution",
      title: "Contribution",
    },
    payload({ states: { sheet: "running" }, activeAgent: "sheet" }),
  );
  discover.handleEvent({
    type: "discoverActivity",
    agent: "sheet",
    text: "- branching: defaultBranch main observed.",
  });
  await tick();
  const dot = bar().querySelector('[data-testid="agent-activity-dot"]');
  expect(dot?.getAttribute("data-state")).toBe("idle");
  expect(bar().querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim()).toBe(
    "No activity yet.",
  );
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.discover-contribution");
});

test("the Glossary page starts the Glossary Agent only", async () => {
  await show(
    { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Glossary Agent activity");
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.discover-glossary");
});

test("the warnings page carries no run control", async () => {
  await show(
    { id: "warnings", kind: "warnings", resourceId: "warnings", title: "Warnings" },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Discover activity");
  expect(controlTestId()).toBe("none");
});

test("another agent's live run never marks the Contribution skill page", async () => {
  await show(
    {
      id: "contribution-skill",
      kind: "skill",
      resourceId: "discover-contribution",
      title: "Contribution",
    },
    payload({ states: { sheet: "running" }, activeAgent: "sheet" }),
  );
  discover.handleEvent({
    type: "discoverActivity",
    agent: "sheet",
    text: "- branching: defaultBranch main observed.",
  });
  await tick();
  const dot = bar().querySelector('[data-testid="agent-activity-dot"]');
  expect(dot?.getAttribute("data-state")).toBe("idle");
  expect(bar().querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim()).toBe(
    "No activity yet.",
  );
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.discover-contribution");
});

test("an agent card keeps its own start control", async () => {
  await show(
    { id: "sheet", kind: "agent", resourceId: "sheet", title: "Data Sheet" },
    payload(),
  );
  expect(bar().getAttribute("aria-label")).toBe("Data Sheet activity");
  expect(controlTestId()).toBe("discover-agent-start");
  expect(controlCommand()).toBe("discover.agent.start.sheet");
});

const PUBLISHED_GLOSSARY: Glossary = {
  boundedContext: "billing",
  titles: [{ language: "en", text: "Billing" }],
  concepts: [
    {
      id: "invoice",
      prefLabels: [{ language: "en", text: "Invoice" }],
      definitions: [{ language: "en", text: "A demand for payment." }],
      status: "active",
      origin: "observed",
      kind: "term",
    },
  ],
};

test("the Glossary page reports no published glossary before the agent has run", async () => {
  await show(
    { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" },
    payload({ glossaries: [] }),
  );
  const unpublished = document.querySelector('[data-testid="discover-glossary-unpublished"]');
  expect(unpublished?.textContent?.trim()).toBe(
    "No glossary is published. Start the Glossary Agent to collect one.",
  );
  expect(document.querySelector('[data-testid="discover-glossary-empty"]')).toBeNull();
  expect(unpublished?.querySelector("button")).toBeNull();
});

test("a published glossary keeps the no-match state and its Clear filters control", async () => {
  await show(
    { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" },
    payload({ glossaries: [PUBLISHED_GLOSSARY] }),
  );
  discover.setGlossarySearch("absent term");
  await tick();
  expect(document.querySelector('[data-testid="discover-glossary-unpublished"]')).toBeNull();
  const filteredEmpty = document.querySelector('[data-testid="discover-glossary-empty"]');
  expect(filteredEmpty?.textContent).toContain(
    "No term matches the current search and significance filter. The glossary is published;",
  );
  expect(filteredEmpty?.querySelector("button")?.textContent?.trim()).toBe("Clear filters");
});

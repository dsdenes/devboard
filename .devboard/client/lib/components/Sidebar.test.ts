import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DiscoverStatePayload } from "../types";
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
const { cleanup, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: Sidebar } = await import("./Sidebar.svelte");
const { layout } = await import("../layout.svelte");
const { discover } = await import("../discover.svelte");
const { goal } = await import("../goal.svelte");
const { issues } = await import("../issues.svelte");
const { flow } = await import("../flow.svelte");
const { agents } = await import("../agents.svelte");
const { SKILL_TABS } = await import("../discover-format");
const { DISCOVER_AGENTS } = await import("../../../server/agents/registry");

const AGENT_IDS = DISCOVER_AGENTS.map((agent) => agent.id);
const SKILL_TABS_BY_AGENT: Record<string, string[]> = {
  sheet: [],
  "discover-contribution": ["contribution", "contribution-skill"],
  "discover-testing-strategy": ["testing-strategy"],
  "discover-naming-conventions": ["naming-conventions"],
  "discover-coding-conventions": ["coding-conventions"],
  "discover-architecture-boundaries": ["architecture-boundaries"],
  "discover-glossary": ["glossary", "glossary-skill"],
};
const DISCOVER_TAB_IDS = [
  "overview",
  "glossary",
  "contribution",
  "testing-strategy",
  "naming-conventions",
  "coding-conventions",
  "architecture-boundaries",
  "glossary-skill",
  "contribution-skill",
];

function discoverPayload(options: {
  states?: Record<string, string>;
  activeAgent?: string | null;
  runningAll?: boolean;
  allFailed?: string | null;
} = {}): DiscoverStatePayload {
  const states = options.states ?? {};
  return {
    active: options.activeAgent !== undefined && options.activeAgent !== null,
    runId: null,
    startedAt: null,
    activeAgent: options.activeAgent ?? null,
    runningAll: options.runningAll ?? false,
    allFailed: options.allFailed ?? null,
    agents: AGENT_IDS.map((id) => ({
      id,
      label: id,
      command: `/${id}`,
      state: (states[id] ?? "idle") as "idle" | "running" | "succeeded" | "failed",
      startedAt: null,
      endedAt: null,
      error: null,
      prompt: null,
    })),
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
    manifest: {},
    freshness: null,
    sheet: { name: "fixture" },
    dependencyRepositories: {},
    overviewLinks: {},
    contribution: null,
    glossaries: [],
    glossaryUsage: {},
    glossarySignificance: {},
    decisions: [],
    skills: SKILL_TABS.filter((tab) => tab.skill !== null).map((tab) => ({
      name: tab.skill ?? "",
      state: tab.skill === "discover-contribution" ? ("missing" as const) : ("generated" as const),
      baseline: "",
      live: "",
    })),
  };
}

function resetDiscover(): void {
  discover.state = null;
  discover.active = false;
  discover.activeAgent = null;
  discover.runningAll = false;
  discover.suiteFailed = null;
  discover.question = null;
  discover.agentQuestions = {};
  discover.activity = [];
}

function resetStores(): void {
  resetDiscover();
  goal.runState = "idle";
  goal.runFile = null;
  goal.runTitle = null;
  goal.manualRunActive = false;
  goal.question = null;
  goal.skillsPrepActive = false;
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
  goal.skills = [];
  goal.lanes = [];
  issues.snapshot = null;
  issues.agentActivity = {};
  issues.draftRuns = {};
  issues.drafts = [];
  flow.status = "none";
  flow.question = null;
  agents.snapshots = {};
  layout.mode = "goal";
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

function mount(): void {
  render(Sidebar, { props: { openTab: () => {} } });
}

async function showDiscover(payload: DiscoverStatePayload): Promise<void> {
  discover.handleEvent({ type: "discoverState", state: payload });
  layout.mode = "discover";
  mount();
  await tick();
}

function discoverRunStates(): {
  tabs: Record<string, string | null>;
  agents: Record<string, string | null>;
} {
  const tabs: Record<string, string | null> = {};
  for (const element of document.querySelectorAll('[data-testid="discover-tab"]')) {
    const id = element.getAttribute("data-tab") ?? "";
    if (DISCOVER_TAB_IDS.includes(id)) tabs[id] = element.getAttribute("data-run-state");
  }
  const agentStates: Record<string, string | null> = {};
  for (const element of document.querySelectorAll('[data-testid="discover-agent-tab"]')) {
    agentStates[element.getAttribute("data-agent") ?? ""] = element.getAttribute("data-run-state");
  }
  return { tabs, agents: agentStates };
}

function expectedRunningFor(agent: string): { tabs: string[]; agents: string[] } {
  return { tabs: SKILL_TABS_BY_AGENT[agent] ?? [], agents: [agent] };
}

function expectOnlyRunning(
  states: { tabs: Record<string, string | null>; agents: Record<string, string | null> },
  runningAgents: string[],
  runningTabs: string[],
): void {
  for (const id of AGENT_IDS) {
    expect(states.agents[id]).toBe(runningAgents.includes(id) ? "running" : "idle");
  }
  for (const id of DISCOVER_TAB_IDS) {
    expect(states.tabs[id]).toBe(runningTabs.includes(id) ? "running" : "idle");
  }
}

function badgeText(element: Element | null): string {
  if (element === null) return "";
  const run = element.querySelector(
    '[data-testid="run-state-badge"], [data-testid="discover-running"]',
  );
  if (run !== null) return run.textContent?.trim() ?? "";
  return element.querySelector(".badge")?.textContent?.trim() ?? "";
}

test("each single Discover agent marks only its own entries", async () => {
  for (const agent of AGENT_IDS) {
    cleanup();
    resetStores();
    const { tabs, agents: agentStates } = expectedRunningFor(agent);
    await showDiscover(
      discoverPayload({
        states: { [agent]: "running" },
        activeAgent: agent,
      }),
    );
    expectOnlyRunning(discoverRunStates(), agentStates, tabs);
  }
});

test("a contribution-only run marks the entry, page, and skill and nothing else", async () => {
  await showDiscover(
    discoverPayload({ states: { "discover-contribution": "running" }, activeAgent: "discover-contribution" }),
  );
  const states = discoverRunStates();
  expectOnlyRunning(states, ["discover-contribution"], ["contribution", "contribution-skill"]);
  expect(states.tabs.overview).toBe("idle");
  expect(states.tabs.glossary).toBe("idle");
  expect(states.tabs["glossary-skill"]).toBe("idle");
  expect(badgeText(document.querySelector('[data-tab="overview"]'))).toBe("");
  expect(badgeText(document.querySelector('[data-tab="overview"] .badge'))).toBe("");
});

test("a sheet-only run marks only the Data Sheet entry", async () => {
  await showDiscover(discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet" }));
  expectOnlyRunning(discoverRunStates(), ["sheet"], []);
  expect(discoverRunStates().tabs.overview).toBe("idle");
});

test("the Run all suite marks the Overview and its current step while it runs", async () => {
  await showDiscover(
    discoverPayload({
      states: { "discover-naming-conventions": "running", sheet: "succeeded" },
      activeAgent: "discover-naming-conventions",
      runningAll: true,
    }),
  );
  const states = discoverRunStates();
  expect(states.tabs.overview).toBe("running");
  expect(states.agents["discover-naming-conventions"]).toBe("running");
  expect(states.tabs["naming-conventions"]).toBe("running");
  expect(states.agents.sheet).toBe("idle");
  expect(states.agents["discover-testing-strategy"]).toBe("idle");
  expect(states.tabs.glossary).toBe("idle");
  expect(
    document.querySelector('[data-tab="overview"] [data-testid="discover-running"]')?.textContent?.trim(),
  ).toBe("running");
});

test("a succeeded Run all leaves every Discover entry idle", async () => {
  await showDiscover(
    discoverPayload({
      states: Object.fromEntries(AGENT_IDS.map((id) => [id, "succeeded"])),
      runningAll: false,
      allFailed: null,
    }),
  );
  expectOnlyRunning(discoverRunStates(), [], []);
});

test("a failed Run all leaves its step and the Overview failed and later agents idle", async () => {
  await showDiscover(
    discoverPayload({
      states: {
        sheet: "succeeded",
        "discover-glossary": "succeeded",
        "discover-testing-strategy": "succeeded",
        "discover-naming-conventions": "failed",
      },
      allFailed: "discover-naming-conventions",
    }),
  );
  const states = discoverRunStates();
  expect(states.tabs.overview).toBe("failed");
  expect(states.agents["discover-naming-conventions"]).toBe("failed");
  expect(states.tabs["naming-conventions"]).toBe("failed");
  expect(states.agents["discover-coding-conventions"]).toBe("idle");
  expect(states.tabs["coding-conventions"]).toBe("idle");
  expect(states.agents.sheet).toBe("idle");
  const overviewBadge = document.querySelector('[data-tab="overview"] [data-testid="discover-running"]');
  expect(overviewBadge?.textContent?.trim()).toBe("failed");
  expect(overviewBadge?.getAttribute("data-tone")).toBe("error");
});

test("a suite question marks the Overview and the asking step answer", async () => {
  await showDiscover(
    discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet", runningAll: true }),
  );
  discover.handleEvent({
    type: "discoverQuestion",
    agent: "sheet",
    id: "q-1",
    message: "Which tier?",
    options: [{ id: "one", label: "One" }],
  });
  await tick();
  const states = discoverRunStates();
  expect(states.tabs.overview).toBe("answer");
  expect(states.agents.sheet).toBe("answer");
  expect(states.agents["discover-contribution"]).toBe("idle");
  expect(document.querySelector('[data-tab="overview"] [data-testid="discover-running"]')?.textContent?.trim()).toBe(
    "answer",
  );
});

test("a single agent's question never marks the Overview", async () => {
  await showDiscover(
    discoverPayload({
      states: { "discover-contribution": "running" },
      activeAgent: "discover-contribution",
    }),
  );
  discover.handleEvent({
    type: "discoverQuestion",
    agent: "discover-contribution",
    id: "q-2",
    message: "Which branch?",
    options: [{ id: "one", label: "One" }],
  });
  await tick();
  const states = discoverRunStates();
  expect(states.tabs.overview).toBe("idle");
  expect(states.agents["discover-contribution"]).toBe("answer");
  expect(states.tabs.contribution).toBe("answer");
  expect(states.tabs["contribution-skill"]).toBe("answer");
});

test("idle entries render no run badge and the skill's missing meta survives", async () => {
  await showDiscover(discoverPayload());
  for (const element of document.querySelectorAll("[data-run-state]")) {
    expect(element.getAttribute("data-run-state")).toBe("idle");
    expect(element.querySelector('[data-testid="run-state-badge"]')).toBeNull();
  }
  const contributionSkill = document.querySelector('[data-tab="contribution-skill"]');
  expect(contributionSkill?.getAttribute("data-state")).toBe("missing");
  expect(contributionSkill?.querySelector(".sidebar-item__meta")?.textContent?.trim()).toBe("missing");
});

test("the Goal entries read only the Goal store", async () => {
  goal.skills = [{ name: "fixture-conventions", description: "Fixture.", state: "generated" }];
  goal.skillsPrepActive = true;
  layout.mode = "goal";
  mount();
  await tick();
  const skills = document.querySelector('[data-testid="goal-skills-open"]');
  expect(skills?.getAttribute("data-run-state")).toBe("running");
  expect(badgeText(skills)).toBe("running");
  expect(document.querySelector('[data-testid="goal-skill"]')).toBeNull();

  goal.question = { id: "prep", message: "Which standard?", options: [] };
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "idle",
  );
  goal.question = null;
  goal.skillsPrepActive = false;
  goal.runState = "active";
  goal.runFile = "0003-dense-tables.md";
  goal.runTitle = "Dense tables";
  goal.manualRunActive = true;
  await tick();
  const implementation = document.querySelector('[data-testid="open-implementation"]');
  expect(implementation?.getAttribute("data-run-state")).toBe("running");
  expect(implementation?.querySelector(".sidebar-item__meta")?.textContent?.trim()).toBe("manual");
  expect(badgeText(implementation)).toBe("running");

  discover.handleEvent({
    type: "discoverState",
    state: discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet", runningAll: true }),
  });
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "running",
  );
  expect(document.querySelector('[data-testid="goal-skills-open"]')?.getAttribute("data-run-state")).toBe(
    "idle",
  );

  goal.question = { id: "q", message: "Which record?", options: [] };
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "answer",
  );
  expect(badgeText(document.querySelector('[data-testid="open-implementation"]'))).toBe("answer");

  goal.question = null;
  goal.runState = "idle";
  goal.manualRunActive = false;
  goal.lifecycle = { stage: "implementation", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = true;
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "running",
  );
  goal.lifecycle = { stage: "implementation", pass: 1, work: null, paused: true };
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "idle",
  );
  expect(badgeText(document.querySelector('[data-testid="open-implementation"]'))).toBe("");
});

test("the Issues entries read only the issues snapshot and draft runs", async () => {
  layout.mode = "issues";
  issues.snapshot = {
    present: true,
    repo: "fixture",
    root: "/fixture",
    lifecycle: "running",
    enabled: true,
    paused: false,
    attached: false,
    worker: null,
    poll: null,
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: null,
  };
  mount();
  await tick();
  const overview = () => document.querySelector('[data-testid="open-issues-overview"]');
  const drafts = () => document.querySelector('[data-testid="open-issues-drafts"]');
  expect(overview()?.getAttribute("data-run-state")).toBe("running");
  expect(drafts()?.getAttribute("data-run-state")).toBe("idle");

  issues.snapshot.agents = [
    { runId: "run-1", issueNumber: 7, startedAt: "2026-01-01T00:00:00.000Z", question: { id: "q", message: "Which?", options: [] }, acp: null },
  ];
  await tick();
  expect(overview()?.getAttribute("data-run-state")).toBe("answer");
  expect(badgeText(overview())).toBe("answer");

  issues.snapshot.agents = [];
  issues.snapshot.lifecycle = "failed";
  await tick();
  expect(overview()?.getAttribute("data-run-state")).toBe("failed");

  issues.draftRuns = {
    "/a.md": { status: "running", path: "/a.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, error: null, activity: [], question: null },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("running");
  expect(badgeText(drafts())).toBe("running");

  issues.draftRuns = {
    "/a.md": { status: "running", path: "/a.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, error: null, activity: [], question: { id: "q", message: "Which?", options: [] } },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("answer");

  issues.draftRuns = {
    "/old.md": { status: "failed", path: "/old.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", error: "boom", activity: [], question: null },
    "/new.md": { status: "succeeded", path: "/new.md", startedAt: "2026-01-01T00:02:00.000Z", finishedAt: "2026-01-01T00:03:00.000Z", error: null, activity: [], question: null },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("idle");

  issues.draftRuns = {
    "/old.md": { status: "failed", path: "/old.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", error: "boom", activity: [], question: null },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("failed");
  expect(badgeText(drafts())).toBe("failed");

  discover.handleEvent({
    type: "discoverState",
    state: discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet", runningAll: true }),
  });
  await tick();
  expect(overview()?.getAttribute("data-run-state")).toBe("failed");
  expect(drafts()?.getAttribute("data-run-state")).toBe("failed");
});

test("the Flow Overview and Status entries read only flow.status and its question", async () => {
  layout.mode = "flow";
  flow.status = "running";
  mount();
  await tick();
  const flowEntries = () => [...document.querySelectorAll('[data-command="open.flow.overview"][data-run-state]')];
  expect(flowEntries().map((entry) => entry.getAttribute("data-run-state"))).toEqual([
    "running",
    "running",
  ]);
  const labels = flowEntries().map(
    (entry) => entry.querySelector(".sidebar-item__label")?.textContent?.trim() ?? "",
  );
  expect(labels).toEqual(["Overview", "Status"]);
  expect(flowEntries().map((entry) => badgeText(entry))).toEqual(["running", "running"]);

  flow.question = { id: "q", message: "Which?", options: [] };
  await tick();
  expect(flowEntries().map((entry) => entry.getAttribute("data-run-state"))).toEqual([
    "answer",
    "answer",
  ]);
  expect(flowEntries().map((entry) => badgeText(entry))).toEqual(["answer", "answer"]);

  flow.question = null;
  flow.status = "stopped";
  await tick();
  expect(flowEntries().map((entry) => entry.getAttribute("data-run-state"))).toEqual(["idle", "idle"]);

  discover.handleEvent({
    type: "discoverState",
    state: discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet", runningAll: true }),
  });
  await tick();
  expect(flowEntries().map((entry) => entry.getAttribute("data-run-state"))).toEqual(["idle", "idle"]);
});

test("each background-agent entry follows its own lifecycle and no Discover run", async () => {
  layout.mode = "devboard";
  const descriptors = agents.descriptors;
  const lifecycles: Record<string, string> = {
    running: "running",
    starting: "running",
    failed: "failed",
    stopped: "idle",
    stopping: "idle",
  };
  const cycle = ["running", "starting", "failed", "stopped", "stopping"];
  agents.snapshots = Object.fromEntries(
    descriptors.map((descriptor, index) => [
      descriptor.id,
      {
        id: descriptor.id,
        label: descriptor.label,
        description: "",
        scope: "repository",
        lifecycle: cycle[index % cycle.length],
        enabled: true,
        owned: true,
        attached: false,
        cadence: { minutes: 30, lastRunAt: null, nextRunAt: null },
        limits: { maxPerHour: null, maxPending: null },
        issues: [],
        documentation: [],
        pending: 0,
        sync: { state: "ok", lastSyncAt: null, error: null },
        detail: { panel: "activity", entries: [], text: "" },
      } as unknown as (typeof agents.snapshots)[string],
    ]),
  );
  mount();
  await tick();
  for (const descriptor of descriptors) {
    const button = document.querySelector(`[data-testid="open-devboard-${descriptor.id}"]`);
    const lifecycle = String(agents.lifecycle(descriptor.id));
    expect(button?.getAttribute("data-run-state")).toBe(lifecycles[lifecycle]);
    expect(
      button?.querySelector(`[data-testid="agent-state-${descriptor.id}"]`)?.getAttribute("data-run-state"),
    ).toBe(lifecycles[lifecycle]);
  }

  discover.handleEvent({
    type: "discoverState",
    state: discoverPayload({ states: { sheet: "running" }, activeAgent: "sheet", runningAll: true }),
  });
  await tick();
  for (const descriptor of descriptors) {
    const button = document.querySelector(`[data-testid="open-devboard-${descriptor.id}"]`);
    expect(button?.getAttribute("data-run-state")).toBe(lifecycles[String(agents.lifecycle(descriptor.id))]);
  }
});

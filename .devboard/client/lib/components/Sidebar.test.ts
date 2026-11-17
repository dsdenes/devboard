import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DiscoverSkill, DiscoverStatePayload } from "../types";
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
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: Sidebar } = await import("./Sidebar.svelte");
const { layout } = await import("../layout.svelte");
const { discover } = await import("../discover.svelte");
const { goal } = await import("../goal.svelte");
const { goalDrafts } = await import("../goal-drafts.svelte");
const { issues } = await import("../issues.svelte");
const { flow } = await import("../flow.svelte");
const { agents } = await import("../agents.svelte");
const { delivery, DELIVERY_MODE_LABELS } = await import("../delivery.svelte");
const { saveFeedback } = await import("../save-feedback.svelte");
const { connection } = await import("../connection.svelte");
const { SKILL_TABS } = await import("../discover-format");
const { DISCOVER_AGENTS } = await import("../../../lib/agent-registry.ts");

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
  skills?: DiscoverSkill[];
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
    skills: options.skills ?? SKILL_TABS.filter((tab) => tab.skill !== null).map((tab) => ({
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
  discover.allFailed = null;
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
  goalDrafts.draftRuns = {};
  goalDrafts.drafts = [];
  flow.status = "none";
  flow.checkpoints = [];
  flow.question = null;
  agents.snapshots = {};
  delivery.reset();
  saveFeedback.dismiss();
  layout.activeTab = {
    goal: "overview",
    issues: "overview",
    flow: "overview",
    discover: "overview",
    devboard: "tools",
  };
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

/** A complete background-agent snapshot for the sidebar's own reads. */
function backgroundSnapshot(
  id: string,
  label: string,
  availability: { state: "enabled" | "disabled"; reason: string | null },
): (typeof agents.snapshots)[string] {
  return {
    id,
    label,
    description: "",
    scope: "repository",
    lifecycle: "stopped",
    paused: false,
    enabled: false,
    owned: false,
    attached: false,
    cadence: null,
    availability,
    limits: { maxPerHour: null, maxPending: null },
    issues: [],
    documentation: [],
    releases: [],
    pending: 0,
    sync: { state: "ok", at: null, error: null },
    detail: { panel: "activity", scanId: null, entries: [] },
    notice: null,
    error: null,
    timer: null,
    workers: [],
    peers: 0,
  } as unknown as (typeof agents.snapshots)[string];
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

test("an unpublished skill row reads Not generated yet on the muted tone", async () => {
  await showDiscover(
    discoverPayload({ skills: [{ name: "discover-glossary", state: "generated", baseline: "", live: "" }] }),
  );
  const contributionSkill = document.querySelector('[data-tab="contribution-skill"]');
  expect(contributionSkill?.getAttribute("data-state")).toBe("pending");
  const meta = contributionSkill?.querySelector(".sidebar-item__meta");
  expect(meta?.textContent?.trim()).toBe("Not generated yet");
  expect(meta?.hasAttribute("data-tone")).toBe(false);
  const glossarySkill = document.querySelector('[data-tab="glossary-skill"]');
  expect(glossarySkill?.getAttribute("data-state")).toBe("generated");
  expect(glossarySkill?.querySelector(".sidebar-item__meta")).toBeNull();
});

test("no Discover entry is a tab outside a tablist and the open page stays current", async () => {
  await showDiscover(discoverPayload());
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  expect(sidebar).not.toBeNull();
  const orphaned = [...sidebar!.querySelectorAll('[role="tab"]')].filter(
    (element) => element.closest('[role="tablist"]') === null,
  );
  expect(orphaned.map((element) => element.getAttribute("data-testid"))).toEqual([]);

  for (const label of ["Discover sections", "Discovery", "Skills"]) {
    const group = sidebar!.querySelector(`section[aria-label="${label}"]`);
    expect(group).not.toBeNull();
    expect(group!.querySelectorAll('[role="tab"], [aria-selected]').length).toBe(0);
    const entries = [...group!.querySelectorAll<HTMLButtonElement>(".sidebar-item")];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.tagName).toBe("BUTTON");
      expect(entry.hasAttribute("aria-current")).toBe(true);
    }
  }

  expect(document.querySelector('[data-tab="overview"]')?.getAttribute("aria-current")).toBe("true");
  layout.activeTab.discover = "glossary-skill";
  await tick();
  expect(document.querySelector('[data-tab="overview"]')?.getAttribute("aria-current")).not.toBe("true");
  expect(document.querySelector('[data-tab="glossary-skill"]')?.getAttribute("aria-current")).toBe(
    "true",
  );
});

test("the Goal lanes group keeps its lane tabs owned by one tablist", async () => {
  goal.lanes = [
    {
      id: "lane-a",
      kind: "implementation",
      epic: { number: 7, title: "Epic", url: "" },
      record: null,
      attempt: 1,
      status: "running",
      activity: [],
      question: null,
    },
  ];
  layout.mode = "goal";
  mount();
  await tick();
  const tablist = document.querySelector('[role="tablist"][aria-label="Agent lanes"]');
  expect(tablist).not.toBeNull();
  const tabs = [...tablist!.querySelectorAll('[role="tab"]')];
  expect(tabs.length).toBe(1);
  expect(tabs[0]?.closest('[role="tablist"]')).toBe(tablist);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
  layout.activeTab.goal = "lane:lane-a";
  await tick();
  expect(document.querySelector('[data-testid="lane-tab"]')?.getAttribute("aria-selected")).toBe(
    "true",
  );
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
    "answer",
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

  goal.lanes = [
    {
      id: "lane-a",
      kind: "implementation",
      epic: { number: 7, title: "Epic", url: "" },
      record: null,
      attempt: 1,
      status: "running",
      activity: [],
      question: { id: "lane-q", message: "Which epic?", options: [] },
    },
  ];
  await tick();
  expect(document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state")).toBe(
    "answer",
  );
  expect(badgeText(document.querySelector('[data-testid="open-implementation"]'))).toBe("answer");
  goal.lanes = [];
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

  goalDrafts.draftRuns = {
    "/a.md": { status: "running", path: "/a.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, error: null, activity: [], question: null },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("running");
  expect(badgeText(drafts())).toBe("running");

  goalDrafts.draftRuns = {
    "/a.md": { status: "running", path: "/a.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, error: null, activity: [], question: { id: "q", message: "Which?", options: [] } },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("answer");

  goalDrafts.draftRuns = {
    "/old.md": { status: "failed", path: "/old.md", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", error: "boom", activity: [], question: null },
    "/new.md": { status: "succeeded", path: "/new.md", startedAt: "2026-01-01T00:02:00.000Z", finishedAt: "2026-01-01T00:03:00.000Z", error: null, activity: [], question: null },
  };
  await tick();
  expect(drafts()?.getAttribute("data-run-state")).toBe("idle");

  goalDrafts.draftRuns = {
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

test("a project-gated background agent stays visible, disabled, and states its reason", async () => {
  layout.mode = "devboard";
  const reason =
    "Deploy on main runs only on host projects; this project is the harness source checkout.";
  agents.snapshots = {
    "deploy-on-main": backgroundSnapshot("deploy-on-main", "Deploy on main", {
      state: "disabled",
      reason,
    }),
  };
  const opened: Array<[string, string]> = [];
  render(Sidebar, {
    props: { openTab: (mode, tab) => opened.push([mode, tab.id]) },
  });
  await tick();

  const entry = document.querySelector('[data-testid="open-devboard-deploy-on-main"]');
  expect(entry).not.toBeNull();
  expect(entry?.getAttribute("aria-disabled")).toBe("true");
  expect(entry?.getAttribute("title")).toBe(reason);
  expect(
    entry?.querySelector('[data-testid="agent-gate-deploy-on-main"]')?.textContent?.trim(),
  ).toBe(reason);
  // The sidebar never carries a Start control; the entry still opens its page.
  expect(document.querySelector('[data-testid="agent-start"]')).toBeNull();
  await fireEvent.click(entry as Element);
  expect(opened).toEqual([["devboard", "deploy-on-main"]]);
});

test("an enabled background agent keeps its unmarked sidebar entry", async () => {
  layout.mode = "devboard";
  agents.snapshots = {
    scout: backgroundSnapshot("scout", "Auto Scout", { state: "enabled", reason: null }),
  };
  mount();
  await tick();

  const entry = document.querySelector('[data-testid="open-devboard-scout"]');
  expect(entry).not.toBeNull();
  expect(entry?.getAttribute("aria-disabled")).toBeNull();
  expect(entry?.hasAttribute("title")).toBe(false);
  expect(entry?.querySelector('[data-testid="agent-gate-scout"]')).toBeNull();
  expect(document.querySelector('[data-testid="agent-start"]')).toBeNull();
});

test("a checkpoint badge names its verification tone", async () => {
  const verifications = ["not-run", "passed", "failed"] as const;
  flow.checkpoints = verifications.map((verification, index) => ({
    id: `cp-${index}`,
    timestamp: "2026-11-01T00:00:00.000Z",
    summary: `Checkpoint ${index}`,
    files: 1,
    commit: `c${index}`.padEnd(12, "0"),
    verification,
  }));
  layout.mode = "flow";
  mount();
  await tick();
  const tones = verifications.map((_, index) =>
    document
      .querySelector(`[data-command="flow.checkpoint.open.cp-${index}"] .badge`)
      ?.getAttribute("data-tone"),
  );
  expect(tones).toEqual(["warning", "success", "error"]);
});

test("the Devboard group lists Resources directly after Complexity", async () => {
  layout.mode = "devboard";
  mount();
  await tick();
  const labels = [
    ...document.querySelectorAll('[data-testid="devboard-tab"] .sidebar-item__label'),
  ].map((entry) => entry.textContent?.trim());
  expect(labels.slice(0, 4)).toEqual(["MCP tools", "Skills", "Complexity", "Resources"]);
  for (const command of ["devboard.tab.complexity", "devboard.tab.resources"]) {
    const entry = document.querySelector(
      `[data-testid="devboard-tab"][data-command="${command}"]`,
    );
    expect(entry).not.toBeNull();
  }
});

test("the deploy sidebar count is the history rows, not the filed issues", async () => {
  layout.mode = "devboard";
  agents.snapshots = {
    "deploy-on-main": backgroundSnapshot("deploy-on-main", "Deploy on main", {
      state: "enabled",
      reason: null,
    }) as (typeof agents.snapshots)[string],
  };
  agents.snapshots["deploy-on-main"] = {
    ...agents.snapshots["deploy-on-main"],
    issues: [
      {
        title: "one filed issue",
        category: "deploy",
        createdAt: "2026-11-03T10:15:00.000Z",
        url: "https://example.test/issues/1",
        state: "pending",
        version: null,
      },
    ],
    deploys: [
      {
        id: "run-2",
        commit: "bbbbbbb",
        startedAt: "2026-11-04T10:00:00.000Z",
        endedAt: "2026-11-04T10:05:00.000Z",
        state: "failed",
        commits: 2,
      },
      {
        id: "run-1",
        commit: "aaaaaaa",
        startedAt: "2026-11-03T09:00:00.000Z",
        endedAt: "2026-11-03T09:05:00.000Z",
        state: "succeeded",
        commits: 0,
      },
    ],
  } as (typeof agents.snapshots)[string];
  mount();
  await tick();

  expect(
    document.querySelector('[data-testid="agent-count-deploy-on-main"]')?.textContent?.trim(),
  ).toBe("2");
});

/** A project payload with the delivery fields the server sends. */
function projectPayload(
  mode: "merge" | "pull-request",
  state: "enabled" | "disabled" = "enabled",
  reason: string | null = null,
): Record<string, unknown> {
  return {
    type: "project",
    path: "/fixture/repo",
    deliveryMode: mode,
    deliveryModeAvailability: { state, reason },
  };
}

function deliveryToggle(): HTMLButtonElement {
  const toggle = document.querySelector('[data-testid="delivery-mode-toggle"]');
  expect(toggle).not.toBeNull();
  return toggle as HTMLButtonElement;
}

function stubSend(): unknown[] {
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;
  return sent;
}

test("the delivery switch is one row immediately above Background agents", async () => {
  layout.mode = "devboard";
  delivery.handleEvent(projectPayload("merge"));
  mount();
  await tick();

  const groups = [...document.querySelectorAll(".sidebar-group")].map((group) =>
    group.getAttribute("aria-label"),
  );
  const deliveryIndex = groups.indexOf("Delivery mode");
  expect(deliveryIndex).toBeGreaterThanOrEqual(0);
  expect(groups[deliveryIndex + 1]).toBe("Background agents");

  const group = document.querySelector('[data-testid="sidebar-delivery-mode"]');
  expect(group?.getAttribute("aria-label")).toBe("Delivery mode");
  expect(group?.querySelectorAll('[data-testid="delivery-mode-toggle"]').length).toBe(1);
  expect(document.querySelector('[data-testid="delivery-mode-merge"]')).toBeNull();
  expect(document.querySelector('[data-testid="delivery-mode-pull-request"]')).toBeNull();

  const toggle = deliveryToggle();
  expect(toggle.tagName).toBe("BUTTON");
  expect(toggle.getAttribute("role")).toBe("switch");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.getAttribute("data-mode")).toBe("merge");
  expect(toggle.textContent?.trim()).toBe(DELIVERY_MODE_LABELS.merge);
  expect(toggle.getAttribute("title")).toBe(`Switch to ${DELIVERY_MODE_LABELS["pull-request"]}`);
  expect(toggle.querySelectorAll('[data-testid="delivery-mode-track"]').length).toBe(1);
  expect(toggle.querySelectorAll('[data-testid="delivery-mode-thumb"]').length).toBe(1);

  // An initial project frame is neither a pending save nor a confirmation.
  expect(document.querySelector('[data-testid="delivery-mode-saving"]')).toBeNull();
  expect(document.querySelector('[data-testid="save-feedback"]')).toBeNull();
});

test("a delivery activation flips optimistically and confirms the save", async () => {
  layout.mode = "devboard";
  delivery.handleEvent(projectPayload("merge"));
  mount();
  await tick();
  const toggle = deliveryToggle();

  const previous = connection.send;
  const sent = stubSend();
  try {
    await fireEvent.click(toggle);
    expect(sent).toEqual([{ type: "setDeliveryMode", mode: "pull-request" }]);
    // The confirmed mode waits for the server; the switch already shows it.
    expect(delivery.mode).toBe("merge");
    expect(toggle.getAttribute("data-mode")).toBe("pull-request");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent?.trim()).toBe(DELIVERY_MODE_LABELS["pull-request"]);
    expect(
      document.querySelector('[data-testid="delivery-mode-saving"]')?.textContent?.trim(),
    ).toBe("Saving…");

    await fireEvent.click(toggle);
    expect(sent.length).toBe(1);

    delivery.handleEvent(projectPayload("pull-request"));
    await tick();
    expect(document.querySelector('[data-testid="delivery-mode-saving"]')).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const feedback = document.querySelector('[data-testid="save-feedback"]');
    expect(feedback?.getAttribute("data-scope")).toBe("delivery.mode");
    expect(feedback?.getAttribute("role")).toBe("status");
    expect(feedback?.getAttribute("aria-live")).toBe("polite");
    expect(feedback?.textContent?.trim()).toBe("Delivery mode saved: Open pull request.");
    expect(feedback?.querySelector("svg")).not.toBeNull();
  } finally {
    connection.send = previous;
  }
});

test("a refused delivery save restores the previous mode and shows the error", async () => {
  layout.mode = "devboard";
  delivery.handleEvent(projectPayload("merge"));
  mount();
  await tick();
  const toggle = deliveryToggle();

  const previous = connection.send;
  const sent = stubSend();
  try {
    await fireEvent.click(toggle);
    expect(sent.length).toBe(1);
    delivery.handleEvent({
      type: "error",
      message: "Unknown delivery mode \"fast-forward\"; use `merge` or `pull-request`.",
    });
    await tick();
    expect(toggle.getAttribute("data-mode")).toBe("merge");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent?.trim()).toBe(DELIVERY_MODE_LABELS.merge);
    expect(
      document.querySelector('[data-testid="delivery-mode-error"]')?.textContent?.trim(),
    ).toContain("Unknown delivery mode");
    expect(document.querySelector('[data-testid="save-feedback"]')).toBeNull();
    expect(saveFeedback.text).toBeNull();

    // The refusal leaves the next activation free to dispatch again.
    await fireEvent.click(toggle);
    expect(sent).toEqual([
      { type: "setDeliveryMode", mode: "pull-request" },
      { type: "setDeliveryMode", mode: "pull-request" },
    ]);
    expect(document.querySelector('[data-testid="delivery-mode-error"]')).toBeNull();
  } finally {
    connection.send = previous;
  }
});

test("the delivery switch is disabled on the harness source checkout", async () => {
  layout.mode = "devboard";
  const reason =
    "Delivery mode applies to host projects; this project is the harness source checkout.";
  delivery.handleEvent(projectPayload("merge", "disabled", reason));
  mount();
  await tick();

  const group = document.querySelector('[data-testid="sidebar-delivery-mode"]');
  expect(group).not.toBeNull();
  const toggle = deliveryToggle();
  expect(toggle.hasAttribute("disabled")).toBe(true);
  expect(group?.querySelector('[data-testid="delivery-mode-reason"]')?.textContent?.trim()).toBe(
    reason,
  );
  expect(document.querySelector('[data-testid="delivery-mode-saving"]')).toBeNull();
  expect(document.querySelector('[data-testid="save-feedback"]')).toBeNull();

  // A disabled switch dispatches nothing.
  const previous = connection.send;
  const sent = stubSend();
  try {
    delivery.choose("pull-request");
    await fireEvent.click(toggle);
    expect(sent).toEqual([]);
  } finally {
    connection.send = previous;
  }
});

import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverStatePayload } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the components and
// the testing library load after registration.
const { cleanup, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: SourceOnlyBadge } = await import("./SourceOnlyBadge.svelte");
const { default: AgentPromptSection } = await import("./AgentPromptSection.svelte");
const { default: DiscoverAgentCard } = await import("./DiscoverAgentCard.svelte");
const { default: DiscoverOverview } = await import("./DiscoverOverview.svelte");
const { agents } = await import("../agents.svelte");
const { discover } = await import("../discover.svelte");
const { readdirSync, readFileSync } = await import("node:fs");
const { join, relative } = await import("node:path");

const WORD = "devboard";
const TOOLTIP = "Only available when Devboard serves a harness source checkout";

afterEach(() => {
  cleanup();
  discover.state = null;
  discover.promptStates = {};
  agents.prompts = {};
});

function markers(container: HTMLElement): HTMLElement[] {
  return within(container).queryAllByTestId("source-only-badge");
}

function prompt(text: string | null) {
  return { id: "scout", absent: false, text, error: null };
}

function discoverState(remoteAvailable: boolean): DiscoverStatePayload {
  return {
    active: false,
    runId: null,
    startedAt: null,
    activeAgent: null,
    runningAll: false,
    agents: [],
    interrupted: false,
    stale: false,
    warnings: [],
    busy: null,
    error: null,
    remoteAvailable,
    retained: remoteAvailable
      ? [
          {
            url: "https://github.com/octocat/Hello-World",
            owner: "octocat",
            repo: "Hello-World",
            completedAt: "2026-01-02T00:00:00.000Z",
          },
        ]
      : [],
    repository: null,
    target: { kind: "host" },
    cloning: null,
    manifest: null,
    freshness: null,
    sheet: null,
    dependencyRepositories: {},
    overviewLinks: {},
    contribution: null,
    glossaries: [],
    glossaryUsage: {},
    glossarySignificance: {},
    decisions: [],
    skills: [],
  };
}

/**
 * Every client source file that carries a marker string, whether or not it
 * renders one. The shared component and its tests are the only allowed homes.
 */
function markerSources(): string[] {
  const client = join(import.meta.dir, "..", "..");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(svelte|ts|js|css)$/.test(entry.name)) files.push(path);
    }
  };
  walk(client);
  return files;
}

test("the shared marker renders the one word, tooltip, class, and no tone", () => {
  const view = render(SourceOnlyBadge);
  const badge = within(view.container).getByTestId("source-only-badge");

  expect(badge.textContent).toBe(WORD);
  expect(badge.getAttribute("title")).toBe(TOOLTIP);
  expect(badge.className).toBe("badge");
  expect(badge.hasAttribute("data-tone")).toBe(false);
});

test("no background-agent prompt section carries the source-only marker", async () => {
  agents.prompts.scout = prompt("prompt bytes\n");
  const rendered = render(AgentPromptSection, { props: { agentId: "scout" } });
  await tick();
  expect(markers(rendered.container)).toHaveLength(0);
  expect(within(rendered.container).getByTestId("agent-prompt-text").textContent).toBe(
    "prompt bytes\n",
  );
});

test("a Discover card shows read-only bytes without the source-only marker", () => {
  discover.promptStates.sheet = {
    agent: "sheet",
    text: "prompt bytes\n",
    error: null,
  };
  const card = render(DiscoverAgentCard, { props: { agent: "sheet" } });
  expect(markers(card.container)).toHaveLength(0);
  expect(within(card.container).getByTestId("discover-agent-prompt-text").textContent).toBe(
    "prompt bytes\n",
  );
  expect(within(card.container).getByText("Read-only here")).toBeDefined();
});

test("the manual-testing panel marks its header and keeps the count trailing", () => {
  discover.state = discoverState(true);
  const source = render(DiscoverOverview);
  const panel = within(source.container).getByTestId("discover-remote");
  const header = panel.querySelector(".panel__header");
  const badges = markers(source.container);
  expect(header).not.toBeNull();
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent).toBe(WORD);
  expect(badges[0]?.getAttribute("title")).toBe(TOOLTIP);
  expect(header?.querySelector(".panel__title")?.nextElementSibling).toBe(badges[0]);
  expect(header?.lastElementChild?.textContent?.trim()).toBe("1 retained");

  discover.state = discoverState(false);
  const installed = render(DiscoverOverview);
  expect(within(installed.container).queryByTestId("discover-remote")).toBeNull();
  expect(markers(installed.container)).toHaveLength(0);
});

test("the marker has one definition and no retired source subtitle remains", () => {
  const offenders = markerSources().filter((path) => {
    const name = relative(join(import.meta.dir, "..", ".."), path);
    if (name === join("lib", "components", "SourceOnlyBadge.svelte")) return false;
    return !name.endsWith(".test.ts");
  });
  const withTestId = offenders.filter((path) =>
    readFileSync(path, "utf8").includes("source-only-badge"),
  );
  expect(withTestId).toEqual([]);

  const retired = ["Editable", "in", "this", "source", "checkout"].join(" ");
  const withRetiredSubtitle = markerSources().filter((path) =>
    readFileSync(path, "utf8").includes(retired),
  );
  expect(withRetiredSubtitle).toEqual([]);
});

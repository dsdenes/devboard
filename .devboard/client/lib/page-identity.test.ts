import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverStatePayload } from "./types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the components and
// the stores load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: IssuesWorkspace } = await import("./components/IssuesWorkspace.svelte");
const { default: IssuesAgentFocus } = await import("./components/IssuesAgentFocus.svelte");
const { default: DiscoverWorkspace } = await import("./components/DiscoverWorkspace.svelte");
const { default: PageHeader } = await import("./components/ui/page-header.svelte");
const { issues } = await import("./issues.svelte");
const { discover } = await import("./discover.svelte");
const { layout } = await import("./layout.svelte");
const { DISCOVER_AGENTS } = await import("../../lib/agent-registry.ts");

/** A tab naming one page, the shape each workspace routes on. */
function tab(
  kind: string,
  title: string,
): { id: string; kind: string; resourceId: string; title: string } {
  return { id: kind, kind, resourceId: kind, title };
}

/** A snapshot that fills the identity lines every Issues page renders. */
function issuesState(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    repo: "dsdenes/devboard",
    lifecycle: "running",
    enabled: true,
    paused: false,
    queue: [],
    runs: [],
    agents: [],
    workers: [],
  };
}

/** A discover state that renders the pane headers without a run in flight. */
function discoverState(): import("./types").DiscoverStatePayload {
  return {
    active: false,
    runId: null,
    startedAt: null,
    activeAgent: null,
    runningAll: false,
    allFailed: null,
    agents: DISCOVER_AGENTS.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      command: descriptor.command,
      state: "idle" as const,
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

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

/**
 * The one page identity a page may render. A hand-built header fails here: the
 * page has no `header.page-header`, or it carries a second `h1` beside the
 * shared one.
 */
function identity(container: HTMLElement): HTMLElement {
  const headers = container.querySelectorAll<HTMLElement>("header.page-header");
  const header = headers.item(0);
  if (headers.length !== 1 || header === null) {
    throw new Error(`the page renders ${headers.length} shared page headers`);
  }
  const titles = header.querySelectorAll<HTMLElement>("h1.page-header__title");
  const title = titles.item(0);
  if (titles.length !== 1 || title === null) {
    throw new Error(`the page header renders ${titles.length} page titles`);
  }
  if (container.querySelectorAll("h1").length !== 1) {
    throw new Error("the page renders a page title outside the shared header");
  }
  return title;
}

/** The classes the three hand-built identities used; none may survive. */
const HAND_BUILT = [
  ".issues-overview__header",
  ".issues-overview__title",
  ".issues-overview__repo",
  ".discover-page__header",
  ".discover-page__title",
  ".discover-page__subtitle",
].join(", ");

test("every Issues page renders the shared page identity", () => {
  issues.handleEvent(issuesState());
  const pages: Array<[
    string,
    { id: string; kind: string; resourceId: string; title: string },
  ]> = [
    ["Issue automation", tab("overview", "Overview")],
    ["Agents", tab("agents", "Agents")],
    ["Open issues", tab("queue", "Open issues")],
    ["Runs", tab("runs", "Runs")],
    ["Draft goals", tab("drafts", "Draft goals")],
  ];
  for (const [title, page] of pages) {
    const view = render(IssuesWorkspace, { props: { tab: page } });
    expect(identity(view.container).textContent?.trim()).toBe(title);
    expect(view.container.querySelector(HAND_BUILT)).toBeNull();
    cleanup();
  }
});

test("the agent focus page renders the shared page identity around an issue title", () => {
  issues.handleEvent(issuesState());
  const view = render(IssuesAgentFocus, {
    props: {
      tab: tab("agent", "#1973 Page identity is implemented three times"),
      close: () => undefined,
      openRuns: () => undefined,
    },
  });
  const title = identity(view.container);
  expect(title.textContent?.trim()).toBe("#1973 Page identity is implemented three times");
  expect(title.getAttribute("title")).toBe("#1973 Page identity is implemented three times");
  expect(view.container.querySelector(HAND_BUILT)).toBeNull();
});

test("a Discover page renders the same shared page identity", async () => {
  layout.mode = "discover";
  discover.handleEvent({ type: "discoverState", state: discoverState() });
  const view = render(DiscoverWorkspace, { props: { tab: tab("glossary", "Glossary") } });
  await tick();
  const title = identity(view.container);
  expect(title.textContent?.trim()).toBe("Glossary");
  // A fixed page label wraps: the wrap half of the one page-name rule.
  expect(getComputedStyle(title).whiteSpace).toBe("normal");
  // The filter toolbar is the action group, so it takes the row under the title.
  const actions = view.container.querySelector<HTMLElement>(".page-header__actions");
  expect(actions === null ? null : getComputedStyle(actions).flexBasis).toBe("100%");
  expect(view.container.querySelector(HAND_BUILT)).toBeNull();
});

test("the page-name rule truncates page data and wraps a fixed label", () => {
  const data = "devboard/some-very-long-project-name-that-would-overflow-the-header";
  const truncated = render(PageHeader, { props: { title: data } });
  const truncating = identity(truncated.container);
  expect(truncating.getAttribute("title")).toBe(data);
  expect(getComputedStyle(truncating).textOverflow).toBe("ellipsis");
  expect(getComputedStyle(truncating).whiteSpace).toBe("nowrap");
  cleanup();

  const label = "Architecture boundaries";
  const wrapped = render(PageHeader, { props: { title: label, titleWrap: true } });
  const wrapping = identity(wrapped.container);
  expect(wrapping.getAttribute("title")).toBe(label);
  expect(getComputedStyle(wrapping).whiteSpace).toBe("normal");
  expect(getComputedStyle(wrapping).overflowWrap).toBe("anywhere");
});

import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DraftsPage } = await import("./DraftsPage.svelte");
const { goalDrafts } = await import("../goal-drafts.svelte");

const UNREADABLE = "the goal-proposals read failed: .devboard/goal-proposals is not a directory";

const VIEWPORT = 160;

/**
 * happy-dom has no layout, so the activity pane gets the metrics a browser
 * computes for it: a growing scroll height, a fixed client height, and a
 * scrollTop clamped to the scrollable range.
 */
function layout(log: HTMLElement): { grow: (by: number) => void } {
  let content = VIEWPORT * 3;
  let top = 0;
  Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(log, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(log, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(value, 0), content - VIEWPORT);
    },
  });
  return {
    grow: (by: number) => {
      content += by;
    },
  };
}

function draftRun(startedAt: string, activity: string[]) {
  return {
    status: "running" as const,
    path: "alpha.md",
    startedAt,
    finishedAt: null,
    error: null,
    activity,
    question: null,
  };
}

/** The grid whose column count the page keys on a second panel. */
function body(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".issues-drafts__body");
  if (element === null) throw new Error("the drafts body rendered no .issues-drafts__body");
  return element;
}

function summary(path: string, name: string, heading: string) {
  return { path, name, heading };
}

afterEach(() => {
  cleanup();
  goalDrafts.drafts = [];
  goalDrafts.draftsReadError = null;
  goalDrafts.draftPath = null;
  goalDrafts.draft = null;
  goalDrafts.draftRuns = {};
});

test("an unreadable list with no drafts collapses the body to one column", () => {
  goalDrafts.draftsReadError = UNREADABLE;

  const view = render(DraftsPage);

  expect(body(view.container).getAttribute("data-empty")).toBe("true");
  expect(view.getByTestId("issues-drafts-error").textContent?.trim()).toBe(UNREADABLE);
  expect(view.queryByTestId("issues-draft-detail")).toBeNull();
});

test("a listed draft keeps the body's second column", () => {
  goalDrafts.drafts = [summary("alpha.md", "alpha.md", "Alpha")];

  const view = render(DraftsPage);

  expect(body(view.container).getAttribute("data-empty")).toBeNull();
  expect(view.getByTestId("issues-drafts-selection")).not.toBeNull();
});

test("a selected draft keeps its detail column while the list is unreadable", () => {
  goalDrafts.draftsReadError = UNREADABLE;
  goalDrafts.draftPath = "alpha.md";
  goalDrafts.draft = { ...summary("alpha.md", "alpha.md", "Alpha"), text: "## Goal\n\nShip it." };

  const view = render(DraftsPage);

  expect(body(view.container).getAttribute("data-empty")).toBeNull();
  expect(view.getByTestId("issues-draft-detail")).not.toBeNull();
  expect(view.getByTestId("issues-drafts-error")).not.toBeNull();
});

test("a restarted run of the selected draft starts at its newest line", async () => {
  goalDrafts.draftPath = "alpha.md";
  goalDrafts.draft = { ...summary("alpha.md", "alpha.md", "Alpha"), text: "## Goal\n\nShip it." };
  goalDrafts.draftRuns = {
    "alpha.md": draftRun("2026-11-17T10:00:00.000Z", ["first run line"]),
  };
  const view = render(DraftsPage);
  const log = view.getByTestId("issues-draft-activity");
  const pane = layout(log);
  await tick();

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();
  expect(log.scrollTop).toBe(40);

  pane.grow(VIEWPORT);
  goalDrafts.draftRuns = {
    "alpha.md": draftRun("2026-11-17T11:00:00.000Z", ["second run line", "second run tail"]),
  };
  await tick();

  expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight);
});

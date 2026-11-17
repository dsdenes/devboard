import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RunQuestion } from "../types";

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

function draftRun(startedAt: string, activity: string[], question: RunQuestion | null = null) {
  return {
    status: "running" as const,
    path: "alpha.md",
    startedAt,
    finishedAt: null,
    error: null,
    activity,
    question,
  };
}

/** A waiting elaboration question; two drafts may number their own identically. */
function question(id: number, message: string): RunQuestion {
  return { id, message, options: [] };
}

/** The draft answer field and the Answer control beside it. */
function answerField(container: HTMLElement): {
  input: HTMLInputElement;
  submit: HTMLButtonElement;
} {
  const input = container.querySelector<HTMLInputElement>(
    "[data-testid=issues-draft-answer-input]",
  );
  const submit = container.querySelector<HTMLButtonElement>(
    "[data-testid=issues-draft-answer-submit]",
  );
  if (input === null || submit === null)
    throw new Error("the draft question rendered no answer field");
  return { input, submit };
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

/** Submits the answer form the way the operator's Enter key does. */
async function submitAnswer(input: HTMLInputElement): Promise<void> {
  const form = input.closest("form");
  if (form === null) throw new Error("the answer field is not inside its form");
  const event = form.ownerDocument.createEvent("Event");
  event.initEvent("submit", true, true);
  form.dispatchEvent(event);
  await tick();
}

test("two drafts whose questions share an id never share one typed answer", async () => {
  const sent: string[] = [];
  const original = goalDrafts.submitDraftAnswer;
  goalDrafts.submitDraftAnswer = (value: string) => {
    sent.push(value);
    return true;
  };
  try {
    goalDrafts.drafts = [
      summary("alpha.md", "alpha.md", "Alpha"),
      summary("beta.md", "beta.md", "Beta"),
    ];
    goalDrafts.draftPath = "alpha.md";
    goalDrafts.draft = { ...summary("alpha.md", "alpha.md", "Alpha"), text: "" };
    // Two elaboration peers number their own ACP requests, so equal ids are ordinary.
    goalDrafts.draftRuns = {
      "alpha.md": draftRun("2026-11-17T10:00:00.000Z", [], question(3, "Which file changes?")),
      "beta.md": draftRun("2026-11-17T11:00:00.000Z", [], question(3, "Which file changes?")),
    };
    const view = render(DraftsPage);
    const alpha = answerField(view.container);

    await fireEvent.input(alpha.input, { target: { value: "the store" } });
    await tick();
    await submitAnswer(alpha.input);
    expect(sent).toEqual(["the store"]);
    expect(alpha.submit.getAttribute("aria-busy")).toBe("true");

    goalDrafts.draftPath = "beta.md";
    goalDrafts.draft = { ...summary("beta.md", "beta.md", "Beta"), text: "" };
    await tick();

    const beta = answerField(view.container);
    expect(beta.input.value).toBe("");
    expect(beta.submit.getAttribute("aria-busy")).toBeNull();
  } finally {
    goalDrafts.submitDraftAnswer = original;
  }
});

test("switching to a draft whose question has another id clears the answer", async () => {
  goalDrafts.draftPath = "alpha.md";
  goalDrafts.draft = { ...summary("alpha.md", "alpha.md", "Alpha"), text: "" };
  goalDrafts.draftRuns = {
    "alpha.md": draftRun("2026-11-17T10:00:00.000Z", [], question(3, "Which file changes?")),
    "beta.md": draftRun("2026-11-17T11:00:00.000Z", [], question(4, "Which suite proves it?")),
  };
  const view = render(DraftsPage);
  const alpha = answerField(view.container);

  await fireEvent.input(alpha.input, { target: { value: "the store" } });
  await tick();
  expect(alpha.input.value).toBe("the store");

  goalDrafts.draftPath = "beta.md";
  goalDrafts.draft = { ...summary("beta.md", "beta.md", "Beta"), text: "" };
  await tick();

  expect(answerField(view.container).input.value).toBe("");
});

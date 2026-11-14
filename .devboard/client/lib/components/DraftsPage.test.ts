import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: DraftsPage } = await import("./DraftsPage.svelte");
const { goalDrafts } = await import("../goal-drafts.svelte");

const UNREADABLE = "the goal-proposals read failed: .devboard/goal-proposals is not a directory";

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

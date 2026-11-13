import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

interface Props {
  tab: {
    id: string;
    kind: "goal-document";
    resourceId: string;
    title: string;
  };
  openTab: () => void;
  closeTab: () => void;
}

// The component and the testing library mount into the window happy-dom
// registers above, so they load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: GoalWorkspace } = await import("./GoalWorkspace.svelte");
const { goal } = await import("../goal.svelte");

/** The page that holds the goal document and its revision footer. */
const DOCUMENT: Props["tab"] = {
  id: "goal-document",
  kind: "goal-document",
  resourceId: "goal-document",
  title: "Goal document",
};

function documentView() {
  const props: Props = { tab: DOCUMENT, openTab: () => undefined, closeTab: () => undefined };
  return render(GoalWorkspace, { props });
}

afterEach(() => {
  cleanup();
  goal.revisionRequest = "";
});

test("the goal document footer binds revision guidance beside Revise goal", async () => {
  const view = documentView();

  const field = await view.findByTestId("revision-request");
  expect(view.getByTestId("revise-goal")).toBeDefined();
  expect(field.getAttribute("aria-label")).toBe("Revision guidance");

  await fireEvent.input(field, { target: { value: "  Keep the merge order  " } });

  expect(goal.revisionRequest).toBe("  Keep the merge order  ");
});

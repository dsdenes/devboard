import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: SaveFeedback } = await import("./SaveFeedback.svelte");
const { saveFeedback } = await import("../save-feedback.svelte");

afterEach(() => {
  saveFeedback.dismiss();
  cleanup();
});

test("only the confirmation mounted for the saved scope renders", async () => {
  const goal = render(SaveFeedback, { props: { scope: "flow.goal" } });
  const decisions = render(SaveFeedback, { props: { scope: "flow.decisions" } });

  saveFeedback.saved("flow.decisions", "Decision board saved.");
  await tick();

  expect(within(goal.container).queryByTestId("save-feedback")).toBeNull();
  const confirmation = within(decisions.container).getByTestId("save-feedback");
  expect(confirmation.getAttribute("data-scope")).toBe("flow.decisions");
  expect(confirmation.textContent).toContain("Decision board saved.");
});

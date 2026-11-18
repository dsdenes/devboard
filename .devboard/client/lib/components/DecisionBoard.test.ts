import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: DecisionBoard } = await import("./DecisionBoard.svelte");

afterEach(() => {
  cleanup();
});

test("a restoring session shows the restore notice instead of a settled board", () => {
  // The restore frame carries an empty board on purpose; a board text that
  // arrived before it must never win over the restoring frame.
  const view = render(DecisionBoard, {
    props: { decisions: "Sessions are stored on disk.", restoring: true },
  });

  expect(view.getByTestId("flow-decisions-state").textContent?.trim()).toBe("Restoring");
  expect(view.getByTestId("flow-decisions-state").getAttribute("data-state")).toBe("restoring");
  expect(view.getByTestId("flow-decisions-state").getAttribute("data-tone")).toBe("accent");
  expect(view.getByTestId("flow-decisions-restoring")).toBeTruthy();
  expect(view.queryByTestId("flow-decisions")).toBeNull();
  expect(view.getByTestId("flow-decisions-section").textContent).not.toContain("No decisions yet");
  expect(view.getByTestId("flow-decisions-section").textContent).not.toContain("Saved");
  expect(view.getByTestId("flow-decisions-section").textContent).not.toContain(
    "Sessions are stored on disk.",
  );
});

test("a settled empty board reads No decisions yet", () => {
  const view = render(DecisionBoard, { props: { decisions: "  \n ", restoring: false } });

  expect(view.getByTestId("flow-decisions-state").textContent?.trim()).toBe("No decisions yet");
  expect(view.getByTestId("flow-decisions-state").getAttribute("data-state")).toBe("empty");
  expect(view.getByTestId("flow-decisions-state").hasAttribute("data-tone")).toBe(false);
  expect(view.queryByTestId("flow-decisions-restoring")).toBeNull();
});

test("a settled non-empty board reads Saved", () => {
  const view = render(DecisionBoard, {
    props: { decisions: "Sessions are stored on disk.", restoring: false },
  });

  expect(view.getByTestId("flow-decisions-state").textContent?.trim()).toBe("Saved");
  expect(view.getByTestId("flow-decisions-state").getAttribute("data-state")).toBe("saved");
  expect(view.getByTestId("flow-decisions-state").getAttribute("data-tone")).toBe("success");
  expect(view.queryByTestId("flow-decisions-restoring")).toBeNull();
  expect(view.getByTestId("flow-decisions").textContent?.trim()).toBe(
    "Sessions are stored on disk.",
  );
});

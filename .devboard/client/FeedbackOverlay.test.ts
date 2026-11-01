import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FeedbackAction, FeedbackPhase } from "./lib/types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: FeedbackOverlayHarness } = await import(
  "../tests/fixtures/feedback-overlay-harness.svelte"
);
const { default: FeedbackOverlay } = await import("./FeedbackOverlay.svelte");

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

const pending: PendingRequest[] = [];
const originalFetch = globalThis.fetch;
const originalElementFromPoint = document.elementFromPoint;

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  pending.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    pending.push({ url: String(input), resolve, reject });
    return promise;
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  document.elementFromPoint = originalElementFromPoint;
  document.body.style.cursor = "";
});

/** Renders the overlay, arms reporting, and picks the target element. */
async function openPanel() {
  const snapshot: { phase: FeedbackPhase; action: FeedbackAction | null } = {
    phase: "idle",
    action: null,
  };
  const view = render(FeedbackOverlayHarness, { props: { snapshot } });
  const { startPicking } = view.component as unknown as { startPicking(): void };

  startPicking();
  await tick();
  expect(snapshot.phase).toBe("picking");
  expect(snapshot.action).toBe("report");
  expect(document.body.style.cursor).toBe("crosshair");

  const target = document.createElement("button");
  target.textContent = "Target";
  document.body.appendChild(target);
  document.elementFromPoint = () => target;
  fireEvent.click(target);
  await tick();
  expect(snapshot.phase).toBe("composing");

  const textarea = view.getByLabelText("Issue description");
  fireEvent.input(textarea, { target: { value: "The target is broken." } });
  await tick();
  return { view, snapshot };
}

/** A closed panel leaves no armed action, no cursor, and nothing announced. */
function expectClosed(snapshot: { phase: FeedbackPhase; action: FeedbackAction | null }) {
  expect(snapshot.phase).toBe("idle");
  expect(snapshot.action).toBeNull();
  expect(document.body.style.cursor).toBe("");
}

test("a goal answer that lands after Close leaves the overlay idle and unarmed", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByTestId("feedback-goal"));
  await tick();
  expect(pending.map((request) => request.url)).toEqual(["/api/goal-proposals"]);

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.resolve(reply({ path: "goals/draft.md" }));
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.queryByTestId("feedback-result")).toBeNull();
  expect(view.container.querySelector(".feedback-panel")).toBeNull();
  expect(view.container.querySelector(".feedback-hint")).toBeNull();
});

test("a report answer that lands after Close leaves the overlay idle and unarmed", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByRole("button", { name: "File issue" }));
  await tick();
  expect(pending.map((request) => request.url)).toEqual(["/api/feedback"]);
  expect(snapshot.phase).toBe("sending");

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.resolve(reply({ url: "http://localhost:3001/dsdenes/devboard/issues/1" }));
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.queryByTestId("feedback-result")).toBeNull();
  expect(view.container.querySelector(".feedback-panel")).toBeNull();
  expect(view.container.querySelector(".feedback-hint")).toBeNull();
});

test("a rejected goal post after Close leaves no error an absent panel cannot show", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByTestId("feedback-goal"));
  await tick();
  expect(pending).toHaveLength(1);

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.reject(new Error("network down"));
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.container.querySelector(".feedback-error")).toBeNull();
  expect(view.queryByTestId("feedback-result")).toBeNull();
});

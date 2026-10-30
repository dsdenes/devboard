import { afterEach, expect, test, vi } from "bun:test";
import { SaveFeedbackStore } from "./save-feedback.svelte";

afterEach(() => {
  vi.useRealTimers();
});

test("a confirmation replaces the previous one and clears itself", () => {
  vi.useFakeTimers();
  const store = new SaveFeedbackStore(10);

  store.saved("goal.document", "Goal saved.");
  expect(store.text).toBe("Goal saved.");
  expect(store.scope).toBe("goal.document");
  store.saved("agent.prompt.scout", "Prompt saved.");
  expect(store.text).toBe("Prompt saved.");
  expect(store.scope).toBe("agent.prompt.scout");

  store.dismiss();
  expect(store.text).toBeNull();
  expect(store.scope).toBeNull();

  store.saved("flow.decisions", "Decision board saved.");
  vi.advanceTimersByTime(10);
  expect(store.text).toBeNull();
  expect(store.scope).toBeNull();
});

test("an earlier confirmation's timer never clears a later one", () => {
  vi.useFakeTimers();
  const store = new SaveFeedbackStore(10);

  store.saved("flow.goal", "First save.");
  vi.advanceTimersByTime(5);
  store.saved("flow.decisions", "Second save.");
  // The first confirmation's dismissal is now due but must not clear the second.
  vi.advanceTimersByTime(5);
  expect(store.text).toBe("Second save.");
  expect(store.scope).toBe("flow.decisions");

  vi.advanceTimersByTime(5);
  expect(store.text).toBeNull();
});

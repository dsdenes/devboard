import { afterEach, expect, test, vi } from "bun:test";
import { SaveFeedbackStore } from "./save-feedback.svelte";

afterEach(() => {
  vi.useRealTimers();
});

test("a confirmation replaces the previous one and clears itself", () => {
  vi.useFakeTimers();
  const store = new SaveFeedbackStore(10);

  store.saved("Goal saved.");
  expect(store.text).toBe("Goal saved.");
  store.saved("Prompt saved.");
  expect(store.text).toBe("Prompt saved.");

  store.dismiss();
  expect(store.text).toBeNull();

  store.saved("Decision board saved.");
  vi.advanceTimersByTime(10);
  expect(store.text).toBeNull();
});

test("an earlier confirmation's timer never clears a later one", () => {
  vi.useFakeTimers();
  const store = new SaveFeedbackStore(10);

  store.saved("First save.");
  vi.advanceTimersByTime(5);
  store.saved("Second save.");
  // The first confirmation's dismissal is now due but must not clear the second.
  vi.advanceTimersByTime(5);
  expect(store.text).toBe("Second save.");

  vi.advanceTimersByTime(5);
  expect(store.text).toBeNull();
});

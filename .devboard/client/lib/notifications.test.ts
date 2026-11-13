import { afterEach, expect, test, vi } from "bun:test";
import { NotificationStore } from "./notifications.svelte";

afterEach(() => {
  vi.useRealTimers();
});

test("a card closes itself after five seconds but stays in the history", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("Auto Scout", "success", "Filed 2 issues.");
  expect(store.live).toHaveLength(1);
  expect(store.items).toHaveLength(1);
  expect(store.unread).toBe(1);

  vi.advanceTimersByTime(4999);
  expect(store.live).toHaveLength(1);

  vi.advanceTimersByTime(1);
  expect(store.live).toHaveLength(0);
  expect(store.items).toHaveLength(1);
  expect(store.items[0]?.source).toBe("Auto Scout");
  expect(store.unread).toBe(1);
});

test("the source is the exact agent label that raised the notification", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("MCP optimizer", "error", "Run failed.");
  store.push("Auto Scout", "success", "Filed 1 issue.");

  expect(store.live.map((item) => item.source)).toEqual(["Auto Scout", "MCP optimizer"]);
  expect(store.items.map((item) => item.source)).toEqual(["Auto Scout", "MCP optimizer"]);
});

test("dismissing removes a card from the live region and the history", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("Flow", "notice", "Flow restored.");
  const id = store.live[0]!.id;
  store.dismiss(id);

  expect(store.live).toHaveLength(0);
  expect(store.items).toHaveLength(0);

  vi.advanceTimersByTime(5000);
  expect(store.live).toHaveLength(0);
  expect(store.items).toHaveLength(0);
});

test("dismissing the last notification clears the unread count", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("Flow", "notice", "Flow restored.");
  store.dismiss(store.items[0]!.id);

  expect(store.items).toHaveLength(0);
  expect(store.live).toHaveLength(0);
  expect(store.unread).toBe(0);
});

test("the unread count never exceeds the remaining history", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  // The history keeps 200 entries; the 201st drops the oldest.
  for (let index = 0; index < 201; index += 1) {
    store.push("Issues", "notice", `Notification ${index}.`);
    expect(store.unread).toBeLessThanOrEqual(store.items.length);
  }
  expect(store.items).toHaveLength(200);
  expect(store.unread).toBe(200);
});

test("clearing cancels every pending auto-close", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("Flow", "notice", "First.");
  store.clear();

  vi.advanceTimersByTime(5000);
  expect(store.live).toHaveLength(0);
  expect(store.items).toHaveLength(0);
  expect(store.unread).toBe(0);
});

test("a dismissed card's timer never closes a later card", () => {
  vi.useFakeTimers();
  const store = new NotificationStore();

  store.push("Issues", "success", "Closed issue #1.");
  const first = store.live[0]!;
  vi.advanceTimersByTime(2500);
  store.dismiss(first.id);
  store.push("Issues", "success", "Closed issue #2.");

  vi.advanceTimersByTime(2500);
  expect(store.live.map((item) => item.text)).toEqual(["Closed issue #2."]);

  vi.advanceTimersByTime(2500);
  expect(store.live).toHaveLength(0);
  expect(store.items.map((item) => item.text)).toEqual(["Closed issue #2."]);
});

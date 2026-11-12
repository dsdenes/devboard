import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { connection } = await import("./connection.svelte");
const { applyFrames } = await import("./frames");
const { issues } = await import("./issues.svelte");
const { notifications } = await import("./notifications.svelte");

afterEach(() => {
  connection.dispose();
});

test("a run whose history is gone reads as unavailable without a server error notification", () => {
  const before = notifications.items.length;
  const frames: string[] = [];
  connection.onMessage((message) => {
    frames.push(String(message.type));
    issues.handleEvent(message as Record<string, unknown>);
  });

  applyFrames([
    { type: "issuesRunMissing", runId: "run-gone", message: "No such issues run." },
  ]);

  expect(frames).toEqual(["issuesRunMissing"]);
  expect(issues.runError).toBe("No such issues run.");
  expect(notifications.items.length).toBe(before);

  // The history read that follows clears the unavailable state; a pruned run
  // is an answer, not a page that stays broken.
  applyFrames([{ type: "issuesRun", run: { runId: "run-gone", activityLines: [] } }]);
  expect(issues.runError).toBeNull();
  expect(notifications.items.length).toBe(before);
});

test("a genuine server error still reaches the notification region", () => {
  const before = notifications.items.length;
  applyFrames([{ type: "error", message: "The tracker is unreachable." }]);

  const added = notifications.items.slice(0, notifications.items.length - before);
  expect(added.some((item) => item.source === "Server")).toBe(true);
});

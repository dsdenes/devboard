import { afterEach, beforeEach, expect, test } from "bun:test";
import { connection } from "./connection.svelte";
import {
  DELIVERY_FEEDBACK_SCOPE,
  DELIVERY_MODE_LABELS,
  DeliveryStore,
  otherDeliveryMode,
} from "./delivery.svelte";
import { saveFeedback } from "./save-feedback.svelte";

function projectFrame(
  mode: "merge" | "pull-request",
  state: "enabled" | "disabled" = "enabled",
  reason: string | null = null,
  requestId?: number,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    type: "project",
    path: "/fixture/repo",
    deliveryMode: mode,
    deliveryModeAvailability: { state, reason },
  };
  if (requestId !== undefined) frame.requestId = requestId;
  return frame;
}

function stubSend(): unknown[] {
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;
  return sent;
}

let originalSend: typeof connection.send;

beforeEach(() => {
  originalSend = connection.send;
  saveFeedback.dismiss();
});

afterEach(() => {
  connection.send = originalSend;
  saveFeedback.dismiss();
});

test("one map names both modes and the switch target", () => {
  expect(DELIVERY_MODE_LABELS.merge).toBe("Merge to main");
  expect(DELIVERY_MODE_LABELS["pull-request"]).toBe("Open pull request");
  expect(otherDeliveryMode("merge")).toBe("pull-request");
  expect(otherDeliveryMode("pull-request")).toBe("merge");
});

test("a pending save shows the target mode without changing the confirmed one", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("merge"));
  const sent = stubSend();

  store.choose("pull-request");

  expect(sent).toEqual([{ type: "setDeliveryMode", mode: "pull-request", requestId: 1 }]);
  expect(store.mode).toBe("merge");
  expect(store.pending).toEqual({ requestId: 1, mode: "pull-request" });
  expect(store.shown).toBe("pull-request");
  expect(store.saving).toBe(true);
  expect(store.other).toBe("merge");

  // One save at a time: a second activation dispatches nothing.
  store.choose("merge");
  expect(sent.length).toBe(1);
  expect(store.pending).toEqual({ requestId: 1, mode: "pull-request" });
  expect(store.shown).toBe("pull-request");
});

test("a confirming frame posts the scoped success note from the label map", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("merge"));
  stubSend();

  store.choose("pull-request");
  store.handleEvent(projectFrame("pull-request", "enabled", null, 1));

  expect(store.pending).toBeNull();
  expect(store.saving).toBe(false);
  expect(store.shown).toBe("pull-request");
  expect(store.mode).toBe("pull-request");
  expect(store.error).toBeNull();
  expect(saveFeedback.scope).toBe(DELIVERY_FEEDBACK_SCOPE);
  expect(DELIVERY_FEEDBACK_SCOPE).toBe("delivery.mode");
  expect(saveFeedback.text).toBe(
    `Delivery mode saved: ${DELIVERY_MODE_LABELS["pull-request"]}.`,
  );
});

test("an initial frame without a pending save shows no feedback", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("pull-request"));

  expect(store.resolved).toBe(true);
  expect(store.mode).toBe("pull-request");
  expect(store.shown).toBe("pull-request");
  expect(store.saving).toBe(false);
  expect(saveFeedback.text).toBeNull();
  expect(saveFeedback.scope).toBeNull();
});

test("the save's own answer for another mode settles it without a success note", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("merge"));
  stubSend();
  store.choose("pull-request");

  store.handleEvent(projectFrame("merge", "enabled", null, 1));

  expect(store.pending).toBeNull();
  expect(store.shown).toBe("merge");
  expect(saveFeedback.text).toBeNull();
});

test("a refusal restores the confirmed mode, shows the error, and allows a retry", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("merge"));
  const sent = stubSend();
  saveFeedback.saved(DELIVERY_FEEDBACK_SCOPE, "Delivery mode saved: Merge to main.");
  store.choose("pull-request");

  store.handleEvent({
    type: "error",
    message: "Unknown delivery mode \"fast-forward\".",
    requestId: 1,
  });

  expect(store.pending).toBeNull();
  expect(store.shown).toBe("merge");
  expect(store.mode).toBe("merge");
  expect(store.error).toBe("Unknown delivery mode \"fast-forward\".");
  expect(saveFeedback.text).toBeNull();

  store.choose("pull-request");
  expect(sent).toEqual([
    { type: "setDeliveryMode", mode: "pull-request", requestId: 1 },
    { type: "setDeliveryMode", mode: "pull-request", requestId: 2 },
  ]);
  expect(store.error).toBeNull();
});

test("an unrelated error frame leaves the save awaiting its own answer", () => {
  const store = new DeliveryStore();
  store.handleEvent(projectFrame("merge"));
  stubSend();
  store.choose("pull-request");
  const save = store.pending;
  if (save === null) throw new Error("the activation dispatched no pending save");
  const { requestId } = save;

  // The dispatcher refuses every non-read-only command while an implementation
  // reset is active, and that frame names no command; a broadcast refusal names
  // another id. Neither is this save's answer.
  store.handleEvent({ type: "error", message: "An implementation reset is active." });
  store.handleEvent({
    type: "error",
    message: "A provider credential was lost.",
    requestId: requestId + 1,
  });

  expect(store.error).toBeNull();
  expect(store.pending).toEqual({ requestId, mode: "pull-request" });
  expect(store.saving).toBe(true);
  expect(store.shown).toBe("pull-request");

  // A project frame naming no save — a re-read or another page's answer —
  // updates the confirmed mode without settling this one.
  store.handleEvent(projectFrame("pull-request"));
  expect(store.pending).toEqual({ requestId, mode: "pull-request" });
  expect(saveFeedback.text).toBeNull();

  // The frame that names the save confirms it, whatever arrived before.
  store.handleEvent(projectFrame("pull-request", "enabled", null, requestId));
  expect(store.pending).toBeNull();
  expect(store.saving).toBe(false);
  expect(store.error).toBeNull();
  expect(store.shown).toBe("pull-request");
  expect(store.mode).toBe("pull-request");
  expect(saveFeedback.text).toBe("Delivery mode saved: Open pull request.");
});

test("a disabled checkout names its reason and dispatches nothing", () => {
  const store = new DeliveryStore();
  const reason =
    "Delivery mode applies to host projects; this project is the harness source checkout.";
  store.handleEvent(projectFrame("merge", "disabled", reason));
  const sent = stubSend();

  store.choose("pull-request");

  expect(store.disabled).toBe(true);
  expect(store.reason).toBe(reason);
  expect(sent).toEqual([]);
  expect(store.pending).toBeNull();
  expect(store.saving).toBe(false);
  expect(saveFeedback.text).toBeNull();
});

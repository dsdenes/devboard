import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the store and the
// connection it dispatches through load after registration.
const { FlowStore } = await import("./flow.svelte");
const { connection } = await import("./connection.svelte");

const originalSend = connection.send;

afterEach(() => {
  connection.send = originalSend;
});

const NOTE = "Steer the implementation toward the integration checkout";

/** A store holding one typed note the operator believes was submitted. */
function drafting(): InstanceType<typeof FlowStore> {
  const flow = new FlowStore();
  flow.steeringDraft = NOTE;
  return flow;
}

function steeringNote(text: string): Record<string, unknown> {
  return {
    id: `note-${text.length}`,
    timestamp: "2026-11-13T00:00:00Z",
    source: "developer",
    text,
    status: "new",
  };
}

test("a dispatch the connection never delivered keeps the drafted note", () => {
  const flow = drafting();
  connection.send = (() => false) as typeof connection.send;

  flow.sendSteering();

  expect(flow.steeringDraft).toBe(NOTE);
  expect(flow.pendingSteering).toBeNull();
});

test("the server's flowError refusal keeps the drafted note", () => {
  const flow = drafting();
  connection.send = (() => true) as typeof connection.send;

  flow.sendSteering();
  flow.handleEvent({ type: "flowError", message: "No Flow session exists." });

  expect(flow.steeringDraft).toBe(NOTE);
});

test("a flowSteering frame clears the draft only when it carries the sent text", () => {
  const flow = drafting();
  connection.send = (() => true) as typeof connection.send;

  flow.sendSteering();
  flow.handleEvent({ type: "flowSteering", notes: [steeringNote("An earlier note")] });
  expect(flow.steeringDraft).toBe(NOTE);

  flow.handleEvent({ type: "flowSteering", notes: [steeringNote("An earlier note"), steeringNote(NOTE)] });
  expect(flow.steeringDraft).toBe("");
});

test("a restoring session dispatches nothing and keeps the typed note", () => {
  const flow = drafting();
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;
  flow.status = "restoring";

  flow.sendSteering();

  expect(sent).toEqual([]);
  expect(flow.steeringDraft).toBe(NOTE);
});

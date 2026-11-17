import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the store and the
// connection it dispatches through load after registration.
const { FlowStore } = await import("./flow.svelte");
const { connection } = await import("./connection.svelte");
const { COMMAND_CEILING_MS, createCommandBusy } = await import("./command-busy.svelte");

const originalSend = connection.send;

afterEach(() => {
  connection.send = originalSend;
  jest.useRealTimers();
});

const CONCLUSION = "The widget settles on the catalog query";
const WIDGET = "widget-1";

/** The latch `FlowMode` builds for one `Send conclusion to implementation`. */
function conclusionLatch(flow: InstanceType<typeof FlowStore>) {
  return createCommandBusy({
    label: "Send conclusion to implementation",
    evidence: () => flow.decisions,
    refusal: () => connection.refusalRevision("sendFlowConclusion"),
  });
}

/** A store holding one open conversation the operator concluded. */
function concluded(): InstanceType<typeof FlowStore> {
  const flow = new FlowStore();
  flow.handleEvent({ type: "flowConversationStarted", widgetId: WIDGET });
  flow.conclusionDraft = CONCLUSION;
  return flow;
}

/** The section `append_decisions` writes for one conclusion. */
function section(text: string): string {
  return `\n\n## 2026-11-17T22:00:00+01:00 \u2014 Widget conversation ${WIDGET}\n\n${text}\n`;
}

test("the appended board section settles the conclusion before the ceiling", () => {
  jest.useFakeTimers();
  const flow = concluded();
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;
  const latch = conclusionLatch(flow);
  latch.start();

  expect(flow.sendConclusion()).toBe(true);
  expect(latch.busy).toBe(true);

  jest.advanceTimersByTime(COMMAND_CEILING_MS / 2);
  flow.handleEvent({ type: "flowDecisions", text: flow.decisions + section(CONCLUSION) });
  latch.settle();

  expect(latch.busy).toBe(false);
  expect(flow.conclusionDraft).toBe("");
  expect(flow.pendingConclusion).toBeNull();
  expect(flow.sendConclusion()).toBe(false);
  expect(sent).toHaveLength(1);

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("a board section for another decision leaves the conclusion draft alone", () => {
  jest.useFakeTimers();
  const flow = concluded();
  connection.send = (() => true) as typeof connection.send;
  const latch = conclusionLatch(flow);
  latch.start();
  flow.sendConclusion();

  flow.handleEvent({ type: "flowDecisions", text: flow.decisions + section("Another owner") });
  latch.settle();

  expect(latch.busy).toBe(false);
  expect(flow.conclusionDraft).toBe(CONCLUSION);
  expect(flow.pendingConclusion).not.toBeNull();

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("a dispatch the connection never delivered keeps the draft and shows no busy word", () => {
  jest.useFakeTimers();
  const flow = concluded();
  connection.send = (() => false) as typeof connection.send;
  const latch = conclusionLatch(flow);
  latch.start();
  if (flow.sendConclusion() === false) latch.refuse();

  expect(latch.busy).toBe(false);
  expect(flow.conclusionDraft).toBe(CONCLUSION);
  expect(flow.pendingConclusion).toBeNull();

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("the server's refusal of sendFlowConclusion releases the latch without the ceiling notice", () => {
  jest.useFakeTimers();
  const flow = concluded();
  connection.send = (() => true) as typeof connection.send;
  const latch = conclusionLatch(flow);
  latch.start();
  flow.sendConclusion();

  connection.receiveFrame({
    type: "flowError",
    message: "No widget conversation is open.",
    command: "sendFlowConclusion",
  });
  latch.settle();

  expect(latch.busy).toBe(false);
  expect(flow.conclusionDraft).toBe(CONCLUSION);

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

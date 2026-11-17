import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the store and the
// latch it feeds load after registration.
const { FlowStore } = await import("./flow.svelte");
const { COMMAND_CEILING_MS, createCommandBusy } = await import("./command-busy.svelte");

type AnswerTarget = "goal" | "implementation" | "conversation";

afterEach(() => {
  jest.useRealTimers();
});

/** The latch `FlowMode` builds for one lane's `Submit answer`. */
function answerLatch(flow: InstanceType<typeof FlowStore>, target: AnswerTarget) {
  return createCommandBusy({
    label: "Submit answer",
    evidence: () => flow.answerActivity(target),
  });
}

function interview(): InstanceType<typeof FlowStore> {
  const flow = new FlowStore();
  flow.handleEvent({ type: "flowGoalStarted" });
  return flow;
}

test("an interview answer settles on the interview lane's activity, not the implementation's", () => {
  jest.useFakeTimers();
  const flow = interview();
  const latch = answerLatch(flow, "goal");
  latch.start();
  expect(latch.busy).toBe(true);

  flow.activity = ["an implementation line"];
  latch.settle();
  expect(latch.busy).toBe(true);

  jest.advanceTimersByTime(COMMAND_CEILING_MS / 2);
  flow.handleEvent({ type: "flowActivity", text: "Reading the goal" });
  latch.settle();
  expect(latch.busy).toBe(false);

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.busy).toBe(false);
  expect(latch.notice).toBeNull();
});

test("a conversation answer settles on the conversation lane's activity", () => {
  jest.useFakeTimers();
  const flow = new FlowStore();
  flow.handleEvent({ type: "flowConversationStarted", widgetId: "widget-1" });
  const latch = answerLatch(flow, "conversation");
  latch.start();

  flow.handleEvent({ type: "flowActivity", text: "an implementation line" });
  latch.settle();
  expect(latch.busy).toBe(true);

  flow.handleEvent({ type: "flowConversationActivity", text: "Thinking about the answer" });
  latch.settle();
  expect(latch.busy).toBe(false);

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("the implementation lane's answer still settles on flow activity", () => {
  jest.useFakeTimers();
  const flow = new FlowStore();
  const latch = answerLatch(flow, "implementation");
  latch.start();

  flow.handleEvent({ type: "flowActivity", text: "Editing the widget" });
  latch.settle();

  expect(latch.busy).toBe(false);
  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

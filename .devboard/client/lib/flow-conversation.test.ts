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

const MESSAGE = "The catalog query owns the filter state";
const WIDGET = "widget-1";

/** The latch `FlowMode` builds for one conversation `Send`. */
function conversationLatch(flow: InstanceType<typeof FlowStore>) {
  return createCommandBusy({
    label: "Send",
    evidence: () => flow.conversation?.messages.length,
    refusal: () => connection.refusalRevision("sendFlowConversation"),
  });
}

/** A store holding one open conversation the operator typed into. */
function conversing(): InstanceType<typeof FlowStore> {
  const flow = new FlowStore();
  flow.handleEvent({ type: "flowConversationStarted", widgetId: WIDGET });
  flow.conversationDraft = MESSAGE;
  return flow;
}

/** One `flowSnapshot` frame whose conversation holds the given messages. */
function snapshot(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    type: "flowSnapshot",
    status: "running",
    sessionId: "issue-2099",
    goal: "The stored session",
    decisions: "",
    worktree: null,
    branch: null,
    baseRevision: null,
    files: [],
    widgets: [],
    steering: [],
    checkpoints: [],
    verification: null,
    blockers: [],
    pr: null,
    prError: null,
    leftover: null,
    question: null,
    goalCreation: null,
    conversation: {
      widgetId: WIDGET,
      messages,
      activity: [],
      question: null,
    },
    activity: [],
    notice: null,
    history: [],
  };
}

test("a dispatch the connection never delivered keeps the draft and shows no busy word", () => {
  jest.useFakeTimers();
  const flow = conversing();
  connection.send = (() => false) as typeof connection.send;
  const latch = conversationLatch(flow);
  latch.start();
  if (!flow.sendConversation()) latch.refuse();

  expect(latch.busy).toBe(false);
  expect(flow.conversationDraft).toBe(MESSAGE);
  expect(flow.pendingConversation).toBeNull();

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("the server's refusal of sendFlowConversation keeps the draft without the ceiling notice", () => {
  jest.useFakeTimers();
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  const latch = conversationLatch(flow);
  latch.start();
  expect(flow.sendConversation()).toBe(true);

  connection.receiveFrame({
    type: "flowError",
    message: "No widget conversation is open.",
    command: "sendFlowConversation",
  });
  latch.settle();

  expect(latch.busy).toBe(false);
  expect(flow.conversationDraft).toBe(MESSAGE);
  expect(flow.pendingConversation).toEqual({ text: MESSAGE });

  jest.advanceTimersByTime(COMMAND_CEILING_MS);
  expect(latch.notice).toBeNull();
});

test("a developer frame carrying the sent text clears the draft", () => {
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  flow.sendConversation();

  flow.handleEvent({ type: "flowConversationMessage", role: "developer", text: MESSAGE });

  expect(flow.conversationDraft).toBe("");
  expect(flow.pendingConversation).toBeNull();
});

test("a frame with another role or another text leaves the draft alone", () => {
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  flow.sendConversation();

  flow.handleEvent({ type: "flowConversationMessage", role: "agent", text: MESSAGE });
  flow.handleEvent({ type: "flowConversationMessage", role: "developer", text: "Another note" });

  expect(flow.conversationDraft).toBe(MESSAGE);
  expect(flow.pendingConversation).toEqual({ text: MESSAGE });
});

test("a confirmation never clears words typed since the dispatch", () => {
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  flow.sendConversation();
  flow.conversationDraft = "A second thought";

  flow.handleEvent({ type: "flowConversationMessage", role: "developer", text: MESSAGE });

  expect(flow.conversationDraft).toBe("A second thought");
  expect(flow.pendingConversation).toBeNull();
});

test("a snapshot whose conversation ends with the sent text clears the draft", () => {
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  flow.sendConversation();

  flow.handleEvent(
    snapshot([
      { role: "agent", text: "Which query owns it?" },
      { role: "developer", text: MESSAGE },
    ]),
  );

  expect(flow.conversationDraft).toBe("");
  expect(flow.pendingConversation).toBeNull();
});

test("a snapshot that does not end with the sent text leaves the draft alone", () => {
  const flow = conversing();
  connection.send = (() => true) as typeof connection.send;
  flow.sendConversation();

  flow.handleEvent(
    snapshot([
      { role: "developer", text: MESSAGE },
      { role: "agent", text: "The catalog query does." },
    ]),
  );

  expect(flow.conversationDraft).toBe(MESSAGE);
  expect(flow.pendingConversation).toEqual({ text: MESSAGE });
});

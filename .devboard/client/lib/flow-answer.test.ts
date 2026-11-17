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

const ANSWER = "The caller contract is the observable one";

/** A store holding one live implementation question the operator answered. */
function asked(): InstanceType<typeof FlowStore> {
  const flow = new FlowStore();
  flow.handleEvent({
    type: "flowQuestion",
    target: "implementation",
    id: "question-1",
    message: "Which caller observes this?",
    options: [],
  });
  flow.answers.implementation = ANSWER;
  return flow;
}

/** One `flowSnapshot` frame with the field set the server answers. */
function snapshot(question: unknown): { type: string } & Record<string, unknown> {
  return {
    type: "flowSnapshot",
    status: "running",
    sessionId: "issue-2076",
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
    question,
    goalCreation: null,
    conversation: null,
    activity: [],
    notice: null,
    history: [],
  };
}

test("a dispatch the connection never delivered keeps the draft and the question", () => {
  const flow = asked();
  connection.send = (() => false) as typeof connection.send;

  expect(flow.answerQuestion(flow.question!, ANSWER, "implementation")).toBe(false);

  expect(flow.answers.implementation).toBe(ANSWER);
  expect(flow.question).not.toBeNull();
  expect(flow.pendingAnswer).toBeNull();
});

test("an empty answer dispatches nothing", () => {
  const flow = asked();
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;

  expect(flow.answerQuestion(flow.question!, "   ", "implementation")).toBe(false);
  expect(sent).toEqual([]);
  expect(flow.answers.implementation).toBe(ANSWER);
});

test("the server's flowError refusal keeps the draft and the question", () => {
  const flow = asked();
  connection.send = (() => true) as typeof connection.send;

  expect(flow.answerQuestion(flow.question!, ANSWER, "implementation")).toBe(true);
  flow.handleEvent({ type: "flowError", message: "No pending Flow question with that id." });

  expect(flow.answers.implementation).toBe(ANSWER);
  expect(flow.question).not.toBeNull();
});

test("a snapshot that still carries the question keeps the draft", () => {
  const flow = asked();
  connection.send = (() => true) as typeof connection.send;
  flow.answerQuestion(flow.question!, ANSWER, "implementation");

  flow.handleEvent(
    snapshot({ id: "question-1", message: "Which caller observes this?", options: [] }),
  );

  expect(flow.answers.implementation).toBe(ANSWER);
  expect(flow.question).not.toBeNull();
});

test("the server's confirming snapshot clears the answered draft", () => {
  const flow = asked();
  connection.send = (() => true) as typeof connection.send;
  flow.answerQuestion(flow.question!, ANSWER, "implementation");

  flow.handleEvent(snapshot(null));

  expect(flow.answers.implementation).toBe("");
  expect(flow.question).toBeNull();
});

test("the next question confirms the answer it replaced", () => {
  const flow = asked();
  connection.send = (() => true) as typeof connection.send;
  flow.answerQuestion(flow.question!, ANSWER, "implementation");

  flow.handleEvent({
    type: "flowQuestion",
    target: "implementation",
    id: "question-2",
    message: "And the edge case?",
    options: [],
  });

  expect(flow.answers.implementation).toBe("");
  expect(flow.question?.id).toBe("question-2");
});

test("the answered goal question is confirmed by the goal snapshot", () => {
  const flow = new FlowStore();
  flow.handleEvent({ type: "flowGoalStarted" });
  flow.handleEvent({
    type: "flowQuestion",
    target: "goal",
    id: 1,
    message: "Choose an answer",
    options: [],
  });
  flow.answers.goal = ANSWER;
  connection.send = (() => true) as typeof connection.send;

  expect(flow.answerQuestion(flow.goalCreation!.question!, ANSWER, "goal")).toBe(true);
  expect(flow.answers.goal).toBe(ANSWER);

  flow.handleEvent({
    ...snapshot(null),
    goalCreation: { activity: [], question: null },
  });

  expect(flow.answers.goal).toBe("");
  expect(flow.goalCreation?.question).toBeNull();
});

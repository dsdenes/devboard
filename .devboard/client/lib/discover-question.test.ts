import { describe, expect, test } from "bun:test";
import type { ConnectionStore } from "./connection.svelte";
import { DiscoverStore } from "./discover.svelte";

/** Records every command so a test can assert what reached the socket. */
class RecordingSocket {
  sent: Record<string, unknown>[] = [];

  send(command: unknown): boolean {
    this.sent.push(command as Record<string, unknown>);
    return true;
  }
}

function connect(): { discover: DiscoverStore; socket: RecordingSocket } {
  const socket = new RecordingSocket();
  const discover = new DiscoverStore(socket as unknown as ConnectionStore);
  return { discover, socket };
}

/** Starts a sheet run, then delivers its one pending question. */
function asking(): { discover: DiscoverStore; socket: RecordingSocket } {
  const { discover, socket } = connect();
  discover.handleEvent({ type: "discoverStarted", agent: "sheet" });
  discover.handleEvent({
    type: "discoverQuestion",
    id: 1,
    message: "Which name applies?",
    agent: "sheet",
    options: [
      { label: "Alpha", recommended: true },
      { label: "Beta", recommended: false },
    ],
  });
  return { discover, socket };
}

describe("discover pending questions", () => {
  test("answering clears the agent's card entry and sends one answer", () => {
    const { discover, socket } = asking();
    expect(discover.question?.id).toBe(1);
    expect(discover.agentQuestionOf("sheet")?.id).toBe(1);

    discover.answer("Alpha");

    expect(discover.question).toBeNull();
    expect(discover.agentQuestionOf("sheet")).toBeNull();
    expect(socket.sent).toEqual([{ type: "answerDiscover", id: 1, value: "Alpha" }]);
  });

  test("a blank answer keeps the question pending and sends nothing", () => {
    const { discover, socket } = asking();

    discover.answer("   ");

    expect(discover.question?.id).toBe(1);
    expect(discover.agentQuestionOf("sheet")?.id).toBe(1);
    expect(socket.sent).toEqual([]);
  });

  test("stopping clears every agent's pending question", () => {
    const { discover } = asking();
    discover.handleEvent({
      type: "discoverQuestion",
      id: 2,
      message: "Which conventions?",
      agent: "conventions",
      options: [{ label: "Alpha", recommended: false }],
    });
    expect(discover.agentQuestionOf("conventions")?.id).toBe(2);

    discover.handleEvent({ type: "discoverStopped" });

    expect(discover.question).toBeNull();
    expect(discover.agentQuestionOf("sheet")).toBeNull();
    expect(discover.agentQuestionOf("conventions")).toBeNull();
    expect(Object.values(discover.agentQuestions).every((entry) => entry === null)).toBe(true);
  });

  test("an inactive snapshot drops a question left over from the previous run", () => {
    const { discover } = asking();

    discover.handleEvent({ type: "discoverState", state: { active: false } });

    expect(discover.active).toBe(false);
    expect(discover.agentQuestionOf("sheet")).toBeNull();
  });

  test("an active snapshot naming no question drops the panel and refuses an answer", () => {
    const { discover, socket } = asking();
    discover.answerDraft = "Aurora";

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet" },
    });

    expect(discover.active).toBe(true);
    expect(discover.question).toBeNull();
    expect(discover.agentQuestionOf("sheet")).toBeNull();
    expect(discover.answerDraft).toBe("");

    discover.answer("Alpha");

    expect(socket.sent).toEqual([]);
  });

  test("an active snapshot naming the pending question keeps the panel and its draft", () => {
    const { discover } = asking();
    discover.answerDraft = "Aurora";

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet", questionId: 1 },
    });

    expect(discover.question?.id).toBe(1);
    expect(discover.agentQuestionOf("sheet")?.id).toBe(1);
    expect(discover.answerDraft).toBe("Aurora");
  });

  test("an active snapshot naming another question discards the panel and its draft", () => {
    const { discover } = asking();
    discover.answerDraft = "Aurora";

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet", questionId: 2 },
    });

    expect(discover.question).toBeNull();
    expect(discover.agentQuestionOf("sheet")).toBeNull();
    expect(discover.answerDraft).toBe("");

    discover.handleEvent({
      type: "discoverQuestion",
      id: 2,
      message: "Which conventions apply?",
      agent: "sheet",
      options: [{ label: "Alpha", recommended: false }],
    });

    expect(discover.question?.id).toBe(2);
    expect(discover.agentQuestionOf("sheet")?.id).toBe(2);
    expect(discover.answerDraft).toBe("");
  });
});

describe("replayed discover frames", () => {
  const question = {
    type: "discoverQuestion",
    id: 1,
    message: "Which name applies?",
    agent: "sheet",
    options: [{ label: "Alpha", recommended: true }],
  };

  /** A page that read the workspace once, with a run and its question live. */
  function polling(): DiscoverStore {
    const { discover } = connect();
    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet", runId: "run-1" },
    });
    discover.handleEvent({ type: "discoverStarted", runId: "run-1", agent: "sheet" });
    discover.handleEvent({ type: "discoverActivity", agent: "sheet", text: "Reading the sheet." });
    discover.handleEvent(question);
    discover.answerDraft = "Aurora";
    return discover;
  }

  test("a poll repeating the run and its question keeps the typed answer", () => {
    const discover = polling();

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet", runId: "run-1", questionId: 1 },
    });
    discover.handleEvent({ type: "discoverStarted", runId: "run-1", agent: "sheet" });
    discover.handleEvent({ type: "discoverActivity", agent: "sheet", text: "Reading the sheet." });
    discover.handleEvent(question);

    expect(discover.active).toBe(true);
    expect(discover.activeAgent).toBe("sheet");
    expect(discover.question?.id).toBe(1);
    expect(discover.agentQuestionOf("sheet")?.id).toBe(1);
    expect(discover.answerDraft).toBe("Aurora");
    expect(discover.activity).toEqual(["Reading the sheet."]);
  });

  test("a different run clears the typed answer and its question", () => {
    const discover = polling();

    discover.handleEvent({ type: "discoverStarted", runId: "run-2", agent: "sheet" });

    expect(discover.runId).toBe("run-2");
    expect(discover.question).toBeNull();
    expect(discover.agentQuestionOf("sheet")).toBeNull();
    expect(discover.answerDraft).toBe("");
  });

  test("a different question on the same run clears the typed answer", () => {
    const discover = polling();

    discover.handleEvent({ ...question, id: 2, message: "Which conventions apply?" });

    expect(discover.question?.id).toBe(2);
    expect(discover.answerDraft).toBe("");
  });

  test("a fresh page keeps the run, its activity, and its pending question", () => {
    const { discover } = connect();

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet", runId: "run-1" },
    });
    discover.handleEvent({ type: "discoverStarted", runId: "run-1", agent: "sheet" });
    discover.handleEvent({ type: "discoverActivity", agent: "sheet", text: "Reading the sheet." });
    discover.handleEvent(question);

    expect(discover.active).toBe(true);
    expect(discover.activity).toEqual(["Reading the sheet."]);
    expect(discover.question?.id).toBe(1);
    expect(discover.answerDraft).toBe("");
  });
});

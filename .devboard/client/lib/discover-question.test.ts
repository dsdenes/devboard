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

  test("an active snapshot keeps the entries the run replayed", () => {
    const { discover } = asking();

    discover.handleEvent({
      type: "discoverState",
      state: { active: true, activeAgent: "sheet" },
    });

    expect(discover.agentQuestionOf("sheet")?.id).toBe(1);
  });
});

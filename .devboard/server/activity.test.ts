import { describe, expect, test } from "bun:test";
import { nextActivity, type AcpActivity, type ActivityStream } from "./acp";

function textUpdate(text: string, messageId?: string) {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function thoughtUpdate(text: string, messageId: string) {
  return {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    messageId,
  };
}

function collect(updates: unknown[]): AcpActivity[] {
  let stream: ActivityStream | undefined;
  const activities: AcpActivity[] = [];
  for (const update of updates) {
    const next = nextActivity(update, stream);
    if (next === undefined) continue;
    stream = next.stream;
    activities.push(next.activity);
  }
  return activities;
}

describe("activity coalescing", () => {
  test("joins the deltas of one message and starts a line per message", () => {
    expect(
      collect([
        textUpdate("The browser", "message-1"),
        textUpdate(" interface shows", "message-1"),
        textUpdate(" the stream.", "message-1"),
        textUpdate("Next message.", "message-2"),
      ]),
    ).toEqual([
      { text: "The browser", append: false },
      { text: " interface shows", append: true },
      { text: " the stream.", append: true },
      { text: "Next message.", append: false },
    ]);
  });

  test("does not join a reply onto the thought stream of the same message", () => {
    expect(
      collect([
        thoughtUpdate("Considering the record.", "message-1"),
        textUpdate("Resolving it.", "message-1"),
      ]),
    ).toEqual([
      { text: "Considering the record.", append: false },
      { text: "Resolving it.", append: false },
    ]);
  });

  test("starts a new line after a tool call even when the message id repeats", () => {
    expect(
      collect([
        textUpdate("Working", "message-1"),
        { sessionUpdate: "tool_call", title: "Reading 0001-example.md" },
        textUpdate(" more", "message-1"),
      ]),
    ).toEqual([
      { text: "Working", append: false },
      { text: "Reading 0001-example.md", append: false },
      { text: " more", append: false },
    ]);
  });

  test("treats text without a message id as complete lines", () => {
    expect(collect([textUpdate("Inspecting"), textUpdate("Updated")])).toEqual([
      { text: "Inspecting", append: false },
      { text: "Updated", append: false },
    ]);
  });

  test("reports a plan as one line and drops empty updates", () => {
    expect(
      collect([
        textUpdate("Working", "message-1"),
        { sessionUpdate: "plan", entries: [{ content: "Read" }, { content: "Write" }] },
        textUpdate("", "message-2"),
        textUpdate("After the plan", "message-2"),
      ]),
    ).toEqual([
      { text: "Working", append: false },
      { text: "Read\nWrite", append: false },
      { text: "After the plan", append: false },
    ]);
  });
});

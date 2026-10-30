#!/usr/bin/env bun
/**
 * The deterministic ACP peer for the prompt chat. It answers one session per
 * process, streams a short prose reply, and proposes a complete replacement
 * prompt in the fenced block the controller parses. It writes no file except
 * the prompt it received, when PROMPT_STUB_CAPTURE names a capture path.
 */

import { writeFileSync } from "node:fs";

const sessionId = "stub-prompt-session";
const proposal = process.env.PROMPT_STUB_PROPOSAL ?? "# Revised prompt\n\nFollow it.\n";
const fail = process.env.PROMPT_STUB_FAIL === "1";
const capture = process.env.PROMPT_STUB_CAPTURE;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(text: string): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "stub-prompt-message",
        content: { type: "text", text },
      },
    },
  });
}

async function handle(line: string): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const params = message.params as
      | { prompt?: Array<{ type?: string; text?: string }> }
      | undefined;
    const received = params?.prompt?.find((part) => part.type === "text")?.text;
    if (capture !== undefined && received !== undefined) {
      writeFileSync(capture, received, "utf8");
    }
    if (fail) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "stub prompt failure" },
      });
      return;
    }
    notify("Here is the revision.");
    notify(`\n\n<prompt-file>\n${proposal}</prompt-file>\n`);
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) await handle(line);
    newline = buffer.indexOf("\n");
  }
}

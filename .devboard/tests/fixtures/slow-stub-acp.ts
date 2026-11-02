#!/usr/bin/env bun
/**
 * A deterministic ACP peer that streams one line, stays alive for a bounded
 * turn, then streams a second line and finishes. Replacement fixtures use the
 * turn window to restart the dashboard while the peer is live.
 */

const sessionId = "slow-stub-session";
const delayMs = Number(process.env.SLOW_STUB_MS ?? "1500");

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
        messageId: "slow-stub-message",
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
  if (message.method !== "session/prompt") return;
  notify("first line");
  await Bun.sleep(delayMs);
  notify("\nsecond line");
  write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
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

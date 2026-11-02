#!/usr/bin/env bun
/**
 * The ACP peer for the source-dashboard prompt gate. A `/scout-recommendations`
 * prompt is a scan: it files nothing and finishes, so the worker records its
 * request and settles. Any other prompt is the prompt chat: it streams one
 * reply and proposes a complete replacement prompt.
 */

const sessionId = "verify-source-session";
const PROPOSAL =
  process.env.PROMPT_STUB_PROPOSAL ??
  "---\ndescription: revised\n---\n\n## Manifesto\n\nLeave the host with the improvements Auto Scout found.\n\nSaved by the gate.\n";

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
        messageId: "verify-source-message",
        content: { type: "text", text },
      },
    },
  });
}

function promptText(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  const prompt = (params as Record<string, unknown>).prompt;
  if (!Array.isArray(prompt)) return "";
  const first = prompt[0];
  if (typeof first !== "object" || first === null) return "";
  const text = (first as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
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
  const text = promptText(message.params);
  if (text.startsWith("/scout-recommendations ")) {
    notify("scanned");
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  notify("Here is the revision.");
  notify(`\n\n<prompt-file>\n${PROPOSAL}</prompt-file>\n`);
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

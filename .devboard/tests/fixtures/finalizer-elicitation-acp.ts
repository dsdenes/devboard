#!/usr/bin/env bun
/**
 * The deterministic finalizer peer for the deny-policy test. It asks one
 * elicitation before answering, records the answer when a probe path is set,
 * and then files every survivor named in the prompt.
 */

const sessionId = "stub-finalizer-session";
const probePath = process.env.COACH_FINALIZER_ANSWER;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextId = 1000;
const pending = new Map<number, (result: unknown) => void>();

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  const { promise, resolve } = Promise.withResolvers<unknown>();
  pending.set(id, resolve);
  write({ jsonrpc: "2.0", id, method, params });
  return promise;
}

function notify(text: string): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "stub-finalizer-message",
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

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  const marker = "Findings that passed the deterministic gate:\n";
  const start = text.indexOf(marker);
  const end = text.indexOf("\n\nExisting MCP catalog:", start);
  if (start < 0 || end < 0) {
    write({ jsonrpc: "2.0", id, error: { code: -32602, message: "prompt carried no findings" } });
    return;
  }
  const findings = JSON.parse(text.slice(start + marker.length, end)) as Array<{
    fingerprint: string;
  }>;

  const answer = await request("elicitation/create", {
    sessionId,
    message: "Which area first?",
    requestedSchema: {
      type: "object",
      properties: {
        area: { type: "string", enum: ["correctness", "tests"], default: "correctness" },
      },
      required: ["area"],
    },
  });
  if (probePath !== undefined) await Bun.write(probePath, JSON.stringify(answer));

  notify(
    JSON.stringify({
      decisions: findings.map((finding) => ({
        fingerprint: finding.fingerprint,
        action: "file",
        proposal: "Add the documented guardrail and keep the recorded behavior out of later runs.",
        acceptance: ["- [ ] The recorded behavior stops in the next run."],
      })),
    }),
  );
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.length === 0) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof message.method !== "string") {
      if (message.id !== undefined && pending.has(Number(message.id))) {
        pending.get(Number(message.id))?.(message.result);
        pending.delete(Number(message.id));
      }
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      // The elicitation answer arrives on this same stream, so the turn runs
      // in the background and the reader keeps draining input.
      void handlePrompt(message.id, message.params);
    }
  }
}

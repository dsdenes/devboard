#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Issues verification. It streams activity on
 * a timer, asks the client to auto-approve a permission, and ends its turn
 * only when the verification writes the finish marker. It logs the exact
 * prompt and working directory it received.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const logPath = process.env.ISSUES_STUB_ACP_LOG;
const finishPath = process.env.ISSUES_STUB_ACP_FINISH;
const question = process.env.ISSUES_STUB_ACP_QUESTION === "1";
const failPrompt = process.env.ISSUES_STUB_ACP_FAIL_PROMPT ?? "";
const failMarker = process.env.ISSUES_STUB_ACP_FAIL_MARKER;
const sessionId = "stub-issues-session";

function log(line: string): void {
  if (logPath !== undefined) appendFileSync(logPath, `${line}\n`);
}

log(`start ${process.pid} ${process.cwd()}`);

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
        messageId: "stub-message",
        content: { type: "text", text },
      },
    },
  });
}

async function waitForFinish(): Promise<void> {
  let count = 0;
  for (;;) {
    count += 1;
    notify(`activity ${count}`);
    if (finishPath !== undefined && existsSync(finishPath)) return;
    await Bun.sleep(200);
  }
}

async function handlePrompt(id: number | string): Promise<void> {
  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "stub-tool", title: "Run the command" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  log(`permission ${JSON.stringify(permission)}`);

  if (question) {
    const answer = await request("elicitation/create", {
      sessionId,
      message: "Which scope?",
      requestedSchema: {
        type: "object",
        properties: { scope: { type: "string", enum: ["every issue", "one issue"] } },
        required: ["scope"],
      },
    });
    log(`answer ${JSON.stringify(answer)}`);
  }

  await waitForFinish();
  log("finished");
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        newline = buffer.indexOf("\n");
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        if (message.method === "initialize") {
          write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (message.method === "session/new") {
          write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
        } else if (message.method === "session/prompt") {
          const params = message.params;
          const first =
            typeof params === "object" && params !== null && "prompt" in params && Array.isArray(params.prompt)
              ? params.prompt[0]
              : undefined;
          const text =
            typeof first === "object" && first !== null && "text" in first && typeof first.text === "string"
              ? first.text
              : "";
          log(`prompt ${text}`);
          const failOnce = failMarker === undefined || !existsSync(failMarker);
          if (failPrompt.length > 0 && text === failPrompt && failOnce) {
            if (failMarker !== undefined) writeFileSync(failMarker, "failed once\n");
            process.stderr.write(`stub failure for ${text}\n`);
            process.exit(1);
          }
          void handlePrompt(message.id);
        } else {
          write({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      } else if (message.id !== undefined) {
        const resolve = pending.get(Number(message.id));
        pending.delete(Number(message.id));
        resolve?.(message.result ?? message.error);
      }
    }
    newline = buffer.indexOf("\n");
  }
}

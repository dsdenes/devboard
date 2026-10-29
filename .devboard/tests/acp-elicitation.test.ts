import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpConnection } from "../server/acp";
import { createdDirectories, temporaryDirectory } from "./fixtures/scout-helpers";

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A minimal ACP peer: it answers the handshake, then asks one elicitation the
 * moment the prompt arrives and reports the answer back as assistant text.
 */
const STUB = `#!/usr/bin/env bun
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

let nextId = 1000;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  const { promise, resolve } = Promise.withResolvers();
  pending.set(id, resolve);
  write({ jsonrpc: "2.0", id, method, params });
  return promise;
}

function notify(text) {
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

async function handlePrompt(id) {
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
  notify(JSON.stringify(answer));
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message.method !== "string") {
      if (message.id !== undefined && pending.has(Number(message.id))) {
        pending.get(Number(message.id))(message.result);
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
      void handlePrompt(message.id);
    }
  }
}
`;

describe("ACP elicitation policy", () => {
  test("deny answers cancel and never surfaces the elicitation", async () => {
    const directory = await temporaryDirectory("acp-deny");
    const script = join(directory, "stub-acp.ts");
    await writeFile(script, STUB);

    let questions = 0;
    let text = "";
    const connection = new AcpConnection({
      command: `${process.execPath} ${script}`,
      cwd: directory,
      permissionPolicy: "deny",
      onActivity: () => undefined,
      onText: (chunk) => {
        text += chunk;
      },
      onQuestion: () => {
        questions += 1;
      },
    });
    try {
      await connection.run("survey");
      expect(questions).toBe(0);
      expect(text).toContain('"action":"cancel"');
    } finally {
      connection.close();
    }
  });
});

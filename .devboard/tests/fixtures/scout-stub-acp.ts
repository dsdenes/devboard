#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Auto Scout verification. It reads the scan
 * request the worker wrote, takes the next recommendations from a prepared
 * pool, applies the wave the verification configured, and writes
 * `<scan-dir>/recommendations.json`. It logs the exact prompt so the
 * verification can prove one prompt per scan.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const logPath = process.env.SCOUT_STUB_ACP_LOG;
const counterPath = process.env.SCOUT_STUB_ACP_COUNTER;
const waves = JSON.parse(process.env.SCOUT_STUB_WAVES ?? "[]") as Array<{
  count: number;
  shortfall?: string;
}>;
const askQuestion = process.env.SCOUT_STUB_QUESTION === "1";
const sessionId = "stub-scout-session";

function log(line: string): void {
  if (logPath !== undefined) appendFileSync(logPath, `${line}\n`);
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function nextScanIndex(): number {
  if (counterPath === undefined) return 0;
  let count = 0;
  try {
    count = readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    count = 0;
  }
  appendFileSync(counterPath, "scan\n");
  return count;
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
        messageId: "stub-scout-message",
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

function recommendationsFor(scanDirectory: string, index: number): Record<string, unknown> {
  const poolPath = process.env.SCOUT_STUB_POOL;
  const pool =
    poolPath === undefined || !existsSync(poolPath)
      ? []
      : (JSON.parse(readFileSync(poolPath, "utf8")) as Array<Record<string, unknown>>);
  const request = JSON.parse(readFileSync(join(scanDirectory, "request.json"), "utf8")) as {
    requested: number;
  };
  const wave = waves[Math.min(index, Math.max(waves.length - 1, 0))];
  const wanted = wave === undefined ? request.requested : Math.min(wave.count, request.requested);
  const offset = waves.slice(0, index).reduce((total, entry) => total + entry.count, 0);
  return {
    recommendations: pool.slice(offset, offset + wanted),
    ...(wave?.shortfall === undefined ? {} : { shortfall: wave.shortfall }),
  };
}

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  log(`prompt ${text}`);
  const scanDirectory = text.slice("/scout-recommendations ".length);
  const index = nextScanIndex();

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "stub-scout-tool", title: "Read the repository" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  log(`permission ${JSON.stringify(permission)}`);

  notify("scout activity start");
  if (askQuestion && index === 0) {
    const answer = await request("elicitation/create", {
      sessionId,
      message: "Which area first?",
      requestedSchema: {
        type: "object",
        properties: {
          area: { type: "string", enum: ["tests", "correctness"], default: "correctness" },
        },
        required: ["area"],
      },
    });
    log(`answer ${JSON.stringify(answer)}`);
  }
  notify("scout activity end");

  writeFileSync(
    join(scanDirectory, "recommendations.json"),
    `${JSON.stringify(recommendationsFor(scanDirectory, index), null, 2)}\n`,
  );
  log("finished");
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

log(`start ${process.pid} ${process.cwd()}`);

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
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      // The response to the permission request arrives on this same stream, so
      // the turn runs in the background and the reader keeps draining input.
      void handlePrompt(message.id, message.params);
    }
  }
}

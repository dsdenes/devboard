#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Dead Code verification. It reads the cycle
 * request the worker wrote, replays its seeded entry point through the real
 * Devboard MCP `entry_point` tool, and files one proven finding through the
 * real `issue_create` tool with the `dead-code` label. It never writes the
 * checkout and never starts a second turn.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context";
import { callTool } from "../../mcp/tools";

const logPath = process.env.DEAD_CODE_STUB_ACP_LOG;
const sessionId = "stub-dead-code-session";

function log(line: string): void {
  if (logPath !== undefined) appendFileSync(logPath, `${line}\n`);
}

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
        messageId: "stub-dead-code-message",
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

interface CycleRequest {
  cycleId: string;
  surface: string;
  seed: string;
  entryPoint: { path: string; line: number };
  issueRoom: number;
}

function issueBody(entry: { path: string; line: number }, quote: string): string {
  return [
    "## Category",
    "",
    "unreferenced-symbol",
    "",
    "## Summary",
    "",
    "`fixtureConstant` is exported and never referenced, so it is dead weight.",
    "",
    "## Evidence",
    "",
    `- \`${entry.path}:${entry.line}-${entry.line}\``,
    `  > ${quote}`,
    "",
    "## Reference search",
    "",
    "```sh",
    'rg -n "fixtureConstant" .',
    "```",
    "",
    "The search found no reference.",
    "",
    "## Files",
    "",
    `- \`${entry.path}\``,
    "",
    "## Removal",
    "",
    "Delete the `fixtureConstant` declaration.",
    "",
    "## Acceptance criteria",
    "",
    "- `rg -n \"fixtureConstant\" .` prints nothing.",
    "- The fixture suite still passes.",
    "",
    "---",
    "",
    "Filed by Dead Code. Remove exactly this dead code and keep the suite green.",
    "",
  ].join("\n");
}

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  log(`prompt ${text}`);
  const cycleDirectory = text.slice("/dead-code-removal ".length);
  const requestDocument = JSON.parse(
    readFileSync(join(cycleDirectory, "request.json"), "utf8"),
  ) as CycleRequest;

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "stub-dead-code-tool", title: "Read the repository" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  log(`permission ${JSON.stringify(permission)}`);

  const context = resolveContext();
  const replay = await callTool(context, "entry_point", {
    surface: "dead-code",
    seed: requestDocument.seed,
  });
  if (replay.error !== undefined) {
    log(`entry_point failed: ${replay.error}`);
  } else {
    log(`entry_point ${JSON.stringify(replay.value)}`);
  }

  notify(`reachable region: ${requestDocument.entryPoint.path}`);
  const source = readFileSync(
    join(context.repoDir, requestDocument.entryPoint.path),
    "utf8",
  ).split("\n");
  const quote = (source[requestDocument.entryPoint.line - 1] ?? "").trim();
  const created = await callTool(context, "issue_create", {
    title: "Remove the unreferenced fixture constant",
    body: issueBody(requestDocument.entryPoint, quote),
    labels: ["dead-code"],
  });
  if (created.error !== undefined) log(`issue_create failed: ${created.error}`);
  else log(`issue_create ${JSON.stringify(created.value)}`);

  notify("dead-code activity end");
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

log(`start ${process.pid} ${process.cwd()}`);

if (existsSync(join(process.cwd(), "request.json"))) {
  log("the peer starts in a cycle directory");
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
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      // Permission responses arrive on this same stream, so the turn runs in
      // the background and the reader keeps draining input.
      void handlePrompt(message.id, message.params);
    }
  }
}

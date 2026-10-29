#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Design System verification. It reads the
 * cycle's mode file, answers with a valid audit document, and edits the draft
 * documents in `admit` mode. It never contacts a real model or forge.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stubDir = process.env.DESIGN_STUB_DIR;
const logPath = process.env.DESIGN_STUB_LOG;
const delay = Number(process.env.DESIGN_STUB_DELAY_MS ?? "0");
const sessionId = "stub-design-session";

function log(line: string): void {
  if (logPath !== undefined) appendFileSync(logPath, `${line}\n`);
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextId = 2000;
const pending = new Map<number, (result: unknown) => void>();

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  const { promise, resolve: settle } = Promise.withResolvers<unknown>();
  pending.set(id, settle);
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
        messageId: "stub-design-message",
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

function mode(): string {
  if (stubDir === undefined) return "issue";
  try {
    return readFileSync(join(stubDir, "mode"), "utf8").trim() || "issue";
  } catch {
    return "issue";
  }
}

function firstPassage(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("#") && !entry.startsWith("---"));
  return line ?? "The interface uses documented tokens.";
}

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  const directory = text.slice("/design-system-audit ".length);
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
    cycleId: string;
  };
  const input = JSON.parse(readFileSync(join(directory, "input.json"), "utf8")) as {
    sources: Array<{ path: string; text: string }>;
    documents: Array<{ path: string; text: string }>;
  };
  const current = mode();
  log(`start ${process.pid} ${request.cycleId} ${current}`);
  notify(`design audit ${request.cycleId}`);
  if (delay > 0) await Bun.sleep(delay);

  const source = input.sources[0];
  const design = input.documents.find((document) => document.path.endsWith("DESIGN.md"));
  const passage = firstPassage(design?.text ?? "");
  const finding = {
    category: "color",
    title: `Fixture divergence ${request.cycleId}`,
    principle: { name: "Tokenized color", passage },
    evidence: [
      {
        path: source?.path ?? ".devboard/client/App.svelte",
        lines: "1",
        quote: (source?.text ?? "interface").split("\n")[0] ?? "interface",
      },
    ],
    files: [source?.path ?? ".devboard/client/App.svelte"],
    proposedChange: "Use the documented token in this surface.",
    acceptanceCriteria: ["The surface contains no undocumented color literal."],
  };

  const audit: Record<string, unknown> = { findings: [], documentation: { decision: "none" } };
  if (current === "issue" || current === "single") audit.findings = [finding];
  if (current === "admit") {
    if (stubDir === undefined) throw new Error("admit mode needs DESIGN_STUB_DIR");
    const prose = readFileSync(join(stubDir, "admit-DESIGN.md"), "utf8");
    const tokens = readFileSync(join(stubDir, "admit-tokens.json"), "utf8");
    const marker = `\n<!-- stub standard ${request.cycleId} -->\n`;
    const draftRoot = join(directory, "draft");
    mkdirSync(join(draftRoot, "design"), { recursive: true });
    writeFileSync(join(draftRoot, "DESIGN.md"), `${prose}${marker}`);
    writeFileSync(join(draftRoot, "design", "tokens.json"), tokens);
    audit.findings = [];
    audit.documentation = {
      decision: "edit",
      summary: `Document the fixture standard ${request.cycleId}`,
      rationale: "Two interface surfaces share the standard.",
      surfaces: [source?.path ?? ".devboard/client/App.svelte", input.sources[1]?.path ?? ".devboard/client/app.css"],
      contradiction: false,
      evidence: [],
      addsTokens: ["compact"],
    };
  }
  if (current === "invalid") {
    writeFileSync(join(directory, "audit.json"), "{ not json");
  } else {
    writeFileSync(join(directory, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  }
  log(`end ${process.pid} ${request.cycleId} ${current}`);
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

log(`started ${process.pid} ${process.cwd()}`);
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
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      void handlePrompt(message.id, message.params);
    }
  }
}

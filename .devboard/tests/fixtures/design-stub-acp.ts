#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Design System verification. It reads the
 * cycle's mode file, files each admissible finding through the real MCP
 * `issue_create` tool, edits the draft documents and records the release
 * request through `design_release_request` in `admit` mode. It never writes an
 * audit answer, contacts a real model, or contacts a real forge.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTool } from "../../mcp/tools";
import type { McpContext } from "../../mcp/context";

const stubDir = process.env.DESIGN_STUB_DIR;
const logPath = process.env.DESIGN_STUB_LOG;
const delay = Number(process.env.DESIGN_STUB_DELAY_MS ?? "0");
const sessionId = "stub-design-session";
const DESIGN_LABEL = "design";

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

interface CycleRequest {
  cycleId: string;
  repoDir: string;
  issueRoom: number;
}

function contextFor(cycleDir: string, repoDir: string): McpContext {
  const stateDir = process.env.STATE_DIR ?? join(repoDir, ".devboard", ".tmp");
  return {
    repoDir,
    harnessDir: process.env.DEVBOARD_HARNESS_DIR ?? resolve(import.meta.dir, "../.."),
    stateDir,
    environment: {
      ...process.env,
      REPO_DIR: repoDir,
      STATE_DIR: stateDir,
      DEVBOARD_TOOL_LOG: process.env.DEVBOARD_TOOL_LOG ?? join(cycleDir, "tool-log.jsonl"),
    },
  };
}

interface Finding {
  category: string;
  title: string;
  principle: { name: string; passage: string };
  evidence: Array<{ path: string; lines: string; quote: string }>;
  files: string[];
  proposedChange: string;
  acceptanceCriteria: string[];
}

function findingBody(entry: Finding): string {
  return [
    "## Category",
    "",
    entry.category,
    "",
    "## Violated principle or token",
    "",
    `**${entry.principle.name}**`,
    "",
    `> ${entry.principle.passage}`,
    "",
    "## Evidence",
    "",
    ...entry.evidence.map(
      (evidence) => `- \`${evidence.path}:${evidence.lines}\`\n  > ${evidence.quote}`,
    ),
    "",
    "## Files",
    "",
    ...entry.files.map((file) => `- \`${file}\``),
    "",
    "## Proposed change",
    "",
    entry.proposedChange,
    "",
    "## Acceptance criteria",
    "",
    ...entry.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "---",
    "",
    "Filed by Design System. Bring the interface in line with DESIGN.md and design/tokens.json.",
    "",
  ].join("\n");
}

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  const directory = text.slice("/design-system-audit ".length);
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as CycleRequest;
  const input = JSON.parse(readFileSync(join(directory, "input.json"), "utf8")) as {
    sources: Array<{ path: string; text: string }>;
    documents: Array<{ path: string; text: string }>;
  };
  const current = mode();
  log(`start ${process.pid} ${request.cycleId} ${current}`);
  notify(`design audit ${request.cycleId}`);
  if (delay > 0) await Bun.sleep(delay);

  const repoDir = request.repoDir ?? process.env.REPO_DIR ?? process.cwd();
  const context = contextFor(directory, repoDir);

  const source = input.sources[0];
  const design = input.documents.find((document) => document.path.endsWith("DESIGN.md"));
  const passage = firstPassage(design?.text ?? "");
  const finding: Finding = {
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

  if (current === "issue" || current === "single") {
    if (request.issueRoom > 0) {
      const result = await callTool(context, "issue_create", {
        title: finding.title,
        labels: [DESIGN_LABEL],
        body: findingBody(finding),
      });
      if (result.error !== undefined) log(`tool error ${result.error}`);
    } else {
      notify("skipped: the cycle's filing room is full; the hourly or open-issue cap leaves no room");
    }
  }

  if (current === "error" || current === "invalid") {
    const result = await callTool(context, "issue_create", {
      title: "",
      labels: [DESIGN_LABEL],
      body: findingBody(finding),
    });
    if (result.error !== undefined) log(`tool error ${result.error}`);
  }

  if (current === "admit") {
    if (stubDir === undefined) throw new Error("admit mode needs DESIGN_STUB_DIR");
    const prose = readFileSync(join(stubDir, "admit-DESIGN.md"), "utf8");
    const tokens = readFileSync(join(stubDir, "admit-tokens.json"), "utf8");
    const marker = `\n<!-- stub standard ${request.cycleId} -->\n`;
    const draftRoot = join(directory, "draft");
    mkdirSync(join(draftRoot, "design"), { recursive: true });
    writeFileSync(join(draftRoot, "DESIGN.md"), `${prose}${marker}`);
    writeFileSync(join(draftRoot, "design", "tokens.json"), tokens);
    const result = await callTool(context, "design_release_request", {
      cycleDir: directory,
      summary: `Document the fixture standard ${request.cycleId}`,
      rationale: "Two interface surfaces share the standard.",
    });
    if (result.error !== undefined) log(`tool error ${result.error}`);
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

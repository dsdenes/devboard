#!/usr/bin/env bun
/**
 * The deterministic ACP peer for API Standards verification. It reads the
 * cycle's request and input, files each admissible finding through the real
 * MCP `issue_create` tool, and writes one decision per candidate to
 * `findings.json`. It never writes an answer, contacts a real model, or
 * contacts a real forge. A mode file selects the scenario:
 *
 *   must | should | may | duplicate | cap | single | none
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTool } from "../../mcp/tools";
import type { McpContext } from "../../mcp/context";

const stubDir = process.env.API_STANDARDS_STUB_DIR;
const logPath = process.env.API_STANDARDS_STUB_LOG;
const delay = Number(process.env.API_STANDARDS_STUB_DELAY_MS ?? "0");
const sessionId = "stub-api-standards-session";

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
        messageId: "stub-api-standards-message",
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
  if (stubDir === undefined) return "none";
  try {
    return readFileSync(join(stubDir, "mode"), "utf8").trim() || "none";
  } catch {
    return "none";
  }
}

interface CycleRequest {
  cycleId: string;
  repoDir: string;
  sourceDir: string;
  skillDocument: string;
  rulesDocument: string;
  issueRoom: number;
}

interface CycleInput {
  sources: Array<{ path: string; text: string }>;
  routes: Array<{ method?: string; methods?: string[]; path: string; kind: string }>;
}

function contextFor(cycleDir: string, repoDir: string): McpContext {
  const stateDir = process.env.STATE_DIR ?? join(repoDir, ".devboard", ".tmp");
  return {
    repoDir,
    harnessDir: process.env.DEVBOARD_HARNESS_DIR ?? resolve(import.meta.dir, "../.."),
    stateDir,
    environment: process.env as Record<string, string | undefined>,
  };
}

interface Finding {
  title: string;
  ruleId: string;
  level: string;
  chapter: string;
  directive: string;
  endpoints: Array<{ method: string; path: string }>;
  evidence: Array<{ path: string; lines: string; quote: string }>;
  proposedChange: string;
  acceptanceCriteria: string[];
}

function body(entry: Finding, request: CycleRequest): string {
  return [
    "## Chapter",
    "",
    entry.chapter,
    "",
    "## Rule",
    "",
    `**${entry.ruleId} — ${entry.level}**`,
    "",
    "## Directive",
    "",
    `> ${entry.directive}`,
    "",
    "## Skill",
    "",
    `\`${request.skillDocument}\``,
    `\`${request.rulesDocument}\``,
    "",
    "## Evidence",
    "",
    ...entry.evidence.map(
      (evidence) => `- \`${evidence.path}:${evidence.lines}\`\n  > ${evidence.quote}`,
    ),
    "",
    "## Endpoints",
    "",
    ...entry.endpoints.map((endpoint) => `- \`${endpoint.method} ${endpoint.path}\``),
    "",
    "## Proposed change",
    "",
    entry.proposedChange,
    "",
    "## Acceptance criteria",
    "",
    ...entry.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
  ].join("\n");
}

function mustFinding(input: CycleInput): Finding {
  const source = input.sources[0]?.path ?? ".devboard/server/app.ts";
  const first = input.sources[0]?.text.split("\n")[0] ?? "export {};";
  return {
    title: "GET /api/ready answers POST without 405",
    ruleId: "148",
    level: "MUST",
    chapter: "HTTP requests",
    directive: "Use HTTP methods according to RFC 9110.",
    endpoints: [{ method: "POST", path: "/api/ready" }],
    evidence: [{ path: source, lines: "1", quote: first }],
    proposedChange: "Answer every non-GET request to /api/ready with 405 and an Allow header.",
    acceptanceCriteria: [
      "POST /api/ready answers 405 with an Allow header.",
      "GET /api/ready still answers the readiness document.",
    ],
  };
}

function shouldFinding(input: CycleInput): Finding {
  const source = input.sources[0]?.path ?? ".devboard/server/app.ts";
  const first = input.sources[0]?.text.split("\n")[0] ?? "export {};";
  return {
    title: "Collection paths do not use kebab-case",
    ruleId: "129",
    level: "SHOULD",
    chapter: "URLs",
    directive: "Write path segments in lower-case kebab-case.",
    endpoints: [{ method: "GET", path: "/api/goal-proposals" }],
    evidence: [{ path: source, lines: "1", quote: first }],
    proposedChange: "Rename the path to a lower-case kebab-case segment.",
    acceptanceCriteria: [
      "The route's path segments are all lower-case kebab-case.",
      "The previous path answers 404.",
    ],
  };
}

function singleFinding(input: CycleInput): Finding {
  const source = input.sources[0]?.path ?? ".devboard/server/app.ts";
  const first = input.sources[0]?.text.split("\n")[0] ?? "export {};";
  return {
    title: "Response body omits the required snake_case names",
    ruleId: "149",
    level: "MUST",
    chapter: "HTTP requests",
    directive: "Preserve the safety and idempotency of each method.",
    endpoints: [{ method: "POST", path: "/api/feedback" }],
    evidence: [{ path: source, lines: "1", quote: first }],
    proposedChange: "Answer a repeated identical POST with the same result.",
    acceptanceCriteria: [
      "Two identical POST requests produce one stored resource.",
      "Both answers carry the same resource document.",
    ],
  };
}

function mayFinding(input: CycleInput): Finding {
  const source = input.sources[0]?.path ?? ".devboard/server/app.ts";
  const first = input.sources[0]?.text.split("\n")[0] ?? "export {};";
  return {
    title: "No OpenAPI document is served",
    ruleId: "100",
    level: "MAY",
    chapter: "HTTP requests",
    directive: "Offer an optional OpenAPI document.",
    endpoints: [{ method: "GET", path: "/api/ready" }],
    evidence: [{ path: source, lines: "1", quote: first }],
    proposedChange: "Serve the specification from a documented path.",
    acceptanceCriteria: ["GET on the specification path answers 200."],
  };
}

function duplicateFinding(input: CycleInput): Finding {
  const entry = mustFinding(input);
  return { ...entry, title: "POST /api/ready ignores the method" };
}

/** One candidate decision, filed when the room allows and skipped otherwise. */
async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  const directory = text.slice("/api-standards-audit ".length);
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as CycleRequest;
  const input = JSON.parse(readFileSync(join(directory, "input.json"), "utf8")) as CycleInput;
  const current = mode();
  log(`start ${process.pid} ${request.cycleId} ${current}`);
  notify(`api-standards audit ${request.cycleId}`);
  if (delay > 0) await Bun.sleep(delay);

  const repoDir = request.repoDir;
  const context = contextFor(directory, repoDir);

  let finding: Finding | undefined;
  if (current === "must") finding = mustFinding(input);
  else if (current === "should") finding = shouldFinding(input);
  else if (current === "single") finding = singleFinding(input);
  else if (current === "duplicate") finding = duplicateFinding(input);
  else if (current === "may") finding = mayFinding(input);
  else if (current === "cap") finding = shouldFinding(input);

  const decisions: Array<Record<string, unknown>> = [];
  if (current === "may" && finding !== undefined) {
    decisions.push({ ...finding, decision: "skipped", reason: "may-level" });
  } else if (current === "duplicate" && finding !== undefined) {
    decisions.push({ ...finding, decision: "skipped", reason: "duplicate" });
  } else if (finding !== undefined) {
    if (request.issueRoom <= 0) {
      decisions.push({ ...finding, decision: "skipped", reason: "no-room" });
    } else {
      const result = await callTool(context, "issue_create", {
        title: finding.title,
        labels: ["api-standards"],
        body: body(finding, request),
      });
      if (result.error !== undefined) {
        log(`tool error ${result.error}`);
        decisions.push({ ...finding, decision: "skipped", reason: "tool-error" });
      } else {
        const value = result.value as { number?: unknown; url?: unknown };
        decisions.push({
          ...finding,
          decision: "filed",
          issueNumber: typeof value.number === "number" ? value.number : undefined,
          issueUrl: typeof value.url === "string" ? value.url : undefined,
        });
      }
    }
  }
  writeFileSync(
    join(directory, "findings.json"),
    `${JSON.stringify({ version: 1, findings: decisions }, null, 2)}\n`,
  );

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

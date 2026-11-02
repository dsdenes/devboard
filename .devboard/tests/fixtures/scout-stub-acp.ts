#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Auto Scout verification. It reads the scan
 * request the worker wrote, takes the next recommendations from a prepared
 * pool, and files each accepted item through the real Devboard MCP
 * `issue_create` tool with the `scout` label. It never writes a scan answer
 * file. It logs the exact prompt so the verification can prove one prompt per
 * scan.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context";
import { callTool } from "../../mcp/tools";

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

interface Candidate {
  category?: unknown;
  title?: unknown;
  summary?: unknown;
  impact?: unknown;
  significance?: unknown;
  significanceReason?: unknown;
  evidence?: unknown;
  proposedChange?: unknown;
  files?: unknown;
  acceptanceCriteria?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function evidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const path = "path" in entry && typeof entry.path === "string" ? entry.path : "";
    const span = "lines" in entry && typeof entry.lines === "string" ? entry.lines : "";
    if (path.length === 0 || span.length === 0) continue;
    lines.push(`- \`${path}:${span}\``);
    if ("quote" in entry && typeof entry.quote === "string" && entry.quote.length > 0) {
      lines.push(`  > ${entry.quote.replace(/\n/g, "\n  > ")}`);
    }
  }
  return lines;
}

function issueBody(candidate: Candidate): string {
  return [
    "## Category",
    "",
    text(candidate.category),
    "",
    "## Summary",
    "",
    text(candidate.summary),
    "",
    ...(text(candidate.impact).length === 0 ? [] : ["## Impact", "", text(candidate.impact), ""]),
    "## Significance",
    "",
    `${String(candidate.significance)}/5`,
    "",
    text(candidate.significanceReason),
    "",
    "## Evidence",
    "",
    ...evidence(candidate.evidence),
    "",
    "## Proposed change",
    "",
    text(candidate.proposedChange),
    "",
    "## Files",
    "",
    ...list(candidate.files).map((file) => `- \`${file}\``),
    "",
    "## Acceptance criteria",
    "",
    ...list(candidate.acceptanceCriteria).map((criterion) => `- ${criterion}`),
    "",
    "---",
    "",
    "Filed by Auto Scout. Implement this issue the way any other open issue is implemented.",
    "",
  ].join("\n");
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

async function fileRecommendations(scanDirectory: string, index: number): Promise<void> {
  const poolPath = process.env.SCOUT_STUB_POOL;
  const pool =
    poolPath === undefined || !existsSync(poolPath)
      ? []
      : (JSON.parse(readFileSync(poolPath, "utf8")) as Candidate[]);
  const requestDocument = JSON.parse(
    readFileSync(join(scanDirectory, "request.json"), "utf8"),
  ) as {
    requested: number;
    significanceThreshold: number;
    draftGoalHeadings: string[];
  };
  const wave = waves[Math.min(index, Math.max(waves.length - 1, 0))];
  const wanted = wave === undefined ? requestDocument.requested : Math.min(wave.count, requestDocument.requested);
  const offset = waves.slice(0, index).reduce((total, entry) => total + entry.count, 0);
  const candidates = pool.slice(offset, offset + Math.max(wanted, 0));

  const context = resolveContext();
  const known = new Set<string>();
  const storePath = process.env.SCOUT_STUB_STATE;
  if (storePath !== undefined && existsSync(storePath)) {
    const stored = JSON.parse(readFileSync(storePath, "utf8")) as { openTitles?: unknown };
    if (Array.isArray(stored.openTitles)) {
      for (const title of stored.openTitles) {
        if (typeof title === "string") known.add(normalizeTitle(title));
      }
    }
  }
  const listed = await callTool(context, "issues_list", { state: "all", limit: 200 });
  if (listed.value !== undefined && typeof listed.value === "object" && listed.value !== null) {
    const issues = Reflect.get(listed.value, "issues");
    if (Array.isArray(issues)) {
      for (const issue of issues) {
        if (typeof issue === "object" && issue !== null && "title" in issue) {
          const title = issue.title;
          if (typeof title === "string") known.add(normalizeTitle(title));
        }
      }
    }
  }
  for (const heading of requestDocument.draftGoalHeadings) known.add(normalizeTitle(heading));

  let filed = 0;
  for (const candidate of candidates) {
    if (filed >= wanted) break;
    const significance = typeof candidate.significance === "number" ? candidate.significance : 0;
    if (significance < requestDocument.significanceThreshold) continue;
    const title = text(candidate.title).trim();
    if (title.length === 0) continue;
    const key = normalizeTitle(title);
    if (known.has(key)) continue;
    const created = await callTool(context, "issue_create", {
      title,
      body: issueBody(candidate),
      labels: ["scout"],
    });
    if (created.error !== undefined) {
      log(`issue_create failed: ${created.error}`);
      continue;
    }
    known.add(key);
    filed += 1;
  }
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
  await fileRecommendations(scanDirectory, index);
  notify("scout activity end");

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

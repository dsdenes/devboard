#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Single Responsibility verification. It reads
 * the cycle request the worker wrote, replays its seeded entry point through
 * the real Devboard MCP `entry_point` tool, and files proven violations
 * through the real `issue_create` tool with the `single-responsibility` label.
 * Every filed issue carries one component, one category, the skill path, the
 * category's directive verbatim, and a verbatim evidence quote. It never
 * writes the checkout and never starts a second turn.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context";
import type { McpContext } from "../../mcp/context";
import { callTool } from "../../mcp/tools";

const logPath = process.env.SINGLE_RESPONSIBILITY_STUB_ACP_LOG;
const mode = process.env.SINGLE_RESPONSIBILITY_STUB_MODE ?? "two";
const delayMs = Number(process.env.SINGLE_RESPONSIBILITY_STUB_DELAY_MS ?? "0");
const sessionId = "stub-single-responsibility-session";

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
        messageId: "stub-single-responsibility-message",
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
  categories: string[];
  skillPath: string;
  issueRoom: number;
}

interface Candidate {
  title: string;
  category: string;
  component: string;
  evidence: { path: string; line: number };
}

/** The skill's violation bullet for one category, verbatim. */
function directiveOf(skillText: string, title: string): string {
  const line = skillText
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`- **${title}:**`));
  return line ?? "";
}

function bodyFor(
  candidate: Candidate,
  skillPath: string,
  skillText: string,
  titles: Record<string, string>,
  repoDir: string,
): string {
  const source = readFileSync(join(repoDir, candidate.evidence.path), "utf8").split(
    /\r?\n/,
  );
  const quote = (source[candidate.evidence.line - 1] ?? "").trim();
  return [
    "## Category",
    "",
    candidate.category,
    "",
    "## Component",
    "",
    candidate.component,
    "",
    "## Skill",
    "",
    skillPath,
    "",
    "## Directive",
    "",
    `> ${directiveOf(skillText, titles[candidate.category] ?? "")}`,
    "",
    "## Why the responsibilities are mixed",
    "",
    `The ${candidate.category} violation has one cause: this component answers two unrelated`,
    "requirements and therefore has two reasons to change.",
    "",
    "## Evidence",
    "",
    `- \`${candidate.evidence.path}:${candidate.evidence.line}-${candidate.evidence.line}\``,
    `  > ${quote}`,
    "",
    "## Refactor",
    "",
    "Move the unrelated behavior into its own component and leave this one cohesive.",
    "",
    "## Acceptance criteria",
    "",
    "- The component no longer contains the moved behavior.",
    "- The suite still passes.",
    "",
    "---",
    "",
    "Filed by Single Responsibility. Make exactly this change and keep the suite green.",
    "",
  ].join("\n");
}

const CATEGORY_TITLES: Record<string, string> = {
  "mixed-responsibilities": "Mixed responsibilities",
  "divergent-change": "Divergent change",
  "accidental-aggregation": "Accidental aggregation",
  "responsibility-leakage": "Responsibility leakage",
  "artificial-fragmentation": "Artificial fragmentation",
};

function candidatesFor(entry: { path: string; line: number }): Candidate[] {
  return [
    {
      title: "Split request parsing out of the fixture handler",
      category: "mixed-responsibilities",
      component: "`src/handler.ts` — `handleRequest`",
      evidence: { path: "src/handler.ts", line: 1 },
    },
    {
      title: "Separate the fixture validator's two change reasons",
      category: "divergent-change",
      component: "`src/handler.ts` — `handleRequest`",
      evidence: { path: "src/handler.ts", line: 2 },
    },
    {
      title: "Move fixture token formatting out of the renderer",
      category: "responsibility-leakage",
      component: "`src/renderer.ts` — `renderRow`",
      evidence: { path: "src/renderer.ts", line: 1 },
    },
    {
      title: "Move fixture locale lookup out of the formatter",
      category: "responsibility-leakage",
      component: "`src/formatter.ts` — `formatCell`",
      evidence: { path: "src/formatter.ts", line: 1 },
    },
    {
      title: "Coalesce the fixture reader's artificial wrappers",
      category: "artificial-fragmentation",
      component: "`src/reader.ts` — `readOne`",
      evidence: { path: "src/reader.ts", line: 1 },
    },
  ];
}

async function file(
  context: McpContext,
  candidate: Candidate,
  request: CycleRequest,
  skillText: string,
): Promise<boolean> {
  const created = await callTool(context, "issue_create", {
    title: candidate.title,
    labels: ["single-responsibility"],
    body: bodyFor(
      candidate,
      request.skillPath,
      skillText,
      CATEGORY_TITLES,
      context.repoDir,
    ),
  });
  if (created.error !== undefined) {
    log(`issue_create failed: ${created.error}`);
    return false;
  }
  log(`issue_create ${JSON.stringify(created.value)}`);
  return true;
}

async function handlePrompt(id: number | string, params: unknown): Promise<void> {
  const text = promptText(params);
  log(`prompt ${text}`);
  const cycleDirectory = text.slice("/single-responsibility ".length);
  const requestDocument = JSON.parse(
    readFileSync(join(cycleDirectory, "request.json"), "utf8"),
  ) as CycleRequest;

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "stub-single-responsibility-tool", title: "Read the repository" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  log(`permission ${JSON.stringify(permission)}`);

  const context = resolveContext();
  const replay = await callTool(context, "entry_point", {
    surface: "single-responsibility",
    seed: requestDocument.seed,
  });
  if (replay.error !== undefined) {
    log(`entry_point failed: ${replay.error}`);
  } else {
    log(`entry_point ${JSON.stringify(replay.value)}`);
  }

  const skillText = readFileSync(
    join(context.repoDir, requestDocument.skillPath),
    "utf8",
  );
  notify(`reachable region: ${requestDocument.entryPoint.path}`);
  notify(`categories: ${requestDocument.categories.join(", ")}`);

  if (mode === "none") {
    notify("no proven violation this cycle");
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (mode === "invalid") {
    notify("skipped: candidate outside the five categories");
    const created = await callTool(context, "issue_create", {
      title: "Report a fixture concern outside the five categories",
      labels: ["single-responsibility"],
      body: [
        "## Category",
        "",
        "unlisted-category",
        "",
        "## Component",
        "",
        "`src/handler.ts` — `handleRequest`",
        "",
        "## Skill",
        "",
        requestDocument.skillPath,
        "",
        "## Why the responsibilities are mixed",
        "",
        "The candidate does not fit one of the skill's five categories.",
        "",
        "## Evidence",
        "",
        `- \`src/handler.ts:1-1\``,
        `  > ${(readFileSync(join(context.repoDir, "src/handler.ts"), "utf8").split("\n")[0] ?? "").trim()}`,
        "",
        "## Refactor",
        "",
        "None; the candidate is not a violation.",
        "",
        "## Acceptance criteria",
        "",
        "- Nothing changes.",
        "",
      ].join("\n"),
    });
    if (created.error !== undefined) log(`issue_create failed: ${created.error}`);
    else log(`issue_create ${JSON.stringify(created.value)}`);
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (mode === "duplicate") {
    const candidate = candidatesFor(requestDocument.entryPoint)[0]!;
    const first = await file(context, candidate, requestDocument, skillText);
    if (first) {
      const second = await file(context, candidate, requestDocument, skillText);
      log(`duplicate attempt ${second ? "filed" : "refused"}`);
    }
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  const candidates = candidatesFor(requestDocument.entryPoint);
  const room = Math.max(0, Math.min(Number(requestDocument.issueRoom), candidates.length));
  if (delayMs > 0) await Bun.sleep(delayMs);
  for (const candidate of candidates.slice(0, room)) {
    const created = await file(context, candidate, requestDocument, skillText);
    if (!created) break;
  }
  notify("single-responsibility activity end");
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

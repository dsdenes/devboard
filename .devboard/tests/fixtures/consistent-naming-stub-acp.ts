#!/usr/bin/env bun
/**
 * The deterministic ACP peer for Consistent Naming verification. It reads the
 * cycle request the worker wrote, replays its seeded entry point through the
 * real Devboard MCP `entry_point` tool, searches the whole fixture repository
 * for each name in use, and files proven vocabulary changes through the real
 * `issue_create` tool with the `consistent-naming` label. Every filed issue
 * carries one concept, one category, the skill path, the category's directive
 * verbatim, one verbatim evidence quote, the complete occurrence list, and the
 * glossary authority or conflict the published glossaries require. It never
 * writes the checkout and never starts a second turn.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContext } from "../../mcp/context";
import type { McpContext } from "../../mcp/context";
import { callTool } from "../../mcp/tools";
import { occurrencesFor } from "../../issues/consistent-naming/occurrences";

const logPath = process.env.CONSISTENT_NAMING_STUB_ACP_LOG;
const mode = process.env.CONSISTENT_NAMING_STUB_MODE ?? "seven";
const delayMs = Number(process.env.CONSISTENT_NAMING_STUB_DELAY_MS ?? "0");
const sessionId = "stub-consistent-naming-session";

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
        messageId: "stub-consistent-naming-message",
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
  glossaries: string[];
  issueRoom: number;
}

interface Candidate {
  title: string;
  category: string;
  concept: string;
  nameInUse: string;
  proposed: string;
  /** The glossary section this filing must carry, when one governs it. */
  glossary?: { path: string; label: string; id: string; conflict: boolean };
}

const CATEGORY_TITLES: Record<string, string> = {
  "synonymous naming": "Synonymous naming",
  "semantic ambiguity": "Semantic ambiguity",
  "inconsistent vocabulary": "Inconsistent vocabulary",
  "misleading naming": "Misleading naming",
  "unnecessary terminology": "Unnecessary terminology",
  "conceptual collision": "Conceptual collision",
  "implementation-driven naming": "Implementation-driven naming",
};

/** The skill's directive for one category: the whole bullet, unwrapped. */
function directiveOf(skillText: string, title: string): string {
  const lines = skillText.split(/\r?\n/);
  let inViolations = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      inViolations = line.slice(3).trim().toLowerCase() === "architectural violations";
      continue;
    }
    if (!inViolations) continue;
    const match = /^-\s+\*\*(.+?):\*\*\s*(.+)$/.exec(line.trim());
    if (match === null || (match[1] ?? "").trim().toLowerCase() !== title.toLowerCase()) {
      continue;
    }
    const parts = [(match[2] ?? "").trim()];
    let next = index + 1;
    while (next < lines.length) {
      const continuation = lines[next] ?? "";
      const trimmed = continuation.trim();
      if (trimmed.length === 0 || trimmed.startsWith("- ") || continuation.startsWith("#")) {
        break;
      }
      parts.push(trimmed);
      next += 1;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function glossarySection(glossary: NonNullable<Candidate["glossary"]>): string {
  if (glossary.conflict) {
    return (
      "## Glossary conflict\n\n" +
      `${glossary.path} assigns the name in use to “${glossary.label}” ` +
      `(concept id \`${glossary.id}\`); the rename adopts the glossary label.\n`
    );
  }
  return (
    "## Glossary\n\n" +
    `${glossary.path} — preferred label “${glossary.label}”, concept id \`${glossary.id}\`.\n`
  );
}

function bodyFor(
  candidate: Candidate,
  request: CycleRequest,
  skillText: string,
  repoDir: string,
): string {
  const found = occurrencesFor(repoDir, candidate.nameInUse);
  const occurrences: string[] = [];
  let evidence: { path: string; line: number } | undefined;
  for (const [path, lines] of [...found].sort(([left], [right]) => left.localeCompare(right))) {
    for (const line of lines) occurrences.push(`- \`${path}:${line}\``);
    if (evidence === undefined && lines[0] !== undefined) evidence = { path, line: lines[0] };
  }
  if (evidence === undefined) throw new Error(`no occurrence of ${candidate.nameInUse}`);
  const source = readFileSync(join(repoDir, evidence.path), "utf8").split(/\r?\n/);
  const quote = (source[evidence.line - 1] ?? "").trim();
  const directive = directiveOf(skillText, CATEGORY_TITLES[candidate.category] ?? "");
  return [
    "## Category",
    "",
    candidate.category,
    "",
    "## Concept",
    "",
    candidate.concept,
    "",
    "## Name in use",
    "",
    candidate.nameInUse,
    "",
    "## Proposed name",
    "",
    candidate.proposed,
    "",
    "## Skill",
    "",
    request.skillPath,
    "",
    "## Directive",
    "",
    `> ${directive}`,
    "",
    ...(candidate.glossary === undefined ? [] : [glossarySection(candidate.glossary), ""]),
    "## Why the name is inconsistent",
    "",
    `“${candidate.nameInUse}” is not the one name the ${candidate.concept} concept carries.`,
    "",
    "## Evidence",
    "",
    `- \`${evidence.path}:${evidence.line}\``,
    `  > ${quote}`,
    "",
    "## Occurrences",
    "",
    ...occurrences,
    "",
    "## Rename",
    "",
    `Rename every occurrence of “${candidate.nameInUse}” to “${candidate.proposed}”; ` +
      "behavior is unchanged.",
    "",
    "## Acceptance criteria",
    "",
    `- No occurrence of “${candidate.nameInUse}” remains in the repository.`,
    "- The suite still passes.",
    "",
    "---",
    "",
    "Filed by Consistent Naming. Make exactly this vocabulary change and keep behavior unchanged.",
    "",
  ].join("\n");
}

function candidatesFor(): Candidate[] {
  return [
    {
      title: "Use order total for the order sum concept",
      category: "synonymous naming",
      concept: "order total",
      nameInUse: "order sum",
      proposed: "Order Total",
      glossary: {
        path: ".omp/discover/glossary/orders.glossary.yaml",
        label: "Order Total",
        id: "order-total",
        conflict: false,
      },
    },
    {
      title: "Name the order sum consistently across every layer",
      category: "inconsistent vocabulary",
      concept: "order total",
      nameInUse: "order sum",
      proposed: "Order Total",
      glossary: {
        path: ".omp/discover/glossary/orders.glossary.yaml",
        label: "Order Total",
        id: "order-total",
        conflict: false,
      },
    },
    {
      title: "Name the price concept unit price",
      category: "synonymous naming",
      concept: "price",
      nameInUse: "price",
      proposed: "unit price",
    },
    {
      title: "Use invoice for the bill concept",
      category: "conceptual collision",
      concept: "invoice",
      nameInUse: "bill",
      proposed: "Invoice",
      glossary: {
        path: ".omp/discover/glossary/orders.glossary.yaml",
        label: "Invoice",
        id: "invoice",
        conflict: false,
      },
    },
    {
      title: "Report the bill conflict with the invoice concept",
      category: "misleading naming",
      concept: "order total",
      nameInUse: "bill",
      proposed: "Invoice",
      glossary: {
        path: ".omp/discover/glossary/orders.glossary.yaml",
        label: "Invoice",
        id: "invoice",
        conflict: true,
      },
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
    labels: ["consistent-naming"],
    body: bodyFor(candidate, request, skillText, context.repoDir),
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
  const cycleDirectory = text.slice("/consistent-naming ".length);
  const requestDocument = JSON.parse(
    readFileSync(join(cycleDirectory, "request.json"), "utf8"),
  ) as CycleRequest;

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "stub-consistent-naming-tool", title: "Read the repository" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  log(`permission ${JSON.stringify(permission)}`);

  const context = resolveContext();
  const replay = await callTool(context, "entry_point", {
    surface: "consistent-naming",
    seed: requestDocument.seed,
  });
  if (replay.error !== undefined) {
    log(`entry_point failed: ${replay.error}`);
  } else {
    log(`entry_point ${JSON.stringify(replay.value)}`);
  }

  const skillText = readFileSync(join(context.repoDir, requestDocument.skillPath), "utf8");
  notify(`reachable region: ${requestDocument.entryPoint.path}`);
  notify(`categories: ${requestDocument.categories.join(", ")}`);
  notify(`glossaries: ${requestDocument.glossaries.join(", ")}`);

  if (mode === "none") {
    notify("no proven violation this cycle");
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (mode === "invalid") {
    notify("skipped: candidate outside the seven categories");
    const created = await callTool(context, "issue_create", {
      title: "Report a fixture concern outside the seven categories",
      labels: ["consistent-naming"],
      body: [
        "## Category",
        "",
        "unlisted-category",
        "",
        "## Concept",
        "",
        "the fixture",
        "",
        "## Skill",
        "",
        requestDocument.skillPath,
        "",
        "## Why the name is inconsistent",
        "",
        "The candidate does not fit one of the skill's seven categories.",
        "",
        "## Evidence",
        "",
        "- `server/handler.ts:1`",
        "  > // The order sum is computed here.",
        "",
        "## Occurrences",
        "",
        "- `server/handler.ts:1`",
        "",
        "## Rename",
        "",
        "Rename nothing.",
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

  if (mode === "incomplete") {
    notify("skipped: the occurrence list is incomplete");
    const candidate = candidatesFor()[0]!;
    const body = bodyFor(candidate, requestDocument, skillText, context.repoDir).replace(
      "- `README.md:4`\n",
      "",
    );
    const created = await callTool(context, "issue_create", {
      title: candidate.title,
      labels: ["consistent-naming"],
      body,
    });
    if (created.error !== undefined) log(`issue_create failed: ${created.error}`);
    else log(`issue_create ${JSON.stringify(created.value)}`);
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (mode === "duplicate") {
    const candidate = candidatesFor()[0]!;
    const first = await file(context, candidate, requestDocument, skillText);
    if (first) {
      const second = await file(context, candidate, requestDocument, skillText);
      log(`duplicate attempt ${second ? "filed" : "refused"}`);
    }
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  const candidates = candidatesFor();
  const room = Math.max(0, Math.min(Number(requestDocument.issueRoom), candidates.length));
  if (delayMs > 0) await Bun.sleep(delayMs);
  for (const candidate of candidates.slice(0, room)) {
    const created = await file(context, candidate, requestDocument, skillText);
    if (!created) break;
  }
  notify("consistent-naming activity end");
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

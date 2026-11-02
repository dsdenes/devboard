import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWithin, type McpContext } from "./context";

/**
 * Flow session writes. Every tool here addresses one session directory under
 * `<STATE_DIR>/flow/` and writes exactly the file the Flow server already
 * reads: `widgets.json`, `steering-ack.jsonl`, `checkpoints.jsonl`, and
 * `verification.json`. The server keeps owning reconciliation, widget identity,
 * acceptance, and the checkpoint/verification projections.
 */

export const FLOW_CATEGORIES = [
  "contract",
  "entity",
  "naming",
  "data",
  "dependency",
  "irreversible",
  "structure",
] as const;

const CATEGORY_SET = new Set<string>(FLOW_CATEGORIES);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "not-run"]);

function flowRoot(context: McpContext): string {
  const root = join(context.stateDir, "flow");
  mkdirSync(root, { recursive: true });
  return root;
}

function sessionDirectory(context: McpContext, value: unknown): string {
  const resolved = resolveWithin(flowRoot(context), value, "sessionDir", { mustExist: true });
  return resolved.absolute;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function appendLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function readAcknowledged(path: string): Set<string> {
  const seen = new Set<string>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return seen;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        seen.add(parsed);
      } else if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
        const id = parsed.id;
        if (typeof id === "string") seen.add(id);
      }
    } catch {
      // A malformed line stays visible to the server, which never trusts it.
    }
  }
  return seen;
}

export interface FlowWidgetInput {
  category: string;
  concept: string;
  summary: string;
  rationale: string;
  files: string[];
}

function widgetsOf(value: unknown): FlowWidgetInput[] {
  if (!Array.isArray(value)) throw new Error("widgets must be a list.");
  const widgets: FlowWidgetInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`widget ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const category = nonEmpty(record.category, `widget ${index + 1} category`);
    if (!CATEGORY_SET.has(category)) {
      throw new Error(
        `widget ${index + 1} category must be one of ${FLOW_CATEGORIES.join(", ")}.`,
      );
    }
    if (!Array.isArray(record.files) || record.files.length === 0) {
      throw new Error(`widget ${index + 1} files must be a non-empty list.`);
    }
    const files: string[] = [];
    for (const file of record.files) {
      files.push(nonEmpty(file, `widget ${index + 1} file`).replace(/\\/g, "/"));
    }
    widgets.push({
      category,
      concept: nonEmpty(record.concept, `widget ${index + 1} concept`),
      summary: nonEmpty(record.summary, `widget ${index + 1} summary`),
      rationale: nonEmpty(record.rationale, `widget ${index + 1} rationale`),
      files: [...new Set(files)],
    });
  }
  return widgets;
}

/** Replaces `widgets.json` for one session and returns what became current. */
export function registerFlowWidgets(
  context: McpContext,
  options: { sessionDir?: unknown; widgets?: unknown },
) {
  const directory = sessionDirectory(context, options.sessionDir);
  const widgets = widgetsOf(options.widgets);
  const path = join(directory, "widgets.json");
  writeFileSync(path, `${JSON.stringify({ widgets }, null, 2)}\n`);
  return { path, widgets: widgets.length };
}

/** Appends the consumed steering ids to `steering-ack.jsonl`, once each. */
export function acknowledgeFlowSteering(
  context: McpContext,
  options: { sessionDir?: unknown; ids?: unknown },
) {
  const directory = sessionDirectory(context, options.sessionDir);
  if (!Array.isArray(options.ids)) throw new Error("ids must be a list of steering ids.");
  const path = join(directory, "steering-ack.jsonl");
  const seen = readAcknowledged(path);
  const acknowledged: string[] = [];
  const skipped: string[] = [];
  for (const entry of options.ids) {
    const id = nonEmpty(entry, "steering id");
    if (seen.has(id)) {
      skipped.push(id);
      continue;
    }
    seen.add(id);
    appendLine(path, { id });
    acknowledged.push(id);
  }
  return { path, acknowledged, skipped };
}

/** Appends one checkpoint line in commit order. */
export function recordFlowCheckpoint(
  context: McpContext,
  options: {
    sessionDir?: unknown;
    id?: unknown;
    timestamp?: unknown;
    summary?: unknown;
    files?: unknown;
    commit?: unknown;
    verification?: unknown;
  },
) {
  const directory = sessionDirectory(context, options.sessionDir);
  const commit = nonEmpty(options.commit, "commit");
  const short = commit.slice(0, 7);
  const id =
    options.id === undefined ? `checkpoint-${short}` : nonEmpty(options.id, "id");
  const summary = nonEmpty(options.summary, "summary");
  const files = options.files === undefined ? 0 : options.files;
  if (typeof files !== "number" || !Number.isInteger(files) || files < 0) {
    throw new Error("files must be a non-negative integer.");
  }
  const verification = options.verification === undefined ? "not-run" : options.verification;
  if (typeof verification !== "string" || !VERIFICATION_STATUSES.has(verification)) {
    throw new Error('verification must be "passed", "failed", or "not-run".');
  }
  const timestamp =
    options.timestamp === undefined ? new Date().toISOString() : nonEmpty(options.timestamp, "timestamp");
  const path = join(directory, "checkpoints.jsonl");
  appendLine(path, {
    id,
    timestamp,
    summary,
    files,
    commit,
    verification,
  });
  return { path, id, commit, summary };
}

/** Replaces `verification.json` with the latest verification outcome. */
export function recordFlowVerification(
  context: McpContext,
  options: {
    sessionDir?: unknown;
    command?: unknown;
    status?: unknown;
    timestamp?: unknown;
    output?: unknown;
  },
) {
  const directory = sessionDirectory(context, options.sessionDir);
  const status = options.status;
  if (typeof status !== "string" || !VERIFICATION_STATUSES.has(status)) {
    throw new Error('status must be "passed", "failed", or "not-run".');
  }
  const command = optionalText(options.command, "command");
  const output = optionalText(options.output, "output");
  const timestamp =
    options.timestamp === undefined ? new Date().toISOString() : nonEmpty(options.timestamp, "timestamp");
  const path = join(directory, "verification.json");
  writeFileSync(path, `${JSON.stringify({ command, status, timestamp, output }, null, 2)}\n`);
  return { path, status, timestamp };
}

import type { AgentSession } from "../lib/agent-sessions";
import {
  evidenceFingerprint,
  firstNormalizedLine,
  normalizeSessionLine,
} from "../lib/agent-sessions";

/**
 * Deterministic Coach detection. Nothing here calls a model: a finding exists
 * only when the evidence crosses one of the five fixed thresholds, and its
 * fingerprint is the first 16 hex characters of SHA-256 over the category and
 * its normalized signature.
 */

export const COACH_CATEGORIES = [
  "tool-failure",
  "retry-loop",
  "repeat-question",
  "run-failure",
  "tool-gap",
] as const;

export type CoachCategory = (typeof COACH_CATEGORIES)[number];

export function isCoachCategory(value: unknown): value is CoachCategory {
  return typeof value === "string" && (COACH_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Read-only inspection every agent performs. A signature matches a prefix when
 * it equals the prefix or continues with a space, so `git status --short` is
 * the same behavior as `git status` and never becomes a finding.
 */
export const TRIVIAL_COMMANDS: readonly string[] = Object.freeze([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "printf",
  "grep",
  "rg",
  "find",
  "sed -n",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git worktree list",
  "git ls-remote",
  "git remote -v",
  "bun test",
  "bun run check",
  "bun run build",
  "bunx tsc --noEmit",
]);

/** True when a normalized signature is plain inspection, not a capability gap. */
export function isTrivialCommand(signature: string): boolean {
  for (const prefix of TRIVIAL_COMMANDS) {
    if (signature === prefix || signature.startsWith(`${prefix} `)) return true;
  }
  return false;
}

/** `cd <path> && <command>` is the command; the directory change is noise. */
function collapseDirectoryChange(command: string): string {
  let value = command.trim();
  for (;;) {
    const match = /^\(\s*cd\s+[^()&;]+\s*&&\s*([\s\S]*)\)$/.exec(value);
    if (match !== null && match[1] !== undefined) {
      value = match[1].trim();
      continue;
    }
    const chain = /^cd\s+\S+\s*&&\s*([\s\S]+)$/.exec(value);
    if (chain !== null && chain[1] !== undefined) {
      value = chain[1].trim();
      continue;
    }
    return value;
  }
}

/** The fixed evidence window: the 24 hours ending at cycle start. */
export const EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A repeated tool call is a loop only at this count, with this many after errors. */
export const RETRY_CALLS = 3;
export const RETRY_AFTER_ERROR_CALLS = 2;
/** A repeated command needs this many calls across this many sessions. */
export const TOOL_GAP_CALLS = 3;
export const TOOL_GAP_SESSIONS = 2;
export const TOOL_GAP_MIN_LENGTH = 12;
/** One line on a finding and an issue title. */
export const FINDING_LINE_MAX = 80;

export interface FindingWindow {
  start: string;
  end: string;
}

export interface CoachJournalRecord {
  kind: string;
  ts: string;
  text: string;
  scope: string | null;
}

export interface CoachFinding {
  category: CoachCategory;
  fingerprint: string;
  /** One line, bounded to 80 characters. */
  line: string;
  /** The normalized signature the fingerprint covers. */
  subject: string;
  firstAt: string;
  lastAt: string;
  count: number;
  /** Contributing session ids, sorted. */
  sessions: string[];
  /** Contributing journal run/lane scopes, sorted. */
  scopes: string[];
}

export interface AnalyzeOptions {
  sessions: AgentSession[];
  journal: CoachJournalRecord[];
  window: FindingWindow;
  repoDir: string;
  /** Normalized command signatures an MCP tool already covers. */
  covers?: readonly string[];
}

function boundLine(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= FINDING_LINE_MAX) return single;
  return `${single.slice(0, FINDING_LINE_MAX - 1).trimEnd()}…`;
}

/** Replaces the repository root and the volatile tokens a command repeats. */
export function normalizeCommandSignature(command: string, repoDir: string): string {
  let value = collapseDirectoryChange(command);
  value = value
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "<env> ");
  const root = repoDir.replace(/\/+$/, "");
  if (root.length > 0) value = value.split(root).join("<repo>");
  value = value
    .replace(/\.worktree\/[^\s/]+/g, ".worktree/<worktree>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<timestamp>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  // `git -C . status` and `git -C <repo> status` are the checkout's `git status`.
  value = value.replace(/^git -C (?:\.|<repo>|\.worktree\/<worktree>) /, "git ");
  return value;
}

/** True when a catalog `covers` entry already names this signature. */
export function isCovered(signature: string, covers: readonly string[]): boolean {
  for (const cover of covers) {
    if (cover.endsWith("*")) {
      if (signature.startsWith(cover.slice(0, -1))) return true;
      continue;
    }
    if (signature === cover || signature.startsWith(`${cover} `)) return true;
  }
  return false;
}

interface Group {
  category: CoachCategory;
  signature: string;
  line: string;
  subject: string;
  count: number;
  firstAt: string;
  lastAt: string;
  sessions: Set<string>;
  scopes: Set<string>;
}

function inWindow(ts: string | null, start: number, end: number): number | undefined {
  if (ts === null) return undefined;
  const instant = Date.parse(ts);
  if (!Number.isFinite(instant) || instant < start || instant > end) return undefined;
  return instant;
}

function stampOf(instant: number): string {
  return new Date(instant).toISOString();
}

function merge(
  groups: Map<string, Group>,
  group: Omit<Group, "sessions" | "scopes"> & { sessions: string[]; scopes: string[] },
): void {
  const existing = groups.get(group.signature);
  if (existing === undefined) {
    groups.set(group.signature, {
      ...group,
      sessions: new Set(group.sessions),
      scopes: new Set(group.scopes),
    });
    return;
  }
  existing.count += group.count;
  if (group.firstAt < existing.firstAt) existing.firstAt = group.firstAt;
  if (group.lastAt > existing.lastAt) existing.lastAt = group.lastAt;
  for (const id of group.sessions) existing.sessions.add(id);
  for (const scope of group.scopes) existing.scopes.add(scope);
}

/**
 * Turns one window of sessions and journal records into findings. Only the
 * five categories can produce one; every other record is context.
 */
export function analyzeEvidence(options: AnalyzeOptions): CoachFinding[] {
  const start = Date.parse(options.window.start);
  const end = Date.parse(options.window.end);
  const groups = new Map<string, Group>();

  /* tool-failure: an errored tool result seen in two distinct sessions. */
  for (const session of options.sessions) {
    for (const result of session.results) {
      if (!result.isError) continue;
      const instant = inWindow(result.timestamp, start, end);
      if (instant === undefined) continue;
      const line = firstNormalizedLine(result.text, { repoDir: options.repoDir });
      if (line.length === 0) continue;
      const signature = `${result.toolName}\n${line}`;
      merge(groups, {
        category: "tool-failure",
        signature,
        line: boundLine(`${result.toolName} failed: ${line}`),
        subject: signature,
        count: 1,
        firstAt: stampOf(instant),
        lastAt: stampOf(instant),
        sessions: [session.id],
        scopes: [],
      });
    }
  }

  /* retry-loop: one call identity repeated after this tool already errored. */
  for (const session of options.sessions) {
    const events: Array<{ index: number; kind: "call" | "error"; tool: string; identity: string }> = [];
    for (const call of session.calls) {
      events.push({
        index: call.index,
        kind: "call",
        tool: call.name,
        identity: `${call.name}\n${call.argumentsText}`,
      });
    }
    for (const result of session.results) {
      if (!result.isError) continue;
      events.push({ index: result.index, kind: "error", tool: result.toolName, identity: result.toolName });
    }
    events.sort((left, right) => left.index - right.index);
    const errored = new Set<string>();
    const totals = new Map<string, { count: number; afterError: number; tool: string; times: number[] }>();
    for (const event of events) {
      if (event.kind === "error") {
        errored.add(event.tool);
        continue;
      }
      const entry = totals.get(event.identity) ?? {
        count: 0,
        afterError: 0,
        tool: event.tool,
        times: [],
      };
      entry.count += 1;
      if (errored.has(event.tool)) entry.afterError += 1;
      const call = session.calls.find((candidate) => candidate.index === event.index);
      const instantaneous = call?.timestamp === null || call?.timestamp === undefined
        ? Date.parse(session.startedAt)
        : Date.parse(call.timestamp);
      if (Number.isFinite(instantaneous)) entry.times.push(instantaneous);
      totals.set(event.identity, entry);
    }
    for (const [identity, entry] of totals) {
      if (entry.count < RETRY_CALLS || entry.afterError < RETRY_AFTER_ERROR_CALLS) continue;
      const times = entry.times.filter((instant) => instant >= start && instant <= end);
      if (times.length === 0) continue;
      const signature = `${session.id}\n${identity}`;
      merge(groups, {
        category: "retry-loop",
        signature,
        line: boundLine(
          `retry loop: ${entry.tool} repeated ${entry.count}x after errors`,
        ),
        subject: signature,
        count: entry.count,
        firstAt: stampOf(Math.min(...times)),
        lastAt: stampOf(Math.max(...times)),
        sessions: [session.id],
        scopes: [],
      });
    }
  }

  /* Journal categories: the same normalized line in two distinct scopes. */
  const journalGroups = new Map<
    string,
    { kind: "repeat-question" | "run-failure"; text: string; count: number; first: number; last: number; scopes: Set<string> }
  >();
  for (const record of options.journal) {
    if (record.kind !== "question" && record.kind !== "acp-stderr") continue;
    const instant = inWindow(record.ts, start, end);
    if (instant === undefined) continue;
    const scope = record.scope ?? "";
    if (scope.length === 0) continue;
    const text =
      record.kind === "question"
        ? normalizeSessionLine(record.text, { repoDir: options.repoDir })
        : firstNormalizedLine(record.text, { repoDir: options.repoDir });
    if (text.length === 0) continue;
    const kind = record.kind === "question" ? "repeat-question" : "run-failure";
    const key = `${kind}\n${text}`;
    const entry = journalGroups.get(key) ?? {
      kind,
      text,
      count: 0,
      first: instant,
      last: instant,
      scopes: new Set<string>(),
    };
    entry.count += 1;
    if (instant < entry.first) entry.first = instant;
    if (instant > entry.last) entry.last = instant;
    entry.scopes.add(scope);
    journalGroups.set(key, entry);
  }
  for (const entry of journalGroups.values()) {
    if (entry.scopes.size < 2) continue;
    merge(groups, {
      category: entry.kind,
      signature: entry.text,
      line: boundLine(
        entry.kind === "repeat-question"
          ? `repeated question: ${entry.text}`
          : `run failed: ${entry.text}`,
      ),
      subject: entry.text,
      count: entry.count,
      firstAt: stampOf(entry.first),
      lastAt: stampOf(entry.last),
      sessions: [],
      scopes: [...entry.scopes],
    });
  }

  /* tool-gap: a non-trivial bash signature no MCP tool covers. */
  const covers = options.covers ?? [];
  for (const session of options.sessions) {
    for (const call of session.calls) {
      if (call.name !== "bash" || call.command === null) continue;
      const instant = inWindow(call.timestamp, start, end);
      if (instant === undefined) continue;
      const signature = normalizeCommandSignature(call.command, options.repoDir);
      if (signature.length < TOOL_GAP_MIN_LENGTH) continue;
      if (isTrivialCommand(signature)) continue;
      if (isCovered(signature, covers)) continue;
      merge(groups, {
        category: "tool-gap",
        signature,
        line: boundLine(`manual command repeated: ${signature}`),
        subject: signature,
        count: 1,
        firstAt: stampOf(instant),
        lastAt: stampOf(instant),
        sessions: [session.id],
        scopes: [],
      });
    }
  }

  const findings: CoachFinding[] = [];
  for (const group of groups.values()) {
    if (group.category === "tool-failure" && group.sessions.size < 2) continue;
    if (group.category === "tool-gap") {
      if (group.count < TOOL_GAP_CALLS || group.sessions.size < TOOL_GAP_SESSIONS) continue;
    }
    if (group.category === "repeat-question" || group.category === "run-failure") {
      if (group.scopes.size < 2) continue;
    }
    findings.push({
      category: group.category,
      fingerprint: evidenceFingerprint(group.category, group.signature),
      line: group.line,
      subject: group.subject,
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      count: group.count,
      sessions: [...group.sessions].sort(),
      scopes: [...group.scopes].sort(),
    });
  }
  return findings.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.line.localeCompare(right.line) ||
      left.fingerprint.localeCompare(right.fingerprint),
  );
}

import { resolve } from "node:path";
import type { AgentSession, SessionToolCall, SessionToolResult } from "../lib/agent-sessions";
import { normalizeSessionLine } from "../lib/agent-sessions";
import type { CoachJournalRecord } from "./collect";

/**
 * Deterministic family detection. Nothing here calls a model: one normalized
 * command (or one repeated journal line) is one family, recurrence is counted,
 * and the score orders the families a cycle sends to synthesis.
 *
 * The family key is the normalized command up to its first `--flag`, so
 * `bun run publish 2>&1 | tail -40`, `bun run publish | tail -60`, and
 * `( cd /checkout && bun run publish )` are one family. Two commands whose
 * tokens before the first flag differ never merge.
 */

/** Read-only inspection every agent performs; never a family. */
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

/**
 * The same allowlist in family-key space. A family key never carries a `--flag`,
 * so an entry that does (`bunx tsc --noEmit`) would otherwise be compared against
 * a key it can never equal, and the command it declares trivial would become a
 * family. Mapping every entry through `familyKey` once keeps the guard and the
 * key in one space, so a flag-bearing entry stays effective.
 */
const TRIVIAL_KEYS: readonly string[] = Object.freeze([
  ...new Set(TRIVIAL_COMMANDS.map((entry) => familyKey(entry))),
]);

/** True when a normalized signature or family key is plain inspection, not a capability gap. */
export function isTrivialCommand(signature: string): boolean {
  for (const prefix of TRIVIAL_KEYS) {
    if (signature === prefix || signature.startsWith(`${prefix} `)) return true;
  }
  return false;
}

/** The fixed evidence window: the 24 hours ending at cycle start. */
export const EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One cycle synthesizes at most this many families. */
export const MAX_SELECTED_FAMILIES = 20;
/** One family's evidence bundle quotes at most this many excerpts. */
export const FAMILY_EXCERPT_LIMIT = 5;
export const EXCERPT_COMMAND_MAX = 300;
export const EXCERPT_OUTPUT_MAX = 2_000;
export const EXCERPT_OUTPUT_LINES = 10;
/** A retry loop adds this much weight to its command family. */
export const RETRY_WEIGHT = 1;

export type FamilyKind = "command" | "question" | "run-failure";

export interface FamilyFragment {
  text: string;
  count: number;
}

export interface FamilyExcerpt {
  /** The command (or journal text), bounded to 300 characters. */
  command: string;
  /** `error`, `ok`, or `n/a` for a journal record. */
  status: string;
  /** At most 10 lines and 2,000 characters. */
  output: string;
  sessionTitle: string;
}

export interface CoachFamily {
  key: string;
  kind: FamilyKind;
  calls: number;
  /** Contributing session ids (journal scopes for a journal family), sorted. */
  sessions: string[];
  /** Distinct UTC days the evidence falls on. */
  days: number;
  firstAt: string;
  lastAt: string;
  /** `sessions * days * calls`, computed after normalization. */
  score: number;
  fragments: FamilyFragment[];
  excerpts: FamilyExcerpt[];
}

export interface FamilyWindow {
  start: string;
  end: string;
}

export interface BuildFamiliesOptions {
  sessions: AgentSession[];
  journal: CoachJournalRecord[];
  window: FamilyWindow;
  repoDir: string;
}

export interface FamilySelection {
  /** Every family, sorted by key. */
  families: CoachFamily[];
  /** The selection, highest score first, ties by key ascending. */
  selected: CoachFamily[];
  omitted: number;
}

/** Tools whose failed call is evidence for their family; read-only ones are not. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "multiedit",
  "write",
  "apply_patch",
  "patch",
  "ast_edit",
]);

function fixtureCommand(command: string): boolean {
  const value = command.trim();
  if (value === "true" || value === "i: noop") return true;
  return /^echo(?:\s|$)/.test(value);
}

function excludedPath(value: string): boolean {
  return value.includes(".worktree/") || value.includes(".devboard/.tmp/");
}

function coachOwned(value: string): boolean {
  return value.includes(".devboard/coach") || value.includes("verify:coach");
}

function excludedSession(session: AgentSession): boolean {
  const paths = [session.relativeCwd, session.relativePath];
  return paths.some((value) => excludedPath(value) || coachOwned(value));
}

/** Removes the repository root so a command that names it is judged relatively. */
function repoRelative(value: string, repoDir: string): string {
  const root = resolve(repoDir).replace(/\/+$/, "");
  return root.length === 0 ? value : value.split(root).join("");
}

/** Splits on `&&`, `||`, and `;` outside quotes. */
function splitSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (
      (character === "&" && value[index + 1] === "&") ||
      (character === "|" && value[index + 1] === "|")
    ) {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (character === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Cuts a segment at its first pipe, leaving `||` alone. */
function stripPipes(value: string): string {
  let result = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== null) {
      result += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "|") {
      if (value[index + 1] === "|") {
        result += character;
        continue;
      }
      break;
    }
    result += character;
  }
  return result;
}

/** Removes `2>&1`, `> path`, `2> path`, `>> path`, and `< path`. */
function stripRedirections(value: string): string {
  return value
    .replace(/\s+\d?>>?\s*(?:"[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/\s*(?:\d?>&\d|&>\d?)\s*/g, " ")
    .replace(/\s+<\s*(?:"[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapParenthesized(value: string): string {
  const match = /^\(\s*([\s\S]*)\)$/.exec(value);
  return match?.[1] === undefined ? value : match[1].trim();
}

/** The volatile-token replacements shared with the old detector. */
function replaceVolatile(value: string, repoDir: string): string {
  let result = value.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/,
    "<env> ",
  );
  const root = resolve(repoDir).replace(/\/+$/, "");
  if (root.length > 0) result = result.split(root).join("<repo>");
  result = result
    .replace(/\.worktree\/[^\s/]+/g, ".worktree/<worktree>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<timestamp>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  result = result.replace(/^<env> /, "");
  // `git -C <dir> status` is this checkout's `git status`.
  result = result.replace(/^(?:git -C (?:"[^"]*"|'[^']*'|\S+) )/, "git ");
  return result.trim();
}

/** The family key: the remaining tokens up to the first `--flag`. */
export function familyKey(normalized: string): string {
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const flag = tokens.findIndex((token) => token.startsWith("--"));
  return (flag < 0 ? tokens : tokens.slice(0, flag)).join(" ");
}

/**
 * One bash command to its normalized family key. Pipes are output handling,
 * redirections are noise, and the directory change is not the command.
 */
export function normalizeCommandSignature(command: string, repoDir: string): string {
  const segments = splitSegments(unwrapParenthesized(command.trim()));
  const commands = segments
    .map((segment) => replaceVolatile(stripRedirections(stripPipes(segment)), repoDir))
    .filter((segment) => segment.length > 0 && !/^cd(?:\s|$)/.test(segment));
  // Triviality is judged on the same normalized text the key is cut from, so an
  // env-prefixed or repo-rooted `bunx tsc --noEmit` is recognized as inspection.
  const chosen = commands.find((segment) => !isTrivialCommand(segment)) ?? commands[0] ?? "";
  return familyKey(chosen);
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function excerptOf(
  command: string,
  status: string,
  output: string,
  sessionTitle: string,
): FamilyExcerpt {
  const lines = output.split("\n").slice(0, EXCERPT_OUTPUT_LINES).map((line) => line.trimEnd());
  return {
    command: bound(command.replace(/\s+/g, " ").trim(), EXCERPT_COMMAND_MAX),
    status,
    output: bound(lines.join("\n"), EXCERPT_OUTPUT_MAX),
    sessionTitle: bound(sessionTitle.replace(/\s+/g, " ").trim(), 120),
  };
}

interface Occurrence {
  key: string;
  kind: FamilyKind;
  at: number;
  session: string;
  fragment: string;
  excerpt: FamilyExcerpt;
  excerptRank: number;
  weight: number;
}

function instantOf(value: string | null | undefined, fallback: string): number {
  const parsed = Date.parse(value ?? "");
  if (Number.isFinite(parsed)) return parsed;
  const start = Date.parse(fallback);
  return Number.isFinite(start) ? start : 0;
}

function dayOf(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

function stampsOf(instant: number): string {
  return new Date(instant).toISOString();
}

function resultFor(
  session: AgentSession,
  call: SessionToolCall,
): SessionToolResult | undefined {
  return session.results.find(
    (result) =>
      result.toolCallId !== null && call.id !== null && result.toolCallId === call.id,
  );
}

/** One call's identity: its tool name plus the exact arguments it carried. */
function callIdentity(call: SessionToolCall): string {
  return `${call.name}\n${call.argumentsText}`;
}

/** Retry weight: one identity repeated at least three times after errors. */
function retryWeights(
  session: AgentSession,
  start: number,
  end: number,
): Map<string, { count: number; at: number }> {
  const callsById = new Map<string, SessionToolCall>();
  const callsByIndex = new Map<number, SessionToolCall>();
  for (const call of session.calls) {
    if (call.id !== null) callsById.set(call.id, call);
    callsByIndex.set(call.index, call);
  }
  const events: Array<{ index: number; error: boolean; identity: string }> = [];
  for (const call of session.calls) {
    events.push({ index: call.index, error: false, identity: callIdentity(call) });
  }
  for (const result of session.results) {
    if (!result.isError) continue;
    // A failure belongs to the call that reported it, so it carries the same
    // identity as that call. A result with no matching call keeps the tool
    // name alone. Keying failures by the bare tool name marked every later
    // call of the tool as after-error.
    const origin = result.toolCallId === null ? undefined : callsById.get(result.toolCallId);
    events.push({
      index: result.index,
      error: true,
      identity: origin === undefined ? result.toolName : callIdentity(origin),
    });
  }
  events.sort((left, right) => left.index - right.index);
  const errored = new Set<string>();
  const totals = new Map<string, { count: number; afterError: number; times: number[] }>();
  for (const event of events) {
    if (event.error) {
      errored.add(event.identity);
      continue;
    }
    const entry = totals.get(event.identity) ?? { count: 0, afterError: 0, times: [] };
    entry.count += 1;
    if (errored.has(event.identity)) entry.afterError += 1;
    const call = callsByIndex.get(event.index);
    const instant = instantOf(call?.timestamp, session.startedAt);
    if (instant >= start && instant <= end) entry.times.push(instant);
    // A success ends this identity's error streak: the retry worked, so later
    // calls of it are not retries of the earlier failure.
    const outcome = call === undefined ? undefined : resultFor(session, call);
    if (outcome !== undefined && !outcome.isError) errored.delete(event.identity);
    totals.set(event.identity, entry);
  }
  const weights = new Map<string, { count: number; at: number }>();
  for (const [identity, entry] of totals) {
    if (entry.count < 3 || entry.afterError < 2 || entry.times.length === 0) continue;
    weights.set(identity, { count: entry.count, at: Math.min(...entry.times) });
  }
  return weights;
}

function occurrences(options: BuildFamiliesOptions): Occurrence[] {
  const start = Date.parse(options.window.start);
  const end = Date.parse(options.window.end);
  const repoDir = options.repoDir;
  const found: Occurrence[] = [];
  for (const session of options.sessions) {
    if (excludedSession(session)) continue;
    for (const call of session.calls) {
      const at = instantOf(call.timestamp, session.startedAt);
      if (!Number.isFinite(at) || at < start || at > end) continue;
      const result = resultFor(session, call);
      if (call.name === "bash" && call.command !== null) {
        const command = call.command;
        const relative = repoRelative(command, repoDir);
        if (
          excludedPath(relative) ||
          coachOwned(relative) ||
          fixtureCommand(command) ||
          excludedPath(session.relativeCwd)
        ) {
          continue;
        }
        const key = normalizeCommandSignature(command, repoDir);
        if (key.length === 0 || isTrivialCommand(key)) continue;
        const isError = result?.isError === true;
        found.push({
          key,
          kind: "command",
          at,
          session: session.id,
          fragment: command,
          excerpt: excerptOf(
            command,
            isError ? "error" : "ok",
            result?.text ?? "",
            session.title,
          ),
          excerptRank: isError ? 0 : 1,
          weight: 1,
        });
        continue;
      }
      if (MUTATING_TOOLS.has(call.name) && result?.isError === true) {
        const argumentsText = normalizeSessionLine(call.argumentsText, { repoDir });
        found.push({
          key: call.name,
          kind: "command",
          at,
          session: session.id,
          fragment: argumentsText,
          excerpt: excerptOf(
            `${call.name} ${argumentsText}`,
            "error",
            result.text,
            session.title,
          ),
          excerptRank: 0,
          weight: 1,
        });
      }
    }
    for (const [identity, retry] of retryWeights(session, start, end)) {
      const [name, argumentsText] = identity.split("\n");
      if (name !== "bash") continue;
      const parsed = (() => {
        try {
          const value: unknown = JSON.parse(argumentsText ?? "");
          return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      })();
      const command = typeof parsed?.["command"] === "string" ? parsed["command"] : undefined;
      if (command === undefined) continue;
      const relative = repoRelative(command, repoDir);
      if (excludedPath(relative) || coachOwned(relative) || fixtureCommand(command)) continue;
      const key = normalizeCommandSignature(command, repoDir);
      if (key.length === 0 || isTrivialCommand(key)) continue;
      found.push({
        key,
        kind: "command",
        at: retry.at,
        session: session.id,
        fragment: `retry ×${retry.count}`,
        excerpt: excerptOf(command, "error", "", session.title),
        excerptRank: 0,
        weight: RETRY_WEIGHT,
      });
    }
  }
  return found;
}

function journalFamilies(
  journal: CoachJournalRecord[],
  window: FamilyWindow,
  repoDir: string,
): Occurrence[] {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const groups = new Map<
    string,
    {
      key: string;
      kind: FamilyKind;
      text: string;
      scopes: Set<string>;
      times: number[];
      records: Array<{ at: number; scope: string; text: string }>;
    }
  >();
  for (const record of journal) {
    if (record.kind !== "question" && record.kind !== "acp-stderr") continue;
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const scope = record.scope ?? "";
    if (scope.length === 0) continue;
    if (coachOwned(scope) || excludedPath(scope)) continue;
    const text =
      record.kind === "question"
        ? normalizeSessionLine(record.text, { repoDir })
        : normalizeSessionLine(
            record.text
              .split("\n")
              .map((line) => line.trim())
              .find((line) => line.length > 0) ?? "",
            { repoDir },
          );
    if (text.length === 0) continue;
    const kind: FamilyKind = record.kind === "question" ? "question" : "run-failure";
    const key = bound(`${kind}: ${text}`, EXCERPT_COMMAND_MAX);
    const entry = groups.get(key) ?? {
      key,
      kind,
      text,
      scopes: new Set<string>(),
      times: [],
      records: [],
    };
    entry.scopes.add(scope);
    entry.times.push(at);
    entry.records.push({ at, scope, text });
    groups.set(key, entry);
  }
  const found: Occurrence[] = [];
  for (const entry of groups.values()) {
    if (entry.scopes.size < 2) continue;
    for (const record of entry.records) {
      found.push({
        key: entry.key,
        kind: entry.kind,
        at: record.at,
        session: record.scope,
        fragment: entry.text,
        excerpt: excerptOf(entry.text, "n/a", record.text, `scope ${record.scope}`),
        excerptRank: 0,
        weight: 1,
      });
    }
  }
  return found;
}

interface Builder {
  key: string;
  kind: FamilyKind;
  calls: number;
  sessions: Set<string>;
  days: Set<string>;
  first: number;
  last: number;
  fragments: Map<string, number>;
  excerpts: Array<{ rank: number; at: number; excerpt: FamilyExcerpt }>;
}

function scoreOf(builder: Builder): number {
  return builder.sessions.size * builder.days.size * builder.calls;
}

function toFamily(builder: Builder): CoachFamily {
  const fragments = [...builder.fragments.entries()]
    .map(([text, count]) => ({
      text: bound(text.replace(/\s+/g, " ").trim(), EXCERPT_COMMAND_MAX),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text));
  const excerpts = builder.excerpts
    .slice()
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.at - right.at ||
        left.excerpt.command.localeCompare(right.excerpt.command),
    )
    .slice(0, FAMILY_EXCERPT_LIMIT)
    .map((entry) => entry.excerpt);
  return {
    key: builder.key,
    kind: builder.kind,
    calls: builder.calls,
    sessions: [...builder.sessions].sort(),
    days: builder.days.size,
    firstAt: stampsOf(builder.first),
    lastAt: stampsOf(builder.last),
    score: scoreOf(builder),
    fragments,
    excerpts,
  };
}

/**
 * Groups the window's evidence into families, scores them, and selects the
 * highest-scoring at most 20. Ties break by key ascending; identical evidence
 * and clock produce identical families in identical order.
 */
export function buildFamilies(options: BuildFamiliesOptions): FamilySelection {
  const builders = new Map<string, Builder>();
  for (const occurrence of [...occurrences(options), ...journalFamilies(options.journal, options.window, options.repoDir)]) {
    const builder = builders.get(occurrence.key) ?? {
      key: occurrence.key,
      kind: occurrence.kind,
      calls: 0,
      sessions: new Set<string>(),
      days: new Set<string>(),
      first: occurrence.at,
      last: occurrence.at,
      fragments: new Map<string, number>(),
      excerpts: [],
    };
    builder.calls += occurrence.weight;
    builder.sessions.add(occurrence.session);
    builder.days.add(dayOf(occurrence.at));
    if (occurrence.at < builder.first) builder.first = occurrence.at;
    if (occurrence.at > builder.last) builder.last = occurrence.at;
    builder.fragments.set(
      occurrence.fragment,
      (builder.fragments.get(occurrence.fragment) ?? 0) + 1,
    );
    builder.excerpts.push({
      rank: occurrence.excerptRank,
      at: occurrence.at,
      excerpt: occurrence.excerpt,
    });
    builders.set(occurrence.key, builder);
  }
  const families = [...builders.values()]
    .map(toFamily)
    .sort((left, right) => left.key.localeCompare(right.key));
  const selected = families
    .slice()
    .sort(
      (left, right) =>
        right.score - left.score || left.key.localeCompare(right.key),
    )
    .slice(0, MAX_SELECTED_FAMILIES);
  return {
    families,
    selected,
    omitted: Math.max(0, families.length - selected.length),
  };
}

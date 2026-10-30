import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isRecord } from "../issues/guards";

/**
 * One reader for the ACP peer transcripts the dashboard's generated agent
 * directories hold. Coach and the Devboard MCP server both read sessions
 * through this module: the record shapes, the token and cost summation, and
 * the tool-error fingerprint are defined once here.
 *
 * A transcript is JSONL. The records this module understands are `session`
 * (id, start time, cwd), `title`, and `message` (user, assistant, toolResult).
 * Anything else is skipped; a malformed line is counted, never guessed.
 */

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface SessionMessage {
  /** Position in the transcript's emitted message order. */
  index: number;
  timestamp: string | null;
  role: string;
  text: string;
  toolName: string | null;
  toolCallId: string | null;
  isError: boolean;
  usage: SessionUsage | null;
  /** The normalized fingerprint of one failed tool result, or null. */
  errorFingerprint: string | null;
}

export interface SessionToolCall {
  id: string | null;
  name: string;
  /** JSON-serialized arguments, normalized for identity comparison. */
  argumentsText: string;
  /** The raw `command` argument when this is a bash call. */
  command: string | null;
  index: number;
  timestamp: string | null;
}

export interface SessionToolResult {
  toolCallId: string | null;
  toolName: string;
  text: string;
  isError: boolean;
  index: number;
  timestamp: string | null;
}

export interface AgentSession {
  id: string;
  /** Absolute transcript path. */
  path: string;
  /** Path relative to the state directory, `/`-separated. */
  relativePath: string;
  startedAt: string;
  title: string;
  /** The session's recorded absolute working directory. */
  cwd: string;
  /** The working directory relative to the repository, `/`-separated. */
  relativeCwd: string;
  messages: SessionMessage[];
  calls: SessionToolCall[];
  results: SessionToolResult[];
  usage: SessionUsage;
  cost: number;
  messageCount: number;
  toolErrorCount: number;
  malformed: number;
}

export interface SessionSummary {
  id: string;
  relativePath: string;
  startedAt: string;
  title: string;
  relativeCwd: string;
  messageCount: number;
  toolErrorCount: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface SessionSelection {
  sessions: AgentSession[];
  /** Selected transcript files before the newest-file cap. */
  selected: number;
  /** Selected transcript files left out by the newest-file cap. */
  omitted: number;
  truncated: boolean;
  /** Files with no usable session record, timestamp, cwd, or id. */
  skipped: number;
  /** Malformed JSONL lines across every file read. */
  malformed: number;
}

export const SESSION_LIST_DEFAULT_LIMIT = 50;
export const SESSION_LIST_MAX_LIMIT = 200;
export const SESSION_READ_DEFAULT_LIMIT = 50;
export const SESSION_READ_MAX_LIMIT = 200;
export const SESSION_RESPONSE_MAX_BYTES = 64 * 1024;
export const SESSION_SEARCH_MAX_MATCHES = 100;
export const SESSION_SEARCH_SNIPPET_MAX = 200;
export const SESSION_MESSAGE_TEXT_MAX = 4_000;
/** The newest selected transcript files one cycle may read. */
export const SESSION_MAX_FILES = 1_000;

const EMPTY_USAGE: SessionUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The parsed instant, or undefined when the timestamp is unusable. */
export function parseSessionInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `sha256(category + "\n" + signature)`, first 16 hex characters. */
export function evidenceFingerprint(category: string, signature: string): string {
  return createHash("sha256")
    .update(`${category}\n${signature}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * `tool-failure` identity: the tool name and the normalized first non-empty
 * line of its result text. Coach and the MCP tools report the same value.
 */
export function toolFailureFingerprint(toolName: string, text: string): string {
  return evidenceFingerprint(
    "tool-failure",
    `${toolName}\n${normalizeSessionLine(text)}`,
  );
}

export interface NormalizeOptions {
  /** The repository root replaced with `<repo>`. */
  repoDir?: string;
}

/** Collapses whitespace and replaces volatile tokens; deterministic. */
export function normalizeSessionLine(text: string, options: NormalizeOptions = {}): string {
  let value = text.replace(/\s+/g, " ").trim();
  if (options.repoDir !== undefined && options.repoDir.length > 0) {
    value = value.split(resolve(options.repoDir)).join("<repo>");
  }
  value = value
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<timestamp>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

/** The first non-empty line of a text, normalized and bounded. */
export function firstNormalizedLine(text: string, options: NormalizeOptions = {}): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return "";
  return normalizeSessionLine(line.slice(0, 400), options);
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

interface ParsedUsage {
  usage: SessionUsage;
  cost: number;
}

function parseUsage(value: unknown): ParsedUsage {
  if (!isRecord(value)) return { usage: { ...EMPTY_USAGE }, cost: 0 };
  const costRecord = isRecord(value.cost) ? value.cost : {};
  const input = number(value.input);
  const output = number(value.output);
  const cacheRead = number(value.cacheRead);
  const cacheWrite = number(value.cacheWrite);
  const totalTokens =
    number(value.totalTokens) > 0 ? number(value.totalTokens) : input + output + cacheRead + cacheWrite;
  const cost =
    number(costRecord.total) > 0
      ? number(costRecord.total)
      : number(costRecord.input) + number(costRecord.output) + number(costRecord.cacheRead) + number(costRecord.cacheWrite);
  return {
    usage: { input, output, cacheRead, cacheWrite, totalTokens, cost },
    cost,
  };
}

function addUsage(target: SessionUsage, source: SessionUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
}

function firstUserLine(records: unknown[]): string {
  for (const value of records) {
    if (!isRecord(value) || value.type !== "message") continue;
    const message = isRecord(value.message) ? value.message : undefined;
    if (message?.role !== "user") continue;
    const text = textParts(message.content)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (text !== undefined) return text.slice(0, 120);
  }
  return "";
}

export interface ParsedTranscript {
  session: AgentSession | undefined;
  malformed: number;
}

/**
 * Parses one transcript. The result carries the parsed session when a usable
 * `session` record exists; malformed lines are counted even then.
 */
export function parseSessionTranscript(
  text: string,
  path: string,
  options: { stateDir: string; repoDir: string },
): ParsedTranscript {
  const lines = text.split("\n");
  const records: unknown[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("not an object");
      records.push(parsed);
    } catch {
      malformed += 1;
    }
  }

  let sessionId: string | undefined;
  let sessionStarted: string | undefined;
  let sessionCwd: string | undefined;
  let title = "";
  for (const record of records) {
    if (!isRecord(record)) continue;
    if (record.type === "session" && sessionId === undefined) {
      if (typeof record.id === "string" && record.id.length > 0) sessionId = record.id;
      if (typeof record.cwd === "string" && record.cwd.length > 0) sessionCwd = record.cwd;
      if (parseSessionInstant(record.timestamp) !== undefined) {
        sessionStarted = new Date(parseSessionInstant(record.timestamp)!).toISOString();
      }
      continue;
    }
    if (record.type === "title" && typeof record.title === "string" && record.title.trim().length > 0) {
      title = record.title.trim().slice(0, 200);
    }
  }

  if (sessionId === undefined || sessionStarted === undefined || sessionCwd === undefined) {
    return { session: undefined, malformed };
  }

  const messages: SessionMessage[] = [];
  const calls: SessionToolCall[] = [];
  const results: SessionToolResult[] = [];
  const usage = { ...EMPTY_USAGE };
  let cost = 0;
  let index = 0;

  const absoluteCwd = resolve(sessionCwd);
  const absoluteRepo = resolve(options.repoDir);
  const relativeCwd = (() => {
    const local = relative(absoluteRepo, absoluteCwd);
    if (local.length === 0) return ".";
    return local.startsWith("..") ? absoluteCwd : local.split(sep).join("/");
  })();

  for (const record of records) {
    if (!isRecord(record) || record.type !== "message") continue;
    const message = isRecord(record.message) ? record.message : undefined;
    if (message === undefined) continue;
    const role = typeof message.role === "string" ? message.role : "other";
    const timestamp =
      typeof record.timestamp === "string" &&
      Number.isFinite(Date.parse(record.timestamp))
        ? new Date(Date.parse(record.timestamp)).toISOString()
        : null;
    const content = message.content;
    const parts = Array.isArray(content) ? content : [];

    if (role === "assistant") {
      const parsedUsage = parseUsage(message.usage);
      addUsage(usage, parsedUsage.usage);
      cost += parsedUsage.cost;
    }

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      const resultText = textParts(content).slice(0, SESSION_MESSAGE_TEXT_MAX * 4);
      const isError = message.isError === true;
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
      results.push({ toolCallId, toolName, text: resultText, isError, index, timestamp });
      messages.push({
        index,
        timestamp,
        role,
        text: resultText,
        toolName,
        toolCallId,
        isError,
        usage: null,
        errorFingerprint: isError ? toolFailureFingerprint(toolName, resultText) : null,
      });
      index += 1;
      continue;
    }

    const text = textParts(content);
    const normalizedText = text.slice(0, SESSION_MESSAGE_TEXT_MAX);
    let emitted = false;
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      const name = typeof part.name === "string" ? part.name : "unknown";
      const id = typeof part.id === "string" ? part.id : null;
      const argumentRecord = isRecord(part.arguments) ? part.arguments : {};
      const argumentsText = normalizeSessionLine(JSON.stringify(argumentRecord), {
        repoDir: absoluteRepo,
      });
      const command = typeof argumentRecord.command === "string" ? argumentRecord.command : null;
      calls.push({
        id,
        name,
        argumentsText,
        command,
        index,
        timestamp,
      });
      messages.push({
        index,
        timestamp,
        role,
        text: normalizedText,
        toolName: name,
        toolCallId: id,
        isError: false,
        usage: role === "assistant" ? parseUsage(message.usage).usage : null,
        errorFingerprint: null,
      });
      index += 1;
      emitted = true;
    }
    if (!emitted && (text.length > 0 || role !== "assistant")) {
      messages.push({
        index,
        timestamp,
        role,
        text: normalizedText,
        toolName: null,
        toolCallId: null,
        isError: false,
        usage: role === "assistant" ? parseUsage(message.usage).usage : null,
        errorFingerprint: null,
      });
      index += 1;
    }
  }

  const relativePath = relative(resolve(options.stateDir), resolve(path)).split(sep).join("/");
  const toolErrorCount = results.filter((result) => result.isError).length;
  return {
    session: {
      id: sessionId,
      path: resolve(path),
      relativePath,
      startedAt: sessionStarted,
      title: title.length > 0 ? title : firstUserLine(records),
      cwd: absoluteCwd,
      relativeCwd,
      messages,
      calls,
      results,
      usage,
      cost,
      messageCount: messages.length,
      toolErrorCount,
      malformed,
    },
    malformed,
  };
}

/** One transcript file with the metadata a selection needs before parsing. */
export interface SessionFileMeta {
  path: string;
  size: number;
  mtimeMs: number;
}

/** The `session` record a transcript carries as its header. */
export interface SessionHeader {
  id: string;
  cwd: string;
  startedAt: string;
}

/**
 * The file seam the reader goes through. Tests replace it to observe how many
 * transcripts are stat-ed, header-scanned, and fully parsed; the default reads
 * the state directory.
 */
export interface SessionReader {
  /** Every `.jsonl` transcript under the providers agent tree, with metadata. */
  list(stateDir: string): SessionFileMeta[];
  /** The header record only, without reading the transcript body. */
  readHeader(meta: SessionFileMeta): SessionHeader | undefined;
  /** The whole transcript, or undefined when it cannot be read. */
  readText(meta: SessionFileMeta): string | undefined;
}

/** How much of a transcript the header scan reads before giving up. */
const HEADER_SCAN_BYTES = 64 * 1024;
const headerScanBuffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);

function parseSessionHeaderText(text: string): SessionHeader | undefined {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "session") continue;
    if (typeof record.id !== "string" || record.id.length === 0) return undefined;
    if (typeof record.cwd !== "string" || record.cwd.length === 0) return undefined;
    if (parseSessionInstant(record.timestamp) === undefined) return undefined;
    return {
      id: record.id,
      cwd: record.cwd,
      startedAt: new Date(parseSessionInstant(record.timestamp)!).toISOString(),
    };
  }
  return undefined;
}

export const defaultSessionReader: SessionReader = {
  list(stateDir) {
    const files: SessionFileMeta[] = [];
    for (const path of listSessionPaths(stateDir)) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  },
  readHeader(meta) {
    let descriptor: number;
    try {
      descriptor = openSync(meta.path, "r");
    } catch {
      return undefined;
    }
    try {
      const read = readSync(descriptor, headerScanBuffer, 0, HEADER_SCAN_BYTES, 0);
      return parseSessionHeaderText(headerScanBuffer.toString("utf8", 0, read));
    } catch {
      return undefined;
    } finally {
      closeSync(descriptor);
    }
  },
  readText(meta) {
    try {
      return readFileSync(meta.path, "utf8");
    } catch {
      return undefined;
    }
  },
};

interface CachedHeader {
  size: number;
  mtimeMs: number;
  header: SessionHeader | undefined;
}

interface CachedTranscript {
  size: number;
  mtimeMs: number;
  parsed: ParsedTranscript;
}

/** Header cache: bounded, keyed by path and invalidated by size plus mtime. */
const HEADER_CACHE_MAX = 4_096;
const headerCache = new Map<string, CachedHeader>();
/** Fully parsed transcripts: bounded, keyed by path and state/repo resolution. */
const TRANSCRIPT_CACHE_MAX = 64;
const transcriptCache = new Map<string, CachedTranscript>();

function headerFor(meta: SessionFileMeta, reader: SessionReader): SessionHeader | undefined {
  const cached = headerCache.get(meta.path);
  if (cached !== undefined && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs) {
    headerCache.delete(meta.path);
    headerCache.set(meta.path, cached);
    return cached.header;
  }
  const header = reader.readHeader(meta);
  headerCache.delete(meta.path);
  headerCache.set(meta.path, { size: meta.size, mtimeMs: meta.mtimeMs, header });
  if (headerCache.size > HEADER_CACHE_MAX) {
    const oldest = headerCache.keys().next();
    if (oldest.done !== true) headerCache.delete(oldest.value);
  }
  return header;
}

function readTranscript(
  meta: SessionFileMeta,
  options: { stateDir: string; repoDir: string },
  reader: SessionReader,
): ParsedTranscript {
  const key = `${meta.path}\0${options.stateDir}\0${options.repoDir}`;
  const cached = transcriptCache.get(key);
  if (cached !== undefined && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs) {
    transcriptCache.delete(key);
    transcriptCache.set(key, cached);
    return cached.parsed;
  }
  const text = reader.readText(meta);
  const parsed: ParsedTranscript =
    text === undefined
      ? { session: undefined, malformed: 0 }
      : parseSessionTranscript(text, meta.path, options);
  transcriptCache.delete(key);
  transcriptCache.set(key, { size: meta.size, mtimeMs: meta.mtimeMs, parsed });
  if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next();
    if (oldest.done !== true) transcriptCache.delete(oldest.value);
  }
  return parsed;
}

/** Every `.jsonl` transcript under the providers agent sessions tree. */
export function listSessionFiles(
  stateDir: string,
  reader: SessionReader = defaultSessionReader,
): string[] {
  return reader.list(stateDir).map((meta) => meta.path);
}

function listSessionPaths(stateDir: string): string[] {
  const root = join(resolve(stateDir), "providers", "agents");
  const files: string[] = [];
  let agents: string[];
  try {
    agents = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return files;
  }
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(child);
      }
    }
  };
  for (const agent of agents) walk(join(root, agent, "sessions"));
  return files.sort();
}

/** True when the cwd is the repository root or inside its `.worktree/`. */
export function isRepositoryWorkingDirectory(repoDir: string, cwd: string): boolean {
  const root = resolve(repoDir);
  const target = resolve(cwd);
  if (target === root) return true;
  return target.startsWith(join(root, ".worktree") + sep);
}

export interface SelectSessionsOptions {
  stateDir: string;
  repoDir: string;
  /** Newest files kept; 1,000 by default. */
  maxFiles?: number;
  /** Skip transcripts last written before this epoch instant. */
  mtimeSince?: number;
  /** Test seam; the default reads the state directory. */
  reader?: SessionReader;
}

/**
 * Every transcript whose session cwd is this repository (or a worktree under
 * it), newest 1,000 selected files, deduplicated by session id. Selection reads
 * file metadata and headers only; at most `maxFiles` transcripts are parsed.
 */
export function selectSessions(options: SelectSessionsOptions): SessionSelection {
  const stateDir = resolve(options.stateDir);
  const repoDir = resolve(options.repoDir);
  const maxFiles = Math.max(1, options.maxFiles ?? SESSION_MAX_FILES);
  const reader = options.reader ?? defaultSessionReader;
  const since = options.mtimeSince;
  const entries = reader
    .list(stateDir)
    .filter((meta) => since === undefined || meta.mtimeMs >= since);
  let skipped = 0;
  // One session id is one transcript: a resumed session copies its header.
  const byId = new Map<string, { meta: SessionFileMeta; header: SessionHeader }>();
  for (const meta of entries) {
    const header = headerFor(meta, reader);
    if (header === undefined) {
      skipped += 1;
      continue;
    }
    if (!isRepositoryWorkingDirectory(repoDir, header.cwd)) continue;
    const existing = byId.get(header.id);
    if (
      existing === undefined ||
      header.startedAt > existing.header.startedAt ||
      (header.startedAt === existing.header.startedAt && meta.path > existing.meta.path)
    ) {
      byId.set(header.id, { meta, header });
    }
  }
  const ordered = [...byId.values()].sort(
    (left, right) =>
      right.header.startedAt.localeCompare(left.header.startedAt) ||
      left.meta.path.localeCompare(right.meta.path),
  );
  const kept = ordered.slice(0, maxFiles);
  const sessions: AgentSession[] = [];
  let malformed = 0;
  for (const entry of kept) {
    const parsed = readTranscript(entry.meta, { stateDir, repoDir }, reader);
    malformed += parsed.malformed;
    if (parsed.session === undefined) {
      skipped += 1;
      continue;
    }
    sessions.push(parsed.session);
  }
  return {
    sessions: sessions.sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.path.localeCompare(right.path),
    ),
    selected: ordered.length,
    omitted: ordered.length - kept.length,
    truncated: ordered.length > kept.length,
    skipped,
    malformed,
  };
}

export interface ListSessionsOptions extends SelectSessionsOptions {
  since?: string | undefined;
  until?: string | undefined;
  cwd?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SessionListPage {
  sessions: SessionSummary[];
  total: number;
  truncated: boolean;
  nextOffset: number | null;
}

function summary(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    relativePath: session.relativePath,
    startedAt: session.startedAt,
    title: session.title,
    relativeCwd: session.relativeCwd,
    messageCount: session.messageCount,
    toolErrorCount: session.toolErrorCount,
    tokens: {
      input: session.usage.input,
      output: session.usage.output,
      cacheRead: session.usage.cacheRead,
      cacheWrite: session.usage.cacheWrite,
      total: session.usage.totalTokens,
    },
    cost: session.cost,
  };
}

/**
 * The MCP listing: newest first, bounded. `since` and `until` bound the session
 * start; `cwd` matches the recorded working directory after resolution.
 */
export function listSessions(options: ListSessionsOptions): SessionListPage {
  const limit = Math.min(
    SESSION_LIST_MAX_LIMIT,
    Math.max(1, options.limit ?? SESSION_LIST_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, options.offset ?? 0);
  const since = options.since === undefined ? undefined : parseSessionInstant(options.since);
  const until = options.until === undefined ? undefined : parseSessionInstant(options.until);
  const cwd =
    typeof options.cwd === "string" && options.cwd.length > 0
      ? resolve(options.repoDir, options.cwd)
      : undefined;
  const selection = selectSessions(options);
  const rows = selection.sessions
    .filter((session) => {
      const started = parseSessionInstant(session.startedAt);
      if (started === undefined) return false;
      if (since !== undefined && started < since) return false;
      if (until !== undefined && started > until) return false;
      if (cwd !== undefined && resolve(session.cwd) !== cwd) return false;
      return true;
    })
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || left.path.localeCompare(right.path),
    )
    .map(summary);
  const page = rows.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    sessions: page,
    total: rows.length,
    truncated: next < rows.length,
    nextOffset: next < rows.length ? next : null,
  };
}

export interface ReadSessionPage {
  id: string;
  messages: SessionMessage[];
  total: number;
  truncated: boolean;
  nextOffset: number | null;
  malformed: number;
}

/** One session's messages in index order, bounded by rows and bytes. */
export function readSessionMessages(options: {
  stateDir: string;
  repoDir: string;
  id: string;
  offset?: number;
  limit?: number;
  reader?: SessionReader;
}): ReadSessionPage | undefined {
  const stateDir = resolve(options.stateDir);
  const repoDir = resolve(options.repoDir);
  const reader = options.reader ?? defaultSessionReader;
  let match: { meta: SessionFileMeta; header: SessionHeader } | undefined;
  for (const meta of reader.list(stateDir)) {
    const header = headerFor(meta, reader);
    if (header === undefined || header.id !== options.id) continue;
    if (!isRepositoryWorkingDirectory(repoDir, header.cwd)) continue;
    if (
      match === undefined ||
      header.startedAt > match.header.startedAt ||
      (header.startedAt === match.header.startedAt && meta.path > match.meta.path)
    ) {
      match = { meta, header };
    }
  }
  if (match === undefined) return undefined;
  const session = readTranscript(match.meta, { stateDir, repoDir }, reader).session;
  if (session === undefined) return undefined;
  const limit = Math.min(
    SESSION_READ_MAX_LIMIT,
    Math.max(1, options.limit ?? SESSION_READ_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, options.offset ?? 0);
  const messages: SessionMessage[] = [];
  let bytes = 0;
  let cursor = offset;
  for (; cursor < session.messages.length && messages.length < limit; cursor += 1) {
    const message = session.messages[cursor];
    if (message === undefined) continue;
    const cost = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (messages.length > 0 && bytes + cost > SESSION_RESPONSE_MAX_BYTES) break;
    bytes += cost;
    messages.push(message);
  }
  return {
    id: session.id,
    messages,
    total: session.messages.length,
    truncated: cursor < session.messages.length,
    nextOffset: cursor < session.messages.length ? cursor : null,
    malformed: session.malformed,
  };
}

export interface SessionSearchMatch {
  sessionId: string;
  index: number;
  role: string;
  snippet: string;
}

export interface SessionSearchPage {
  matches: SessionSearchMatch[];
  truncated: boolean;
}

/** Case-insensitive substring matches across message text, newest session first. */
export function searchSessions(options: {
  stateDir: string;
  repoDir: string;
  query: string;
  limit?: number;
  reader?: SessionReader;
}): SessionSearchPage {
  const query = options.query.toLowerCase();
  const cap = Math.min(
    SESSION_SEARCH_MAX_MATCHES,
    Math.max(1, options.limit ?? SESSION_SEARCH_MAX_MATCHES),
  );
  const selection = selectSessions(options);
  const ordered = [...selection.sessions].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) || left.path.localeCompare(right.path),
  );
  const matches: SessionSearchMatch[] = [];
  for (const session of ordered) {
    for (const message of session.messages) {
      const at = message.text.toLowerCase().indexOf(query);
      if (at < 0) continue;
      const start = Math.max(0, at - 60);
      const snippet = message.text
        .slice(start, start + SESSION_SEARCH_SNIPPET_MAX)
        .replace(/\s+/g, " ")
        .trim();
      matches.push({
        sessionId: session.id,
        index: message.index,
        role: message.role,
        snippet: snippet.slice(0, SESSION_SEARCH_SNIPPET_MAX),
      });
      if (matches.length > cap) {
        return { matches: matches.slice(0, cap), truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

/** Bytes of the bounded excerpts one filed issue may quote for a session. */
export const COACH_SESSION_EXCERPT_MAX = 2_000;

/**
 * A bounded, normalized excerpt of the messages that contributed evidence.
 * Deterministic for the same messages.
 */
export function sessionExcerpt(session: AgentSession, repoDir: string): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    if (message.text.length === 0) continue;
    const label =
      message.role === "toolResult"
        ? `${message.toolName ?? "tool"}${message.isError ? " (error)" : ""}`
        : message.role;
    lines.push(`${label}: ${firstNormalizedLine(message.text, { repoDir }) || "(empty)"}`);
    if (lines.join("\n").length >= COACH_SESSION_EXCERPT_MAX) break;
  }
  const text = lines.join("\n");
  return text.length <= COACH_SESSION_EXCERPT_MAX
    ? text
    : `${text.slice(0, COACH_SESSION_EXCERPT_MAX - 1).trimEnd()}…`;
}

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AcpActivity, AcpConnectionOptions, AcpQuestion } from "./acp";
import { isInteger, isRecord } from "../issues/guards";
import { pidAlive } from "../issues/lock";
import { journalKey } from "./journal";
import { runningHarnessDir } from "./version";

/**
 * The detached owner of one ACP run.
 *
 * The dashboard never holds a run's agent itself. Every run starts a small
 * owner process in its own session; the owner spawns the ACP peer, appends its
 * activity to a run-keyed journal, publishes its question, and consumes
 * answer, stop, pause, and resume commands. Because the owner is detached, a
 * replacement dashboard attaches to the same run and the same peer, whichever
 * harness version started it.
 *
 * A replacement writes a handoff marker before it exits, so the owner waits
 * for the replacement dashboard's lease. Any other supervisor exit ends the
 * peer and records one failed run naming the interruption.
 */

/** Envelope version of the owner state file. */
export const DETACHED_RUN_VERSION = 1;
/** How long an owner waits for the replacement dashboard a handoff promised. */
export const DETACHED_HANDOFF_GRACE_MS = 30_000;
/** The recorded error of a run an ordinary server exit ended. */
export const DETACHED_RUN_INTERRUPTED =
  "The server exit interrupted the run, so it was not resumed. Start it again.";
/** Bound on each run journal: both the activity and the text journal. */
const JOURNAL_MAX_ENTRIES = 1_000;
const JOURNAL_MAX_BYTES = 1024 * 1024;

export type DetachedRunStatus = "starting" | "running" | "succeeded" | "failed" | "stopped";

export interface DetachedRunState {
  version: number;
  kind: string;
  key: string;
  repo: string;
  stateDir: string;
  harnessVersion: string | null;
  /** The dashboard instance that started or adopted this run. */
  instance: string;
  /** The process that started the owner; it supervises when no lease exists. */
  launcherPid?: number;
  /** Identity of this run; a reset supersedes a previous owner's writes. */
  generation: string;
  /** True for a conversation owner that accepts further prompts. */
  multi?: boolean;
  /** The newest prompt turn this owner has started. */
  turnSeq?: number;
  turnStatus?: "idle" | "running" | "succeeded" | "failed";
  turnError?: string | null;
  status: DetachedRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  question: AcpQuestion | null;
  owner: { pid: number; argv: string[]; cwd: string } | null;
  peer: { pid: number; argv: string[]; cwd: string } | null;
  updatedAt: string;
}

export interface DetachedRunActivity {
  text: string;
  append: boolean;
}

/** `<STATE_DIR>/runs/<repository key>`. */
export function detachedRunsRoot(stateDir: string, repoDir: string): string {
  return join(resolve(stateDir), "runs", journalKey(resolve(repoDir)));
}

/** One run's directory; a kind and key never become a path segment directly. */
export function detachedRunDirectory(
  stateDir: string,
  repoDir: string,
  kind: string,
  key: string,
): string {
  const digest = createHash("sha256").update(`${kind}\u0000${key}`).digest("hex").slice(0, 32);
  return join(detachedRunsRoot(stateDir, repoDir), kind.replace(/[^a-z0-9-]/gi, "-"), digest);
}

export function detachedRunStatePath(directory: string): string {
  return join(directory, "state.json");
}

export function detachedRunActivityPath(directory: string): string {
  return join(directory, "activity.jsonl");
}

/** Assistant message text only, one JSON string per line. */
export function detachedRunTextPath(directory: string): string {
  return join(directory, "text.jsonl");
}

/** One journal's consumed byte offset, so a poll reads only appended bytes. */
export interface DetachedRunJournalCursor {
  offset: number;
  /** The drop count in the header of the generation this offset belongs to. */
  dropped: number;
}

/** What one journal read returned, and whether it began at byte 0. */
export interface DetachedRunJournalRead<T> {
  entries: T[];
  /**
   * True when the read began at byte 0: the cursor is new, or the journal was
   * rewritten by its bound. The caller drops the prefix it already delivered.
   */
  fromStart: boolean;
  /** Entries the bound discarded before this read's first entry. */
  dropped: number;
}

/** One read of a journal, with the header's drop count the bound records. */
interface DetachedRunJournal<T> {
  entries: T[];
  dropped: number;
}

/** The count in an optional `{"dropped":<n>}` header line, or 0. */
function parseDroppedHeader(line: string | undefined): number {
  if (line === undefined) return 0;
  const parsed = readJsonText(line);
  if (!isRecord(parsed) || !isInteger(parsed.dropped) || parsed.dropped <= 0) return 0;
  return parsed.dropped;
}

const LINE_BREAK = 0x0a;

/** Bytes a header probe reads; a `{"dropped":<n>}` line is far shorter. */
const HEADER_PROBE_BYTES = 128;

/** Reads the lines past `cursor`, holding back a trailing partial line. */
function readJournalAppend(
  path: string,
  cursor: DetachedRunJournalCursor,
): { lines: string[]; fromStart: boolean; dropped: number } {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return { lines: [], fromStart: false, dropped: cursor.dropped };
  }
  try {
    const size = fstatSync(descriptor).size;
    const probe = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
    const probed = readSync(descriptor, probe, 0, probe.length, 0);
    const dropped = parseDroppedHeader(
      probe.subarray(0, probed).toString("utf8").split("\n")[0],
    );
    // A rewritten journal carries a new drop count in its header, so a header
    // this cursor has not recorded means the bytes it consumed are gone.
    const rewritten = dropped !== cursor.dropped || size < cursor.offset;
    if (rewritten) {
      cursor.offset = 0;
      cursor.dropped = dropped;
    }
    // A read at byte 0 covers the whole journal: a new cursor or a rewrite.
    const fromStart = rewritten || cursor.offset === 0;
    if (size === cursor.offset) return { lines: [], fromStart, dropped };
    const buffer = Buffer.allocUnsafe(size - cursor.offset);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        filled,
        buffer.length - filled,
        cursor.offset + filled,
      );
      if (count === 0) break;
      filled += count;
    }
    const chunk = buffer.subarray(0, filled);
    // A line still being appended stays unread until the next poll completes it.
    const end = chunk.lastIndexOf(LINE_BREAK);
    if (end < 0) return { lines: [], fromStart, dropped };
    cursor.offset += end + 1;
    return {
      lines: chunk.subarray(0, end).toString("utf8").split("\n"),
      fromStart,
      dropped,
    };
  } catch {
    return { lines: [], fromStart: false, dropped: cursor.dropped };
  } finally {
    closeSync(descriptor);
  }
}

function parseTextLine(line: string): string | undefined {
  if (line.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseActivityLine(line: string): DetachedRunActivity | undefined {
  if (line.length === 0) return undefined;
  const parsed = readJsonText(line);
  if (!isRecord(parsed) || typeof parsed.text !== "string") return undefined;
  return { text: parsed.text, append: parsed.append === true };
}

/** The text journal: an optional `{"dropped":<n>}` header, then one string per line. */
function readDetachedRunTextJournal(directory: string): DetachedRunJournal<string> {
  let text: string;
  try {
    text = readFileSync(detachedRunTextPath(directory), "utf8");
  } catch {
    return { entries: [], dropped: 0 };
  }
  const chunks: string[] = [];
  let dropped = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (index === 0) dropped = parseDroppedHeader(line);
    const chunk = parseTextLine(line);
    if (chunk !== undefined) chunks.push(chunk);
  }
  return { entries: chunks, dropped };
}

/** Every chunk the text journal holds, for a caller replaying the run. */
export function readDetachedRunText(directory: string): string[] {
  return readDetachedRunTextJournal(directory).entries;
}

/** Only the chunks appended past `cursor`: the path a 20 Hz poll takes. */
export function readDetachedRunTextSince(
  directory: string,
  cursor: DetachedRunJournalCursor,
): DetachedRunJournalRead<string> {
  const { lines, fromStart, dropped } = readJournalAppend(detachedRunTextPath(directory), cursor);
  const entries: string[] = [];
  for (const line of lines) {
    const chunk = parseTextLine(line);
    if (chunk !== undefined) entries.push(chunk);
  }
  return { entries, fromStart, dropped };
}

/** Appends one chunk, then bounds the journal to the documented window. */
export function appendDetachedRunText(directory: string, text: string): void {
  mkdirSync(directory, { recursive: true });
  const path = detachedRunTextPath(directory);
  appendFileSync(path, `${JSON.stringify(text)}\n`);
  try {
    if (statSync(path).size <= JOURNAL_MAX_BYTES) return;
  } catch {
    return;
  }
  const { entries, dropped } = readDetachedRunTextJournal(directory);
  const kept = entries.slice(-JOURNAL_MAX_ENTRIES);
  const discarded = dropped + entries.length - kept.length;
  const header = discarded === 0 ? "" : `${JSON.stringify({ dropped: discarded })}\n`;
  writeFileSync(path, `${header}${kept.map((chunk) => `${JSON.stringify(chunk)}\n`).join("")}`);
}

export function detachedRunControlDirectory(directory: string): string {
  return join(directory, "control");
}

/** Marks a run the dashboard explicitly stopped; a new start supersedes it. */
export function detachedRunClosedPath(directory: string): string {
  return join(directory, "closed");
}

export function detachedRunLeasePath(stateDir: string, repoDir: string): string {
  return join(detachedRunsRoot(stateDir, repoDir), "lease.json");
}

export function detachedRunHandoffPath(stateDir: string, repoDir: string): string {
  return join(detachedRunsRoot(stateDir, repoDir), "handoff.json");
}

/** Reads JSON, treating unreadable bytes as absent. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Replaces one file atomically; a reader never sees a half-written value. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, path);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseChild(value: unknown): DetachedRunState["owner"] {
  if (!isRecord(value)) return null;
  if (!isInteger(value.pid) || value.pid <= 0) return null;
  if (!Array.isArray(value.argv) || !value.argv.every((entry) => typeof entry === "string")) {
    return null;
  }
  if (typeof value.cwd !== "string") return null;
  return { pid: value.pid, argv: [...value.argv], cwd: value.cwd };
}

function parseQuestion(value: unknown): AcpQuestion | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" && !isInteger(value.id)) return undefined;
  if (typeof value.message !== "string") return undefined;
  if (!Array.isArray(value.options)) return undefined;
  const options: AcpQuestion["options"] = [];
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.label !== "string") return undefined;
    options.push({
      label: option.label,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
      recommended: option.recommended === true,
    });
  }
  return {
    id: value.id,
    message: value.message,
    options,
    properties: isRecord(value.properties) ? value.properties : {},
    required: Array.isArray(value.required)
      ? value.required.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

const STATUSES: readonly DetachedRunStatus[] = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "stopped",
];

export function parseDetachedRunState(value: unknown): DetachedRunState | undefined {
  if (!isRecord(value) || value.version !== DETACHED_RUN_VERSION) return undefined;
  if (typeof value.kind !== "string" || typeof value.key !== "string") return undefined;
  if (typeof value.repo !== "string" || typeof value.stateDir !== "string") return undefined;
  if (!nullableString(value.harnessVersion)) return undefined;
  if (typeof value.instance !== "string" || value.instance.length === 0) return undefined;
  if (typeof value.generation !== "string" || value.generation.length === 0) return undefined;
  if (typeof value.status !== "string" || !STATUSES.includes(value.status as DetachedRunStatus)) {
    return undefined;
  }
  if (typeof value.startedAt !== "string") return undefined;
  if (!nullableString(value.finishedAt) || !nullableString(value.error)) return undefined;
  const question = parseQuestion(value.question);
  if (question === undefined) return undefined;
  return {
    version: DETACHED_RUN_VERSION,
    kind: value.kind,
    key: value.key,
    repo: value.repo,
    stateDir: value.stateDir,
    harnessVersion: value.harnessVersion,
    instance: value.instance,
    ...(isInteger(value.launcherPid) ? { launcherPid: value.launcherPid } : {}),
    generation: value.generation,
    ...(value.multi === true ? { multi: true } : {}),
    ...(isInteger(value.turnSeq) ? { turnSeq: value.turnSeq } : {}),
    ...(value.turnStatus === "idle" ||
    value.turnStatus === "running" ||
    value.turnStatus === "succeeded" ||
    value.turnStatus === "failed"
      ? { turnStatus: value.turnStatus }
      : {}),
    ...(nullableString(value.turnError) ? { turnError: value.turnError } : {}),
    status: value.status as DetachedRunStatus,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    error: value.error,
    question,
    owner: parseChild(value.owner),
    peer: parseChild(value.peer),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function readDetachedRunState(directory: string): DetachedRunState | undefined {
  return parseDetachedRunState(readJson(detachedRunStatePath(directory)));
}

export function writeDetachedRunState(directory: string, state: DetachedRunState): void {
  writeJson(detachedRunStatePath(directory), state);
}

/**
 * The activity journal: an optional `{"dropped":<n>}` header, then one object
 * per line. `dropped` counts every entry the size bound has discarded since the
 * journal was created; a reader that counts entries adds it back so its cursor
 * stays a count of everything the run ever appended instead of a position in
 * the rewritten file.
 */
function readDetachedRunActivityJournal(directory: string): DetachedRunJournal<DetachedRunActivity> {
  let text: string;
  try {
    text = readFileSync(detachedRunActivityPath(directory), "utf8");
  } catch {
    return { entries: [], dropped: 0 };
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const entries: DetachedRunActivity[] = [];
  let dropped = 0;
  for (const [index, line] of lines.entries()) {
    if (index === 0) {
      dropped = parseDroppedHeader(line);
      if (dropped > 0) continue;
    }
    const entry = parseActivityLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, dropped };
}

/** The activity journal's entries, oldest first. */
export function readDetachedRunActivity(directory: string): DetachedRunActivity[] {
  return readDetachedRunActivityJournal(directory).entries;
}

/** Only the entries appended past `cursor`: the path a 20 Hz poll takes. */
export function readDetachedRunActivitySince(
  directory: string,
  cursor: DetachedRunJournalCursor,
): DetachedRunJournalRead<DetachedRunActivity> {
  const { lines, fromStart, dropped } = readJournalAppend(
    detachedRunActivityPath(directory),
    cursor,
  );
  const entries: DetachedRunActivity[] = [];
  for (const line of lines) {
    const entry = parseActivityLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, fromStart, dropped };
}

function readJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Appends one entry, then bounds the journal to the documented window. */
export function appendDetachedRunActivity(
  directory: string,
  activity: DetachedRunActivity,
): void {
  mkdirSync(directory, { recursive: true });
  const path = detachedRunActivityPath(directory);
  appendFileSync(path, `${JSON.stringify(activity)}\n`);
  try {
    if (statSync(path).size <= JOURNAL_MAX_BYTES) return;
  } catch {
    return;
  }
  const { entries, dropped } = readDetachedRunActivityJournal(directory);
  const kept = entries.slice(-JOURNAL_MAX_ENTRIES);
  const discarded = dropped + entries.length - kept.length;
  const header = discarded === 0 ? "" : `${JSON.stringify({ dropped: discarded })}\n`;
  writeFileSync(path, `${header}${kept.map((entry) => `${JSON.stringify(entry)}\n`).join("")}`);
}

export type DetachedRunCommand =
  | { type: "prompt"; seq: number; text: string }
  | { type: "answer"; id: number | string; value: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" };

let commandSequence = 0;

/** Writes one instruction atomically; the owner consumes it in name order. */
export function writeDetachedRunCommand(
  directory: string,
  command: DetachedRunCommand,
): void {
  mkdirSync(directory, { recursive: true });
  commandSequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(commandSequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  writeJson(path, command);
}

export function parseDetachedRunCommand(text: string): DetachedRunCommand | undefined {
  const parsed = readJsonText(text);
  if (!isRecord(parsed)) return undefined;
  if (parsed.type === "stop" || parsed.type === "pause" || parsed.type === "resume") {
    return { type: parsed.type };
  }
  if (parsed.type === "prompt") {
    if (!isInteger(parsed.seq) || typeof parsed.text !== "string") return undefined;
    return { type: "prompt", seq: parsed.seq, text: parsed.text };
  }
  if (parsed.type !== "answer") return undefined;
  if (typeof parsed.id !== "string" && !isInteger(parsed.id)) return undefined;
  if (typeof parsed.value !== "string") return undefined;
  return { type: "answer", id: parsed.id, value: parsed.value };
}

/** Reads and consumes every pending instruction in name order. */
export function takeDetachedRunCommands(directory: string): DetachedRunCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: DetachedRunCommand[] = [];
  for (const name of names) {
    const path = join(directory, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      // Another consumer already took it.
    }
    const command = parseDetachedRunCommand(text);
    if (command !== undefined) commands.push(command);
  }
  return commands;
}

export interface DetachedLease {
  pid: number;
  instance: string;
  updatedAt: number;
}

export function readDetachedLease(stateDir: string, repoDir: string): DetachedLease | null {
  const parsed = readJson(detachedRunLeasePath(stateDir, repoDir));
  if (!isRecord(parsed) || !isInteger(parsed.pid) || !isInteger(parsed.updatedAt)) return null;
  return {
    pid: parsed.pid,
    instance: typeof parsed.instance === "string" ? parsed.instance : "",
    updatedAt: parsed.updatedAt,
  };
}

export function writeDetachedLease(
  stateDir: string,
  repoDir: string,
  instance: string,
): void {
  writeJson(detachedRunLeasePath(stateDir, repoDir), {
    pid: process.pid,
    instance,
    updatedAt: Date.now(),
  } satisfies DetachedLease);
}

export function readDetachedHandoff(
  stateDir: string,
  repoDir: string,
): { at: number; pid: number } | null {
  const parsed = readJson(detachedRunHandoffPath(stateDir, repoDir));
  if (!isRecord(parsed) || !isInteger(parsed.at) || !isInteger(parsed.pid)) return null;
  return { at: parsed.at, pid: parsed.pid };
}

export function writeDetachedHandoff(stateDir: string, repoDir: string): void {
  writeJson(detachedRunHandoffPath(stateDir, repoDir), { at: Date.now(), pid: process.pid });
}

export function removeDetachedHandoff(stateDir: string, repoDir: string): void {
  try {
    unlinkSync(detachedRunHandoffPath(stateDir, repoDir));
  } catch {
    // Already gone.
  }
}

/** Removes a finished run so a fresh start never reads its predecessor. */
export function resetDetachedRun(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Dashboard side                                                       */
/* ------------------------------------------------------------------ */

/**
 * Repository keys whose runs a replacement has adopted. A `close()` during
 * the handoff window must not end a peer the replacement is about to own.
 */
const handoffRepos = new Map<string, string>();

export function detachedRepoKey(repoDir: string): string {
  return journalKey(resolve(repoDir));
}

/** Marks this instance's runs as belonging to the replacement. */
export function beginDetachedHandoff(
  stateDir: string,
  repoDir: string,
  instance: string,
): void {
  handoffRepos.set(detachedRepoKey(repoDir), instance);
  writeDetachedHandoff(stateDir, repoDir);
}

/** Ends the handoff for one instance, or for every instance when omitted. */
export function endDetachedHandoff(
  stateDir: string,
  repoDir: string,
  instance?: string,
): void {
  const key = detachedRepoKey(repoDir);
  if (instance === undefined || handoffRepos.get(key) === instance) {
    handoffRepos.delete(key);
  }
  removeDetachedHandoff(stateDir, repoDir);
}

/** True for the instance that began the handoff; a successor never inherits it. */
export function inDetachedHandoff(repoDir: string, instance: string): boolean {
  return handoffRepos.get(detachedRepoKey(repoDir)) === instance;
}

export interface DetachedPeerOptions extends AcpConnectionOptions {
  repoDir: string;
  stateDir: string;
  /** The run family, e.g. `lane`, `adr`, `discover`, `flow`, `ask`. */
  kind: string;
  /** Stable identity of this run across a replacement. */
  key: string;
  /** The harness version that started this run. */
  harnessVersion?: string | null;
  /** The dashboard instance that owns this handle. */
  instance: string;
  /** Activity entries the caller already holds; never emitted again. */
  skipActivity?: number;
  /** Attach to an existing run and never start a new one. */
  attachOnly?: boolean;
  /** Accept further prompts on one peer session. */
  multi?: boolean;
  /** Test seam; production spawns the owner detached. */
  spawnOwner?: (argv: string[], environment: Record<string, string | undefined>) => number | undefined;
  /** Poll cadence; tests shorten it. */
  pollMs?: number;
}

const TERMINAL = new Set<DetachedRunStatus>(["succeeded", "failed", "stopped"]);

/**
 * The dashboard handle to a detached run. It reads the owner's published
 * state, streams new activity into the same callbacks an in-process peer
 * used, and writes commands the owner consumes.
 */
export class DetachedPeer {
  readonly #options: DetachedPeerOptions;
  readonly #directory: string;
  readonly #control: string;
  readonly #spawnOwner: NonNullable<DetachedPeerOptions["spawnOwner"]>;
  readonly #pollMs: number;
  /** Byte offsets this peer has consumed, so a poll parses only appends. */
  readonly #activityCursor: DetachedRunJournalCursor = { offset: 0, dropped: 0 };
  readonly #textCursor: DetachedRunJournalCursor = { offset: 0, dropped: 0 };
  #seenActivity: number;
  #seenText = 0;
  #lastQuestion: string | null = null;
  #nextTurn = 0;
  #lastTurnSeq = 0;
  #firstResolved = false;
  #turnWaiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #closed = false;
  #settled = false;
  #paused = false;
  #preserved = false;
  #started = false;
  #timer: Timer | undefined;
  #starting: Promise<void> | undefined;
  #state: DetachedRunState | undefined;
  #resolveRun: ((value: unknown) => void) | undefined;
  #rejectRun: ((error: unknown) => void) | undefined;
  #runPromise: Promise<unknown> | undefined;

  constructor(options: DetachedPeerOptions) {
    this.#options = options;
    this.#directory = detachedRunDirectory(options.stateDir, options.repoDir, options.kind, options.key);
    this.#control = detachedRunControlDirectory(this.#directory);
    this.#spawnOwner =
      options.spawnOwner ??
      ((argv, environment) => {
        try {
          const child = spawn(argv[0]!, argv.slice(1), {
            cwd: options.repoDir,
            env: environment,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return child.pid;
        } catch (error) {
          options.onStderr?.(`could not start the ${options.kind} run owner: ${String(error)}\n`);
          return undefined;
        }
      });
    this.#pollMs = options.pollMs ?? 50;
    this.#seenActivity = Math.max(0, options.skipActivity ?? 0);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The real ACP peer, recorded by its owner. */
  get pid(): number | undefined {
    const peer = this.#state?.peer;
    return peer === null || peer === undefined ? undefined : peer.pid;
  }

  get argv(): string[] {
    return [...(this.#state?.peer?.argv ?? [])];
  }

  /** The owner process itself, observable by fixtures and diagnostics. */
  get ownerPid(): number | undefined {
    return this.#state?.owner?.pid;
  }

  /** Marks this run as owned by the replacement rather than this process. */
  preserve(): void {
    this.#preserved = true;
  }

  /**
   * Starts the run, or attaches to the live one a previous dashboard started.
   * The returned promise settles with the owner's terminal status.
   */
  run(prompt: string): Promise<unknown> {
    if (this.#runPromise !== undefined) return this.#runPromise;
    const { promise, resolve: resolveRun, reject: rejectRun } =
      Promise.withResolvers<unknown>();
    this.#resolveRun = resolveRun;
    this.#rejectRun = rejectRun;
    this.#runPromise = promise;
    void this.#attachOrSpawn(prompt);
    return promise;
  }

  /** Waits for one turn already running on the owner, without sending one. */
  waitTurn(seq: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("The conversation is closed."));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#turnWaiters.set(seq, { resolve, reject });
    this.#nextTurn = Math.max(this.#nextTurn, seq);
    return promise;
  }

  /** A conversation owner accepts a follow-up prompt on the same peer. */
  prompt(prompt: string): Promise<unknown> {
    if (this.#options.multi !== true) return this.run(prompt);
    if (this.#closed) return Promise.reject(new Error("The conversation is closed."));
    this.#nextTurn = Math.max(this.#nextTurn, this.#lastTurnSeq) + 1;
    const seq = this.#nextTurn;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#turnWaiters.set(seq, { resolve, reject });
    writeDetachedRunCommand(this.#control, { type: "prompt", seq, text: prompt });
    return promise;
  }

  answer(id: number | string, value: string): boolean {
    if (this.#closed) return false;
    // An answer can arrive before this peer's first poll has read the owner's
    // state. The owner's file is authoritative and already carries the
    // question its dashboard replayed, so never reject on the cached copy.
    const question = readDetachedRunState(this.#directory)?.question ?? this.#state?.question;
    if (question === null || question === undefined) return false;
    if (String(question.id) !== String(id)) return false;
    writeDetachedRunCommand(this.#control, { type: "answer", id, value });
    return true;
  }

  pause(): boolean {
    if (this.#closed) return false;
    // Deliver everything the owner has published so far, then stop emitting.
    this.#poll();
    this.#paused = true;
    writeDetachedRunCommand(this.#control, { type: "pause" });
    return true;
  }

  resume(): boolean {
    if (this.#closed) return false;
    this.#paused = false;
    writeDetachedRunCommand(this.#control, { type: "resume" });
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // A replacement owns the run; ending it here would defeat the handoff.
    if (this.#preserved || inDetachedHandoff(this.#options.repoDir, this.#options.instance)) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#settle({ preserved: true });
      return;
    }
    // Keep polling so the owner's `stopped` status settles the run promise.
    try {
      writeFileSync(detachedRunClosedPath(this.#directory), `${Date.now()}\n`);
    } catch {
      // A missing directory means the run already ended.
    }
    writeDetachedRunCommand(this.#control, { type: "stop" });
    // Settle the caller now; the owner ends the peer on its own.
    this.#settle({ stopReason: "stop" });
  }

  async #attachOrSpawn(prompt: string): Promise<void> {
    const existing = readDetachedRunState(this.#directory);
    if (this.#options.attachOnly === true) {
      if (existing === undefined) {
        this.#settleFailure(new Error(`No detached ${this.#options.kind} run exists.`));
        return;
      }
      this.#state = existing;
      this.#lastQuestion = existing.question === null ? null : JSON.stringify(existing.question);
      this.#startPolling();
      return;
    }
    if (existing !== undefined && this.#live(existing)) {
      this.#state = existing;
      this.#lastQuestion = existing.question === null ? null : JSON.stringify(existing.question);
      this.#startPolling();
      return;
    }
    // A previous finished run under the same key must not be mistaken for
    // this one, and its queued commands must never reach the new peer. A live
    // owner that this start supersedes is stopped first, so it cannot publish
    // over the new run's state while it exits.
    if (existing !== undefined && existing.owner !== null && pidAlive(existing.owner.pid)) {
      try {
        writeDetachedRunCommand(detachedRunControlDirectory(this.#directory), { type: "stop" });
      } catch {
        // The owner is already gone.
      }
      const stopDeadline = Date.now() + 2_000;
      while (pidAlive(existing.owner.pid) && Date.now() < stopDeadline) {
        await Bun.sleep(20);
      }
    }
    resetDetachedRun(this.#directory);
    const now = new Date().toISOString();
    const generation = randomUUID();
    writeDetachedRunState(this.#directory, {
      version: DETACHED_RUN_VERSION,
      kind: this.#options.kind,
      key: this.#options.key,
      repo: resolve(this.#options.repoDir),
      stateDir: resolve(this.#options.stateDir),
      harnessVersion: this.#options.harnessVersion ?? null,
      instance: this.#options.instance,
      launcherPid: process.pid,
      generation,
      ...(this.#options.multi === true
        ? { multi: true, turnSeq: 0, turnStatus: "idle" as const, turnError: null }
        : {}),
      status: "starting",
      startedAt: now,
      finishedAt: null,
      error: null,
      question: null,
      owner: null,
      peer: null,
      updatedAt: now,
    });
    mkdirSync(this.#directory, { recursive: true });
    writeFileSync(join(this.#directory, "prompt.txt"), prompt);
    const argv = [
      process.execPath,
      join(runningHarnessDir(), "server", "run-owner.ts"),
      "--repo",
      resolve(this.#options.repoDir),
      "--state-dir",
      resolve(this.#options.stateDir),
      "--kind",
      this.#options.kind,
      "--key",
      this.#options.key,
      "--generation",
      generation,
      "--command",
      this.#options.command,
      "--cwd",
      this.#options.cwd,
      "--harness-dir",
      runningHarnessDir(),
      ...(this.#options.permissionPolicy === undefined
        ? []
        : ["--permission", this.#options.permissionPolicy]),
      ...(this.#options.multi === true ? ["--multi"] : []),
    ];
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...(this.#options.env ?? {}),
    };
    const pid = this.#spawnOwner(argv, environment);
    if (pid === undefined) {
      this.#closed = true;
      this.#rejectRun?.(new Error(`The ${this.#options.kind} run owner could not start.`));
    }
    this.#startPolling();
  }

  #live(state: DetachedRunState): boolean {
    if (existsSync(detachedRunClosedPath(this.#directory))) return false;
    if (state.owner === null || !pidAlive(state.owner.pid)) return false;
    if (TERMINAL.has(state.status)) return false;
    // A live owner is adopted, whether the replacement has already recorded
    // its own instance on the run (an in-process successor adopts through the
    // lease) or not. A caller that wants a new run stops the old owner first.
    if (state.instance === this.#options.instance) return true;
    // A second dashboard in this same process (a test or an in-process
    // restart) supervises the same owners; it adopts them without a handoff.
    if (state.launcherPid === process.pid) return true;
    const handoff = readDetachedHandoff(this.#options.stateDir, this.#options.repoDir);
    return handoff !== null && Date.now() < handoff.at + DETACHED_HANDOFF_GRACE_MS;
  }

  #startPolling(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.#poll(), this.#pollMs);
    this.#timer.unref?.();
    this.#poll();
  }

  /**
   * Drops the entries this peer already delivered. `seen` counts every entry
   * the run ever appended, and the journal's header re-bases that count onto
   * the file its bound rewrote; an append read starts at the cursor, so only a
   * first read or a rewrite carries a delivered prefix.
   */
  #consume<T>(
    read: DetachedRunJournalRead<T>,
    seen: number,
  ): { entries: T[]; seen: number } {
    if (read.fromStart) {
      const base = Math.min(Math.max(0, seen - read.dropped), read.entries.length);
      return {
        entries: read.entries.slice(base),
        seen: read.dropped + read.entries.length,
      };
    }
    return { entries: read.entries, seen: seen + read.entries.length };
  }

  #poll(): void {
    const state = readDetachedRunState(this.#directory);
    if (state === undefined) return;
    this.#state = state;
    const activity = this.#consume(
      readDetachedRunActivitySince(this.#directory, this.#activityCursor),
      this.#seenActivity,
    );
    this.#seenActivity = activity.seen;
    if (!this.#paused) {
      for (const entry of activity.entries) this.#options.onActivity(entry as AcpActivity);
    }
    const text = this.#consume(
      readDetachedRunTextSince(this.#directory, this.#textCursor),
      this.#seenText,
    );
    this.#seenText = text.seen;
    if (!this.#paused && this.#options.onText !== undefined) {
      for (const chunk of text.entries) this.#options.onText(chunk);
    }
    if (this.#options.multi === true) {
      const seq = state.turnSeq ?? 0;
      const status = state.turnStatus ?? "idle";
      if (!this.#firstResolved && seq >= 1 && status !== "running") {
        this.#firstResolved = true;
        if (status === "failed") {
          this.#rejectRun?.(new Error(state.turnError ?? "the turn failed"));
        } else {
          this.#resolveRun?.({});
        }
      }
      if (seq > this.#lastTurnSeq && status !== "running") {
        for (const [turn, waiter] of [...this.#turnWaiters]) {
          if (turn > seq) continue;
          this.#turnWaiters.delete(turn);
          if (status === "failed") {
            waiter.reject(new Error(state.turnError ?? "the turn failed"));
          } else {
            waiter.resolve({});
          }
        }
        this.#lastTurnSeq = seq;
      }
    }
    const question = state.question === null ? null : JSON.stringify(state.question);
    if (question !== null && question !== this.#lastQuestion) {
      this.#lastQuestion = question;
      this.#options.onQuestion(state.question as AcpQuestion);
    }
    if (!TERMINAL.has(state.status)) {
      if (
        this.#options.multi === true &&
        state.peer !== null &&
        !pidAlive(state.peer.pid)
      ) {
        this.#settleFailure(new Error(state.turnError ?? "The ask agent exited."));
        return;
      }
      if (state.owner !== null && !pidAlive(state.owner.pid) && state.status !== "starting") {
        this.#finish(
          state.status,
          state.error ?? "The run owner exited before the run finished.",
        );
      }
      return;
    }
    this.#finish(state.status, state.error);
  }

  #finish(status: DetachedRunStatus, error: string | null): void {
    if (this.#settled || this.#resolveRun === undefined) return;
    if (status === "failed") {
      this.#settleFailure(new Error(error ?? "the run failed"));
      return;
    }
    this.#settle(status === "stopped" ? { stopReason: "stop" } : {});
  }

  #settle(value: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#resolveRun?.(value);
  }

  #settleFailure(error: Error): void {
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#turnWaiters.clear();
    if (this.#settled) return;
    this.#settled = true;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#rejectRun?.(error);
  }
}

/** True while a run key has a live owner. */
export function detachedRunLive(
  stateDir: string,
  repoDir: string,
  kind: string,
  key: string,
  instance: string,
): boolean {
  const state = readDetachedRunState(detachedRunDirectory(stateDir, repoDir, kind, key));
  if (state === undefined || state.owner === null || !pidAlive(state.owner.pid)) return false;
  if (TERMINAL.has(state.status)) return false;
  if (state.instance === instance) return true;
  const handoff = readDetachedHandoff(stateDir, repoDir);
  return handoff !== null && Date.now() < handoff.at + DETACHED_HANDOFF_GRACE_MS;
}

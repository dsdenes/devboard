import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AcpActivity, AcpQuestion, AcpQuestionOption } from "./acp";
import { AcpConnection } from "./acp";
import {
  CommandFlowForge,
  type FlowPrAdapter,
  type ForgePrState,
  type ForgeTarget,
} from "./forge-pr";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  spawnExec,
  type Exec,
  type Forge,
} from "../lib/forge-auth.ts";
import { giteaBaseUrl, parseForgeRemote } from "../lib/forge";
import { journalKey, type Journal } from "./journal";
import { writeStateFile, type RecordedChild } from "./state";

/**
 * Flow Mode: one implementation agent in an isolated worktree, reviewable as
 * color-coded change widgets, steered by an append-only feed and one editable
 * decision board.
 *
 * The controller owns the session, its files under the harness state
 * directory, the worktree, the ACP peers, and the diff watcher. It never
 * writes `GOAL.md` or `adrs/`, never creates an issue or an epic, and never
 * applies an edit a read-only peer produced. Goal Mode's behavior is untouched:
 * this module only reports whether it has active work.
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

export type FlowCategory = (typeof FLOW_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(FLOW_CATEGORIES);

export interface FlowFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  diff: string;
  /** Why an untracked file's body was omitted; absent when `diff` holds it. */
  omitted?: "binary" | "large" | "unreadable";
}

export interface FlowWidget {
  /** Stable signature over the category, its file set, and their diff. */
  id: string;
  category: FlowCategory;
  concept: string;
  summary: string;
  rationale: string;
  files: string[];
  accepted: boolean;
}

export interface FlowSteeringNote {
  id: string;
  timestamp: string;
  source: string;
  text: string;
  status: "new" | "read";
}

export interface FlowCheckpoint {
  id: string;
  timestamp: string;
  summary: string;
  files: number;
  commit: string;
  verification: "passed" | "failed" | "not-run";
}

export interface FlowVerification {
  command: string;
  status: "passed" | "failed" | "not-run";
  timestamp: string;
  output: string;
}

export interface FlowBlocker {
  id: string;
  timestamp: string;
  text: string;
  dismissed: boolean;
}

export interface FlowPr {
  forge: Forge;
  number: number;
  url: string;
  state: "none" | "draft" | "live" | "merged" | "closed" | "error";
}

export interface FlowQuestion {
  id: number | string;
  message: string;
  options: AcpQuestionOption[];
}

export interface FlowConversationMessage {
  role: "developer" | "agent";
  text: string;
}

export interface FlowHistoryEntry {
  sessionId: string;
  goal: string;
  pr: FlowPr | null;
}

export interface FlowSnapshot {
  sessionId: string | null;
  status: "none" | "idle" | "running" | "stopped" | "merged";
  goal: string;
  decisions: string;
  worktree: string | null;
  branch: string | null;
  baseRevision: string | null;
  files: FlowFile[];
  widgets: FlowWidget[];
  steering: FlowSteeringNote[];
  checkpoints: FlowCheckpoint[];
  verification: FlowVerification | null;
  blockers: FlowBlocker[];
  pr: FlowPr | null;
  prError: string | null;
  leftover: string | null;
  question: FlowQuestion | null;
  goalCreation: { activity: string[]; question: FlowQuestion | null } | null;
  conversation: {
    widgetId: string;
    messages: FlowConversationMessage[];
    activity: string[];
    question: FlowQuestion | null;
  } | null;
  activity: string[];
  notice: string | null;
  history: FlowHistoryEntry[];
}

export interface FlowOptions {
  repoDir: string;
  stateDir: string;
  agentCommand: string;
  /** Resolves the selected provider's environment for every ACP peer. */
  agentEnvironment: () => Promise<Record<string, string | undefined>>;
  broadcast: (event: unknown) => void;
  journal?: Pick<Journal, "write">;
  /** Injected fake forge, or a real one built from `exec`. */
  forge?: FlowPrAdapter;
  /** Classified origin remote for the forge adapter. */
  forgeTarget?: ForgeTarget;
  exec?: Exec;
  now?: () => number;
  /** Poll interval of the diff watcher. */
  watchMs?: number;
  /** Bound on one analyst turn. */
  analystTimeoutMs?: number;
  /** Bound on one goal interview turn. */
  goalTimeoutMs?: number;
  /** Bound on one git/gh/glab child; a stalled command settles as killed. */
  commandTimeoutMs?: number;
  /** Describes active Goal Mode work, if any. */
  goalWorkActive?: () => string | undefined;
}

interface FlowSession {
  id: string;
  baseRevision: string | null;
  worktree: string;
  branch: string;
  status: "idle" | "running" | "stopped" | "merged";
  goal: string;
  decisions: string;
  steering: FlowSteeringNote[];
  accepted: string[];
  widgets: FlowWidget[];
  files: FlowFile[];
  checkpoints: FlowCheckpoint[];
  verification: FlowVerification | null;
  blockers: FlowBlocker[];
  pr: FlowPr | null;
  prError: string | null;
  leftover: string | null;
  /** True from the merge's terminal write until a cleanup attempt finishes with no leftovers. */
  cleanupPending: boolean;
  question: FlowQuestion | null;
  pushedTip: string | null;
  prFailedTip: string | null;
  lastDiffHash: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawWidget {
  category: string;
  concept: string;
  summary: string;
  rationale: string;
  files: string[];
}

interface Conversation {
  widgetId: string;
  agent: AcpConnection | undefined;
  messages: FlowConversationMessage[];
  activity: string[];
  question: FlowQuestion | null;
  busy: boolean;
  queue: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

const STALE_VERIFICATION: FlowVerification["status"] = "not-run";
const DEFAULT_WATCH_MS = 400;
/** Bound on the text the watcher keeps for one untracked file. */
export const UNTRACKED_BODY_MAX_BYTES = 1_048_576;
const DEFAULT_ANALYST_TIMEOUT_MS = 60_000;
const DEFAULT_GOAL_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_MAX = 4000;
const BLOCKER_MARKER = "DEVBOARD-BLOCKED:";
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  NO_COLOR: "1",
};

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Lines of a JSON-lines file; a malformed or absent file reads as none. */
function readJsonLines<T>(path: string): T[] {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: T[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch {
      // One damaged line costs at most that entry.
    }
  }
  return entries;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Replaces a Flow file atomically, sharing the state writer's guarantee: a
 * failed save leaves the previous complete bytes in place instead of a
 * truncated file that a restore would read as an empty goal or decision board.
 */
function writeText(path: string, text: string): void {
  writeStateFile(path, text);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function appendLine(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^#+\s*/, ""))
      .find((line) => line.length > 0) ?? "Flow session"
  );
}

function boundedTail(text: string): string {
  return text.length <= OUTPUT_TAIL_MAX ? text : text.slice(text.length - OUTPUT_TAIL_MAX);
}

/** A diff without the volatile index line and trailing spaces. */
export function normalizeDiff(diff: string): string {
  return diff
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/** Parses a unified diff into the files it touches, with per-file counts. */
/** Resolves after `ms`; races bounded ACP turns. */
function timeout(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function countDiffLines(chunk: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { insertions, deletions };
}

/**
 * Decodes one path token of a `diff --git` header. Git quotes a token with a
 * C-style escape when the path holds a quote, a backslash, a control byte, or
 * (with `core.quotePath`, the default) a non-ASCII byte.
 */
function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;
  const end = token.length - 1;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '"': 34,
    "\\": 92,
  };
  let index = 1;
  while (index < end) {
    const char = token[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      index += 1;
      continue;
    }
    const next = token[index + 1];
    if (next === undefined) {
      bytes.push(92);
      break;
    }
    const simple = escapes[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 2;
      continue;
    }
    if (next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(token.slice(index + 1))?.[0] ?? "";
      bytes.push(Number.parseInt(octal, 8));
      index += 1 + octal.length;
      continue;
    }
    bytes.push(92);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The two paths of a `diff --git` header, without the `a/` and `b/` prefixes.
 * Quoted headers are decoded; a plain header keeps the usual greedy split.
 */
function diffHeaderPaths(rest: string): [string, string] | undefined {
  let first: string;
  let second: string;
  if (rest.startsWith('"')) {
    let index = 1;
    while (index < rest.length && rest[index] !== '"') {
      index += rest[index] === "\\" ? 2 : 1;
    }
    const closing = rest[index];
    if (closing !== '"' || rest[index + 1] !== " ") return undefined;
    first = unquoteGitPath(rest.slice(0, index + 1));
    second = unquoteGitPath(rest.slice(index + 2));
  } else {
    const plain = /^a\/(.+) b\/(.+)$/.exec(rest);
    if (plain === null) return undefined;
    first = plain[1] ?? "";
    second = plain[2] ?? "";
    if (first.length === 0 || second.length === 0) return undefined;
    return [first, second];
  }
  if (!first.startsWith("a/") || !second.startsWith("b/")) return undefined;
  return [first.slice(2), second.slice(2)];
}

/** Splits one `git diff` result into per-path chunks. */
export function splitDiffFiles(text: string): Map<string, string> {
  const files = new Map<string, string>();
  let currentPath: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    // Dropping the separator newline keeps a chunk identical whether or not
    // another file follows it, so diffHash ignores file order and neighbours.
    if (currentPath !== undefined) files.set(currentPath, lines.join("\n").replace(/\n+$/, ""));
    currentPath = undefined;
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("diff --git ")) {
      if (currentPath !== undefined) lines.push(line);
      continue;
    }
    // A file head always ends the previous chunk, so an unreadable header can
    // never fold its body into another file's diff.
    flush();
    const paths = diffHeaderPaths(line.slice("diff --git ".length));
    if (paths === undefined) continue;
    currentPath = paths[1];
    lines = [line];
  }
  flush();
  return files;
}

/** The tracked files one `git diff` result touches, with per-file counts. */
export function diffFiles(text: string): FlowFile[] {
  return [...splitDiffFiles(text)].map(([path, chunk]) => {
    const counts = countDiffLines(chunk);
    return {
      path,
      status: fileStatus(chunk),
      insertions: counts.insertions,
      deletions: counts.deletions,
      diff: chunk,
    };
  });
}

function fileStatus(chunk: string): FlowFile["status"] {
  if (/^new file mode /m.test(chunk)) return "added";
  if (/^deleted file mode /m.test(chunk)) return "deleted";
  if (/^rename from /m.test(chunk)) return "renamed";
  return "modified";
}

/** The whole-diff hash the watcher compares to decide whether to analyze. */
export function diffHash(files: FlowFile[]): string {
  return sha256(
    files
      .map((file) => `${file.path}\0${file.omitted ?? ""}\0${normalizeDiff(file.diff)}`)
      .sort()
      .join("\0"),
  );
}

/**
 * A widget's identity: its category, its sorted file set, and the normalized
 * diff of those files. Concept text is display metadata and never part of it.
 */
export function widgetSignature(
  category: string,
  paths: string[],
  diffs: Map<string, string>,
): string {
  const body = [
    category,
    [...paths].sort().join("\0"),
    [...paths]
      .sort()
      .map((path) => normalizeDiff(diffs.get(path) ?? ""))
      .join("\0"),
  ].join("\0");
  return sha256(body).slice(0, 16);
}

/** One new file's unified diff, built rather than shelled out to git. */
function untrackedDiff(path: string, content: string, mode = "100644"): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${path}`,
  ];
  if (content.length === 0) return header.join("\n");
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  return [...header, ...body].join("\n");
}

function omittedFile(path: string, omitted: "binary" | "large" | "unreadable"): FlowFile {
  return { path, status: "added", insertions: 0, deletions: 0, diff: "", omitted };
}

function addedFile(path: string, diff: string): FlowFile {
  const counts = countDiffLines(diff);
  return {
    path,
    status: "added",
    insertions: counts.insertions,
    deletions: counts.deletions,
    diff,
  };
}

/**
 * One untracked file as a bounded FlowFile. A body above the limit or holding
 * a NUL byte never enters the session or the frame: the path stays visible
 * with zero counts and the reason the body is absent. A symlink is never read
 * through: git records its mode and target, so the body is the target string
 * and a dangling or directory-pointing link stays visible like any other.
 */
function untrackedFile(worktree: string, path: string): FlowFile | undefined {
  const absolute = join(worktree, path);
  let stats: Stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(absolute, "utf8");
    } catch {
      return omittedFile(path, "unreadable");
    }
    if (Buffer.byteLength(target) > UNTRACKED_BODY_MAX_BYTES) return omittedFile(path, "large");
    return addedFile(path, untrackedDiff(path, target, "120000"));
  }
  if (!stats.isFile()) return undefined;
  if (stats.size > UNTRACKED_BODY_MAX_BYTES) return omittedFile(path, "large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return undefined;
  }
  // The file may have grown between the stat and the read.
  if (bytes.length > UNTRACKED_BODY_MAX_BYTES) return omittedFile(path, "large");
  if (bytes.includes(0)) return omittedFile(path, "binary");
  return addedFile(path, untrackedDiff(path, bytes.toString("utf8")));
}

export class FlowController {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly #agentCommand: string;
  readonly #agentEnvironment: () => Promise<Record<string, string | undefined>>;
  readonly #broadcast: (event: unknown) => void;
  readonly #journal: Pick<Journal, "write"> | undefined;
  readonly #forge: FlowPrAdapter;
  readonly #forgeTarget: ForgeTarget | undefined;
  readonly #exec: Exec;
  readonly #now: () => number;
  readonly #watchMs: number;
  readonly #analystTimeoutMs: number;
  readonly #goalTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #goalWorkActive: () => string | undefined;

  #session: FlowSession | undefined;
  #history: FlowHistoryEntry[] = [];
  /** The goal text already on disk, or null when goal.md may not match it. */
  #persistedGoal: string | null = null;
  #implementation:
    | { agent: AcpConnection | undefined; activity: string[]; finished: boolean }
    | undefined;
  #goalCreation:
    | { agent: AcpConnection | undefined; activity: string[]; question: FlowQuestion | null }
    | undefined;
  #analyst: AcpConnection | undefined;
  #analystPending = false;
  #conversation: Conversation | undefined;
  #timer: Timer | undefined;
  #ticking = false;
  #tickQueued = false;
  #disposed = false;
  #begun = false;
  #restoring = false;
  #replayWaiters: { send(data: string): unknown }[] = [];
  /** True until Start: a restored session never spawns an analyst by itself. */
  #quiet = false;
  #prBusy = false;
  /** The newest checkpoint tip a busy PR sync must pick up when it finishes. */
  #prPendingTip: string | null = null;
  #decisionsChain: Promise<void> = Promise.resolve();
  #seenCommits = new Set<string>();
  #startedAt: string;
  #restartNotice: string | null = null;

  constructor(options: FlowOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.#agentCommand = options.agentCommand;
    this.#agentEnvironment = options.agentEnvironment;
    this.#broadcast = options.broadcast;
    this.#journal = options.journal;
    this.#forgeTarget = options.forgeTarget;
    this.#commandTimeoutMs = Math.max(1, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    this.#exec = options.exec ?? spawnExec;
    this.#forge = options.forge ?? new CommandFlowForge(this.#exec, {
      timeoutMs: this.#commandTimeoutMs,
    });
    this.#now = options.now ?? Date.now;
    this.#watchMs = Math.max(10, options.watchMs ?? DEFAULT_WATCH_MS);
    this.#analystTimeoutMs = Math.max(10, options.analystTimeoutMs ?? DEFAULT_ANALYST_TIMEOUT_MS);
    this.#goalTimeoutMs = Math.max(10, options.goalTimeoutMs ?? DEFAULT_GOAL_TIMEOUT_MS);
    this.#goalWorkActive = options.goalWorkActive ?? (() => undefined);
    this.#startedAt = nowIso(this.#now);
  }

  /**
   * Restores the persisted session. A dashboard that has not bound its port
   * must never call this: the restore writes state, broadcasts, and starts the
   * worktree watcher, so an abandoned bind attempt would leak a timer and act
   * on a session no client can reach.
   */
  begin(): void {
    if (this.#begun) return;
    this.#begun = true;
    // Restore after the host has finished wiring its own state: a restored
    // session may broadcast before the caller's declarations are initialized.
    queueMicrotask(() => {
      void this.#restore();
    });
  }

  // ---------------------------------------------------------------- paths

  /** `<stateDir>/flow/<24-hex repository key>/<session-id>`. */
  get flowRoot(): string {
    return join(this.stateDir, "flow", journalKey(this.repoDir));
  }

  /** The session directory, or undefined before a session exists. */
  get sessionDir(): string | undefined {
    return this.#session === undefined ? undefined : join(this.flowRoot, this.#session.id);
  }

  #path(name: string): string {
    const directory = this.sessionDir;
    if (directory === undefined) throw new Error("No Flow session exists.");
    return join(directory, name);
  }

  #worktreePath(id: string): string {
    return join(this.repoDir, ".worktree", `flow-${id}`);
  }

  // ------------------------------------------------------------ lifecycle

  /** True while any Flow work is live, for Goal Mode's own guards. */
  hasActiveWork(): boolean {
    return (
      this.#goalCreation !== undefined ||
      this.#implementation !== undefined ||
      this.#analyst !== undefined ||
      this.#conversation !== undefined ||
      this.#prBusy
    );
  }

  /** True while a session exists whose worktree or PR is not merged. */
  hasUnmergedSession(): boolean {
    return this.#session !== undefined && this.#session.status !== "merged";
  }

  #goalWorkLabel(): string | undefined {
    return this.#goalWorkActive();
  }

  snapshot(): FlowSnapshot {
    const session = this.#session;
    const conversation = this.#conversation;
    const creation = this.#goalCreation;
    return {
      sessionId: session?.id ?? null,
      status: session?.status ?? "none",
      goal: session?.goal ?? "",
      decisions: session?.decisions ?? "",
      worktree: session?.worktree ?? null,
      branch: session?.branch ?? null,
      baseRevision: session?.baseRevision ?? null,
      files: session?.files ?? [],
      widgets: session?.widgets ?? [],
      steering: session?.steering ?? [],
      checkpoints: session?.checkpoints ?? [],
      verification: session?.verification ?? null,
      blockers: session?.blockers ?? [],
      pr: session?.pr ?? null,
      prError: session?.prError ?? null,
      leftover: session?.leftover ?? null,
      question: session?.question ?? null,
      goalCreation:
        creation === undefined ? null : { activity: [...creation.activity], question: creation.question },
      conversation:
        conversation === undefined
          ? null
          : {
              widgetId: conversation.widgetId,
              messages: [...conversation.messages],
              activity: [...conversation.activity],
              question: conversation.question,
            },
      activity: this.#implementation === undefined ? [] : [...this.#implementation.activity],
      notice: this.#restartNotice,
      history: [...this.#history],
    };
  }

  /**
   * Sends the complete current Flow state, then the markers and streamed lines
   * a connecting client needs: the session first, then the started marker,
   * every recorded activity line, and the pending question, before the client's
   * own replies. The client resets the matching activity list on each marker.
   */
  replay(target?: { send(data: string): unknown }): void {
    if (this.#restoring) {
      if (target !== undefined) this.#replayWaiters.push(target);
      return;
    }
    // A server with no Flow work sends nothing: the view already starts empty.
    if (
      this.#session === undefined &&
      this.#goalCreation === undefined &&
      this.#conversation === undefined &&
      this.#implementation === undefined
    ) {
      return;
    }
    const snapshot = this.snapshot();
    const deliver = (event: unknown) => {
      if (target === undefined) {
        this.#broadcast(event);
        return;
      }
      try {
        target.send(JSON.stringify(event));
      } catch {
        // The socket closed before it received the event.
      }
    };

    deliver({ type: "flowSnapshot", ...snapshot });
    const session = this.#session;
    if (session !== undefined) {
      if (session.status === "running") {
        deliver({
          type: "flowImplementationStarted",
          sessionId: session.id,
          worktree: session.worktree,
          branch: session.branch,
          baseRevision: session.baseRevision,
        });
      }
      deliver({ type: "flowFiles", files: session.files });
      deliver({ type: "flowWidgets", widgets: session.widgets });
      deliver({ type: "flowSteering", notes: session.steering });
      deliver({ type: "flowDecisions", text: session.decisions });
      deliver({ type: "flowCheckpoints", checkpoints: session.checkpoints });
      deliver({ type: "flowVerification", verification: session.verification });
      deliver({ type: "flowBlockers", blockers: session.blockers });
      deliver({ type: "flowPr", pr: session.pr });
    }

    const creation = this.#goalCreation;
    if (creation !== undefined) {
      deliver({ type: "flowGoalStarted" });
      for (const text of creation.activity) deliver({ type: "flowActivity", text });
      if (creation.question !== null) {
        deliver({
          type: "flowQuestion",
          target: "goal",
          id: creation.question.id,
          message: creation.question.message,
          options: creation.question.options,
        });
      }
    }

    const implementation = this.#implementation;
    if (implementation !== undefined) {
      for (const text of implementation.activity) deliver({ type: "flowActivity", text });
      if (session?.question != null) {
        deliver({
          type: "flowQuestion",
          target: "implementation",
          id: session.question.id,
          message: session.question.message,
          options: session.question.options,
        });
      }
    }

    const conversation = this.#conversation;
    if (conversation !== undefined) {
      deliver({ type: "flowConversationStarted", widgetId: conversation.widgetId });
      for (const message of conversation.messages) {
        deliver({ type: "flowConversationMessage", role: message.role, text: message.text });
      }
      for (const text of conversation.activity) {
        deliver({ type: "flowConversationActivity", text });
      }
      if (conversation.question !== null) {
        deliver({
          type: "flowConversationQuestion",
          id: conversation.question.id,
          message: conversation.question.message,
          options: conversation.question.options,
        });
      }
    }
  }

  #publish(): void {
    // A merge's snapshot is held back only while its cleanup is still running,
    // so "merged" never appears beside work the cleanup is about to remove.
    // Once the cleanup returns a leftover, its retry stays armed but the merged
    // state and the text naming what remains must reach the view.
    if (this.#session?.cleanupPending === true && this.#session.leftover === null) return;
    this.#broadcast({ type: "flowSnapshot", ...this.snapshot() });
  }

  #error(message: string): void {
    this.#broadcast({ type: "flowError", message });
  }

  #notice(message: string): void {
    this.#broadcast({ type: "flowNotice", message });
  }

  // ------------------------------------------------------- persistence

  #sessionFile(session: FlowSession): Record<string, unknown> {
    return { version: 1, ...session };
  }

  #persist(): void {
    const session = this.#session;
    if (session === undefined) return;
    this.#persistSession(session, this.#path("session.json"));
  }

  /** Writes one session's machine state, current or restored, without switching. */
  #persistSession(session: FlowSession, file: string): void {
    session.updatedAt = nowIso(this.#now);
    try {
      writeJson(file, this.#sessionFile(session));
    } catch (error) {
      this.#journal?.write(
        "server-error",
        `flow: could not write session state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Writes the reviewable artifacts beside the session's machine state. */
  #persistArtifacts(): void {
    const session = this.#session;
    if (session === undefined) return;
    try {
      // goal.md is the goal interview's own output channel: while a turn is
      // live, writing the in-memory goal here would overwrite its draft with
      // the previous goal. Outside an interview, write only on a real change.
      if (this.#goalCreation === undefined && this.#persistedGoal !== session.goal) {
        writeText(this.#path("goal.md"), session.goal);
        this.#persistedGoal = session.goal;
      }
      writeText(this.#path("decisions.md"), session.decisions);
      writeJson(this.#path("accepted.json"), { signatures: session.accepted });
      writeJson(this.#path("changes.json"), session.files);
    } catch (error) {
      this.#journal?.write(
        "server-error",
        `flow: could not write session files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #appendSteering(note: FlowSteeringNote): void {
    appendLine(this.#path("steering.jsonl"), note);
    this.#journal?.write(
      "activity",
      `flow steering [${note.source}] ${note.text.slice(0, 200)}`,
    );
  }

  #registerHistory(): void {
    const session = this.#session;
    if (session === undefined || session.status !== "merged") return;
    this.#history = [
      { sessionId: session.id, goal: session.goal, pr: session.pr },
      ...this.#history.filter((entry) => entry.sessionId !== session.id),
    ];
  }

  async #restore(): Promise<void> {
    this.#restoring = true;
    try {
      let entries: string[];
      try {
        entries = readdirSync(this.flowRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return;
      }

      const sessions: { session: FlowSession; directory: string }[] = [];
      for (const id of entries) {
        const directory = join(this.flowRoot, id);
        const stored = readJson<Record<string, unknown>>(join(directory, "session.json"));
        if (stored === undefined || stored.id !== id) continue;
        const session = this.#parseSession(stored, id, directory);
        if (session === undefined) continue;
        sessions.push({ session, directory });
      }
      if (sessions.length === 0) return;

      sessions.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
      // A merge's terminal write makes `pr.state` and `status` agree, so a
      // stored merged request beside any other status can only be an older
      // revision's torn state: finish that merge's cleanup and record it.
      for (const entry of sessions) {
        if (entry.session.pr?.state !== "merged" || entry.session.status === "merged") continue;
        entry.session.status = "merged";
        entry.session.question = null;
        entry.session.cleanupPending = true;
      }
      const merged = sessions.filter((entry) => entry.session.status === "merged");
      this.#history = merged.map((entry) => ({
        sessionId: entry.session.id,
        goal: entry.session.goal,
        pr: entry.session.pr,
      }));
      for (const entry of merged) {
        if (!entry.session.cleanupPending) continue;
        try {
          entry.session.leftover = await this.#cleanupAfterMerge(entry.session);
          entry.session.cleanupPending = entry.session.leftover !== null;
        } catch (error) {
          this.#journal?.write(
            "server-error",
            `flow: could not finish the merge cleanup for ${entry.session.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.#persistSession(entry.session, join(entry.directory, "session.json"));
      }

      const current = sessions.find((entry) => entry.session.status !== "merged");
      if (current === undefined) return;

      const session = current.session;
      // The files beside the machine state are authoritative for the text a
      // developer or agent may have appended while the process was down.
      const storedGoal = readText(join(current.directory, "goal.md"));
      if (storedGoal !== undefined) session.goal = storedGoal;
      this.#persistedGoal = storedGoal ?? null;
      session.decisions = readText(join(current.directory, "decisions.md")) ?? session.decisions;
      const acks = new Set(
        readJsonLines<{ id?: unknown } | string>(join(current.directory, "steering-ack.jsonl")).map(
          (entry) => (typeof entry === "string" ? entry : String(entry.id ?? "")),
        ),
      );
      session.steering = session.steering.map((note) =>
        acks.has(note.id) ? { ...note, status: "read" } : note,
      );
      const verification = readJson<FlowVerification>(join(current.directory, "verification.json"));
      if (verification !== undefined && typeof verification.status === "string") {
        session.verification = verification;
      }
      const storedCheckpoints = readJsonLines<FlowCheckpoint>(
        join(current.directory, "checkpoints.jsonl"),
      );
      for (const entry of storedCheckpoints) {
        if (typeof entry.commit !== "string") continue;
        if (!session.checkpoints.some((candidate) => candidate.commit === entry.commit)) {
          session.checkpoints.push(entry);
        }
      }

      const wasRunning = session.status === "running";
      session.status = wasRunning ? "stopped" : session.status === "idle" ? "idle" : session.status;
      session.question = null;
      this.#session = session;
      for (const checkpoint of session.checkpoints) this.#seenCommits.add(checkpoint.commit);
      this.#persist();

      if (wasRunning) {
        this.#restartNotice =
          "The server restarted, so the Flow implementation stopped. Start it again to resume.";
        this.#broadcast({ type: "flowNotice", message: this.#restartNotice });
      }

      // Widgets are recomputed from the worktree without spawning a peer.
      if (existsSync(session.worktree)) {
        const files = await this.#computeDiff(session);
        if (files !== undefined) {
          session.files = files;
          const raw = readJson<{ widgets?: RawWidget[] }>(join(current.directory, "widgets.json"));
          session.widgets = this.#reconcile(
            raw !== null && typeof raw === "object" && Array.isArray(raw.widgets)
              ? raw.widgets
              : this.#widgetsAsRaw(session.widgets),
            files,
            session,
          );
          session.lastDiffHash = diffHash(files);
          this.#persist();
          this.#persistArtifacts();
        }
      }
      this.#publish();
      this.#emitSections({ files: true, widgets: true });
      this.#quiet = true;
      if (session.status !== "merged") this.#startWatchdog();
    } finally {
      this.#restoring = false;
      const waiters = this.#replayWaiters;
      this.#replayWaiters = [];
      for (const waiter of waiters) this.replay(waiter);
    }
  }

  #parseSession(
    stored: Record<string, unknown>,
    id: string,
    directory: string,
  ): FlowSession | undefined {
    if (typeof stored.worktree !== "string" || typeof stored.branch !== "string") return undefined;
    const status = stored.status;
    if (
      status !== "idle" &&
      status !== "running" &&
      status !== "stopped" &&
      status !== "merged"
    ) {
      return undefined;
    }
    const array = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    const pre = (): FlowSession => ({
      id,
      baseRevision: typeof stored.baseRevision === "string" ? stored.baseRevision : null,
      worktree: stored.worktree as string,
      branch: stored.branch as string,
      status,
      goal: typeof stored.goal === "string" ? stored.goal : "",
      decisions: typeof stored.decisions === "string" ? stored.decisions : "",
      steering: array<FlowSteeringNote>(stored.steering),
      accepted: array<string>(stored.accepted),
      widgets: array<FlowWidget>(stored.widgets),
      files: array<FlowFile>(stored.files),
      checkpoints: array<FlowCheckpoint>(stored.checkpoints),
      verification:
        typeof stored.verification === "object" && stored.verification !== null
          ? (stored.verification as FlowVerification)
          : null,
      blockers: array<FlowBlocker>(stored.blockers),
      pr:
        typeof stored.pr === "object" && stored.pr !== null ? (stored.pr as FlowPr) : null,
      prError: typeof stored.prError === "string" ? stored.prError : null,
      leftover: typeof stored.leftover === "string" ? stored.leftover : null,
      cleanupPending: stored.cleanupPending === true,
      question: null,
      pushedTip: typeof stored.pushedTip === "string" ? stored.pushedTip : null,
      prFailedTip: typeof stored.prFailedTip === "string" ? stored.prFailedTip : null,
      lastDiffHash: typeof stored.lastDiffHash === "string" ? stored.lastDiffHash : null,
      createdAt:
        typeof stored.createdAt === "string"
          ? stored.createdAt
          : (readText(join(directory, "session.json")) === undefined ? this.#startedAt : this.#startedAt),
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : this.#startedAt,
    });
    return pre();
  }

  #widgetsAsRaw(widgets: FlowWidget[]): RawWidget[] {
    return widgets.map((widget) => ({
      category: widget.category,
      concept: widget.concept,
      summary: widget.summary,
      rationale: widget.rationale,
      files: widget.files,
    }));
  }

  /**
   * The pids, commands, and working directories a replacement needs to prove
   * and end the peers this process leaves behind. Every peer is live: a field
   * cleared by disposal or a finished turn contributes nothing.
   */
  children(): RecordedChild[] {
    const children: RecordedChild[] = [];
    const remember = (agent: AcpConnection | undefined, cwd: string) => {
      const pid = agent?.pid;
      if (agent === undefined || pid === undefined) return;
      children.push({ pid, argv: agent.argv, cwd });
    };
    const worktree = this.#session?.worktree;
    if (worktree !== undefined) remember(this.#implementation?.agent, worktree);
    remember(this.#goalCreation?.agent, this.repoDir);
    remember(this.#analyst, this.repoDir);
    remember(this.#conversation?.agent, this.repoDir);
    return children;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#implementation?.agent?.close();
    this.#implementation = undefined;
    this.#goalCreation?.agent?.close();
    this.#goalCreation = undefined;
    this.#analyst?.close();
    this.#analyst = undefined;
    this.#conversation?.agent?.close();
    this.#conversation = undefined;
  }

  // -------------------------------------------------------------- commands

  async createGoal(): Promise<void> {
    const goalWork = this.#goalWorkLabel();
    if (goalWork !== undefined) {
      this.#error(`Goal Mode is active (${goalWork}). Stop it before starting Flow work.`);
      return;
    }
    if (this.#implementation !== undefined) {
      this.#error("The Flow implementation is running. Stop it before creating a new goal.");
      return;
    }
    if (this.#goalCreation !== undefined) {
      this.#error("A Flow goal creation is already active.");
      return;
    }

    if (this.#session === undefined || this.#session.status === "merged") {
      await this.#newSession();
      if (this.#session === undefined) return;
    }

    const creation = { agent: undefined, activity: [] as string[], question: null };
    this.#goalCreation = creation;
    this.#broadcast({ type: "flowGoalStarted" });
    this.#publish();
    await this.#spawnGoalCreation(creation);
  }

  async #newSession(): Promise<void> {
    const root = this.flowRoot;
    mkdirSync(root, { recursive: true });
    let id = randomUUID().replace(/-/g, "").slice(0, 8);
    while (existsSync(join(root, id))) id = randomUUID().replace(/-/g, "").slice(0, 8);
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    const session: FlowSession = {
      id,
      baseRevision: null,
      worktree: this.#worktreePath(id),
      branch: `flow/${id}`,
      status: "idle",
      goal: "",
      decisions: "",
      steering: [],
      accepted: [],
      widgets: [],
      files: [],
      checkpoints: [],
      verification: null,
      blockers: [],
      pr: null,
      prError: null,
      leftover: null,
      cleanupPending: false,
      question: null,
      pushedTip: null,
      prFailedTip: null,
      lastDiffHash: null,
      createdAt: nowIso(this.#now),
      updatedAt: nowIso(this.#now),
    };
    this.#session = session;
    this.#persistedGoal = null;
    this.#persist();
    this.#persistArtifacts();
  }

  async #spawnGoalCreation(creation: {
    agent: AcpConnection | undefined;
    activity: string[];
    question: FlowQuestion | null;
  }): Promise<void> {
    const directory = this.sessionDir;
    if (directory === undefined) return;
    // Drop the previous interview's goal first: only a file this turn writes
    // may be accepted, never a draft an interrupted peer or an earlier
    // interview left behind.
    const goalPath = join(directory, "goal.md");
    try {
      unlinkSync(goalPath);
    } catch {
      // No goal file exists yet.
    }
    this.#persistedGoal = null;
    try {
      const env = await this.#agentEnvironment();
      // A disposal during provider selection clears the interview; no peer may
      // be constructed for an owner that is gone.
      if (this.#goalCreation !== creation) return;
      const agent = new AcpConnection({
        command: this.#agentCommand,
        cwd: this.repoDir,
        env,
        onActivity: (activity: AcpActivity) => {
          if (this.#goalCreation !== creation) return;
          const append = activity.append && creation.activity.length > 0;
          if (append) creation.activity[creation.activity.length - 1] += activity.text;
          else creation.activity.push(activity.text);
          this.#broadcast({ type: "flowActivity", text: activity.text, append });
        },
        onQuestion: (question: AcpQuestion) => {
          if (this.#goalCreation !== creation) return;
          creation.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          this.#journal?.write("question", question.message, "flow:goal");
          this.#broadcast({
            type: "flowQuestion",
            target: "goal",
            id: question.id,
            message: question.message,
            options: question.options,
          });
        },
        onStderr: (text) => this.#journal?.write("acp-stderr", text),
      });
      if (this.#goalCreation !== creation) {
        agent.close();
        return;
      }
      creation.agent = agent;
      // A timeout is its own outcome: an interrupted interview is never an
      // accepted goal, and its peer is closed before anything is read.
      const turn = agent
        .run(`/flow-goal ${directory}`)
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const outcome = await Promise.race([
        turn,
        timeout(this.#goalTimeoutMs).then(() => ({ timedOut: true as const })),
      ]);
      if (this.#goalCreation !== creation) return;
      if ("timedOut" in outcome) {
        this.#error(`The Flow goal interview timed out after ${this.#goalTimeoutMs / 1000} s.`);
        this.#finishGoalCreation(false);
        return;
      }
      if (!outcome.ok) throw outcome.error;
      this.#finishGoalCreation(true);
    } catch (error) {
      if (this.#goalCreation !== creation) return;
      this.#error(error instanceof Error ? error.message : String(error));
      this.#finishGoalCreation(false);
    }
  }

  #finishGoalCreation(readFile: boolean): void {
    const creation = this.#goalCreation;
    const session = this.#session;
    if (creation === undefined || session === undefined) return;
    this.#goalCreation = undefined;
    creation.question = null;
    creation.agent?.close();

    const goalPath = this.#path("goal.md");
    const text = readFile ? readText(goalPath) : undefined;
    if (text === undefined || text.trim().length === 0) {
      if (readFile) this.#error("The Flow goal interview wrote no goal.");
      // A failed or interrupted interview must not leave its truncated draft
      // where the session's accepted goal belongs.
      this.#persistArtifacts();
      this.#broadcast({ type: "flowGoalStopped", completed: false });
      this.#publish();
      return;
    }
    session.goal = text;
    this.#persist();
    this.#persistArtifacts();
    this.#broadcast({ type: "flowGoalStopped", completed: true, text });
    this.#publish();
  }

  saveGoal(text: unknown): void {
    if (typeof text !== "string") {
      this.#error("saveFlowGoal needs the goal text.");
      return;
    }
    if (this.#implementation !== undefined) {
      this.#error("The Flow implementation is running. Stop it before editing the goal.");
      return;
    }
    if (this.#goalCreation !== undefined) {
      // The interview's goal.md is the accepted text, so a save here would be
      // acknowledged and then replaced when the interview finishes.
      this.#error("The Flow goal interview is active. Finish it before editing the goal.");
      return;
    }
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    session.goal = text;
    this.#persist();
    this.#persistArtifacts();
    this.#publish();
  }

  async startImplementation(): Promise<void> {
    const goalWork = this.#goalWorkLabel();
    if (goalWork !== undefined) {
      this.#error(`Goal Mode is active (${goalWork}). Stop it before starting Flow work.`);
      return;
    }
    const session = this.#session;
    if (session === undefined) {
      this.#error("Create a Flow goal before starting the implementation.");
      return;
    }
    if (session.status === "merged" || session.pr?.state === "merged") {
      const mergedPr = session.pr?.state === "merged" ? session.pr : null;
      this.#error(
        mergedPr === null
          ? "This Flow session is merged. Create a new Flow goal to start again."
          : `The pull request #${mergedPr.number} (${mergedPr.url}) is already merged, so this Flow session cannot start again. Create a new Flow goal.`,
      );
      return;
    }
    if (this.#goalCreation !== undefined) {
      this.#error("The Flow goal interview is active.");
      return;
    }
    if (session.goal.trim().length === 0) {
      this.#error("The Flow goal is empty.");
      return;
    }
    if (this.#implementation !== undefined) {
      this.#error("The Flow implementation is already running.");
      return;
    }

    const activity: string[] = [];
    const implementation = { agent: undefined as AcpConnection | undefined, activity, finished: false };
    // Claim the slot before the first await. The base fetch and the worktree
    // check are asynchronous, and a second Start that lands inside them would
    // otherwise pass the guard and spawn a second peer in the same worktree.
    this.#implementation = implementation;

    const base = await this.#resolveBase();
    if (base === undefined) {
      if (this.#implementation === implementation) this.#implementation = undefined;
      this.#error("Could not start the Flow implementation: neither origin/main nor main exists.");
      return;
    }
    if (session.baseRevision === null) session.baseRevision = base;

    const created = await this.#ensureWorktree(session, base);
    if (!created) {
      if (this.#implementation === implementation) this.#implementation = undefined;
      return;
    }
    // Stop or dispose released the claim while the worktree was being
    // prepared; no peer may start without holding the slot.
    if (this.#implementation !== implementation) return;

    this.#quiet = false;
    session.status = "running";
    this.#restartNotice = null;
    this.#persist();
    this.#broadcast({
      type: "flowImplementationStarted",
      sessionId: session.id,
      worktree: session.worktree,
      branch: session.branch,
      baseRevision: session.baseRevision,
    });
    this.#publish();
    this.#startWatchdog();
    void this.#tick();

    const directory = this.sessionDir;
    if (directory === undefined) return;
    try {
      const env = await this.#agentEnvironment();
      // Stop or dispose during provider selection already released the claim;
      // no peer may be constructed for an implementation that no longer owns
      // the worktree.
      if (this.#implementation !== implementation) return;
      const agent = new AcpConnection({
        command: this.#agentCommand,
        cwd: session.worktree,
        env,
        onActivity: (update: AcpActivity) => {
          if (this.#implementation !== implementation) {
            implementation.agent?.close();
            return;
          }
          const append = update.append && activity.length > 0;
          if (append) activity[activity.length - 1] += update.text;
          else activity.push(update.text);
          this.#broadcast({ type: "flowActivity", text: update.text, append });
          if (update.text.includes(BLOCKER_MARKER)) {
            for (const line of activity) {
              const marker = line.indexOf(BLOCKER_MARKER);
              if (marker >= 0) this.#addBlocker(line.slice(marker + BLOCKER_MARKER.length).trim());
            }
          }
        },
        onQuestion: (question: AcpQuestion) => {
          if (this.#implementation !== implementation) {
            implementation.agent?.close();
            return;
          }
          session.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          this.#persist();
          this.#broadcast({
            type: "flowQuestion",
            target: "implementation",
            id: question.id,
            message: question.message,
            options: question.options,
          });
        },
        onStderr: (text) => this.#journal?.write("acp-stderr", text),
      });
      if (this.#implementation !== implementation) {
        agent.close();
        return;
      }
      implementation.agent = agent;
      await agent.run(`/flow-implement ${directory}`);
      if (this.#implementation !== implementation) {
        agent.close();
        return;
      }
      implementation.finished = true;
      this.#finishImplementation();
    } catch (error) {
      if (this.#implementation !== implementation) {
        implementation.agent?.close();
        return;
      }
      this.#error(error instanceof Error ? error.message : String(error));
      this.#finishImplementation();
    }
  }

  #finishImplementation(): void {
    const implementation = this.#implementation;
    const session = this.#session;
    if (implementation === undefined) return;
    this.#implementation = undefined;
    implementation.agent?.close();
    implementation.agent = undefined;
    if (session !== undefined && session.status === "running") {
      session.status = "stopped";
      session.question = null;
      this.#persist();
    }
    this.#broadcast({ type: "flowStopped" });
    this.#publish();
    // One last look at what the turn left behind, then the watcher idles.
    void this.#tick();
  }

  stopImplementation(): void {
    const implementation = this.#implementation;
    if (implementation === undefined) {
      this.#error("The Flow implementation is not running.");
      return;
    }
    this.#finishImplementation();
  }

  // ------------------------------------------------------------- worktree

  #git(cwd: string, args: string[]): Promise<CommandResult> {
    return this.#exec("git", args, {
      cwd,
      env: { ...(process.env as Record<string, string>), ...GIT_ENV },
      timeout: this.#commandTimeoutMs,
    }).then(
      (result) => result,
      (error) => ({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: -1,
      }),
    );
  }

  async #resolveBase(): Promise<string | undefined> {
    await this.#git(this.repoDir, ["fetch", "origin", "main"]);
    for (const ref of ["origin/main", "main"]) {
      const result = await this.#git(this.repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
      const revision = result.stdout.trim();
      if (result.code === 0 && revision.length > 0) return revision;
    }
    return undefined;
  }

  async #ensureWorktree(session: FlowSession, base: string): Promise<boolean> {
    if (existsSync(session.worktree)) {
      const inside = await this.#git(session.worktree, ["rev-parse", "--show-toplevel"]);
      if (inside.code === 0) return true;
    }
    mkdirSync(join(this.repoDir, ".worktree"), { recursive: true });
    const branch = await this.#git(this.repoDir, [
      "rev-parse",
      "--verify",
      `refs/heads/${session.branch}`,
    ]);
    const added =
      branch.code === 0
        ? await this.#git(this.repoDir, ["worktree", "add", session.worktree, session.branch])
        : await this.#git(this.repoDir, [
            "worktree",
            "add",
            "-b",
            session.branch,
            session.worktree,
            base,
          ]);
    if (added.code !== 0) {
      this.#error(
        `Could not create the Flow worktree: ${added.stderr.trim() || `exit code ${added.code}`}`,
      );
      return false;
    }
    return true;
  }

  async #isClean(worktree: string): Promise<boolean> {
    const result = await this.#git(worktree, ["status", "--porcelain"]);
    if (result.code !== 0) return false;
    return result.stdout.trim().length === 0;
  }

  // ------------------------------------------------------------ watcher

  #startWatchdog(): void {
    if (this.#timer !== undefined || this.#disposed) return;
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#watchMs);
  }

  #stopWatchdog(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    if (this.#ticking) {
      this.#tickQueued = true;
      return;
    }
    this.#ticking = true;
    try {
      const session = this.#session;
      if (session === undefined || session.status === "merged") {
        this.#stopWatchdog();
        return;
      }
      if (!existsSync(session.worktree)) return;

      await this.#syncCheckpoints(session);
      const files = await this.#computeDiff(session);
      if (files === undefined) return;
      const hash = diffHash(files);
      const changed = hash !== session.lastDiffHash;
      session.files = files;
      if (changed && files.length === 0) {
        session.widgets = [];
        session.accepted = [];
        this.#broadcast({ type: "flowWidgets", widgets: [] });
      }
      if (changed) {
        session.lastDiffHash = hash;
        this.#persist();
        this.#broadcast({ type: "flowFiles", files });
      }
      this.#persistArtifacts();
      if (changed && session.files.length > 0) {
        if (this.#quiet) {
          // A restored session recomputes its review list without spawning a
          // peer; the analyst runs again only after the implementation starts.
          session.widgets = this.#reconcile([], session.files, session);
          session.accepted = session.accepted.filter((signature) =>
            session.widgets.some((widget) => widget.id === signature),
          );
          this.#persist();
          this.#persistArtifacts();
          this.#broadcast({ type: "flowWidgets", widgets: session.widgets });
        } else {
          this.#scheduleAnalysis();
        }
      }
      this.#syncSteeringAcks(session);
      this.#syncVerification(session);
      this.#syncBlockers(session);
      if (changed) this.#publish();
    } finally {
      this.#ticking = false;
      if (this.#tickQueued) {
        this.#tickQueued = false;
        void this.#tick();
      }
    }
  }

  async #computeDiff(session: FlowSession): Promise<FlowFile[] | undefined> {
    if (session.baseRevision === null) return undefined;
    const base = session.baseRevision;
    const tracked = await this.#git(session.worktree, ["diff", "--no-color", "--no-ext-diff", base, "--"]);
    if (tracked.code !== 0) return undefined;
    const status = await this.#git(session.worktree, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.code !== 0) return undefined;

    const files = new Map<string, FlowFile>();
    for (const file of diffFiles(tracked.stdout)) files.set(file.path, file);

    for (const entry of parseStatusZ(status.stdout)) {
      if (entry.status === "untracked") {
        if (files.has(entry.path)) continue;
        const file = untrackedFile(session.worktree, entry.path);
        if (file === undefined) continue;
        files.set(entry.path, file);
        continue;
      }
      const existing = files.get(entry.path);
      if (existing === undefined) continue;
      if (entry.status === "added" || entry.status === "deleted" || entry.status === "renamed") {
        existing.status = entry.status;
      }
    }

    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  #scheduleAnalysis(): void {
    if (this.#analystPending) return;
    if (this.#analyst !== undefined) {
      this.#analystPending = true;
      return;
    }
    this.#startAnalyst();
  }

  /**
   * Starts one analyst turn whose rejection is always observed. A throw out of
   * `#runAnalyst` must never reach Bun's unhandled-rejection process exit.
   */
  #startAnalyst(): void {
    void this.#runAnalyst().catch((error) => {
      this.#journal?.write(
        "server-error",
        `flow analyst failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async #runAnalyst(): Promise<void> {
    const session = this.#session;
    const directory = this.sessionDir;
    if (session === undefined || directory === undefined) return;
    const files = session.files;
    if (files.length === 0) return;

    const request = {
      goal: session.goal,
      decisions: session.decisions,
      files: files.map((file) => ({
        path: file.path,
        status: file.status,
        insertions: file.insertions,
        deletions: file.deletions,
        diff: file.diff,
      })),
      previous: session.widgets,
    };
    // Every file this turn reads and writes belongs to the session captured at
    // entry. A merge followed by createGoal replaces `#session` while the turn
    // is live; `#path` would then address the replacement's directory.
    const requestPath = join(directory, "request.json");
    const widgetsPath = join(directory, "widgets.json");
    writeJson(requestPath, request);
    // A stale result must never be mistaken for this run's answer.
    try {
      writeFileSync(widgetsPath, "");
    } catch {
      // The directory is gone; the run below reports it.
    }

    const context = [
      "Session goal:",
      session.goal,
      "",
      "Decision board:",
      session.decisions,
      "",
      "Previous widget list:",
      JSON.stringify(session.widgets),
      "",
      "Current diff:",
      ...files.map((file) =>
        [
          `--- ${file.path} (${file.status}, +${file.insertions} -${file.deletions}) ---`,
          file.diff,
        ].join("\n"),
      ),
      "",
      "The same data is in request.json in the session directory.",
      "Write the complete widget list to widgets.json in the session directory.",
    ].join("\n");

    const started = Date.now();
    let agent: AcpConnection | undefined;
    let bindingFailure: string | undefined;
    try {
      // Provider selection refuses before any peer exists when no subscription
      // can serve it. That refusal belongs to this turn, never to the process.
      const env = await this.#agentEnvironment();
      // Disposal during provider selection ends the controller; a peer started
      // now would have no owner left to close it.
      if (this.#disposed) return;
      agent = new AcpConnection({
        command: this.#agentCommand,
        cwd: this.repoDir,
        env,
        onActivity: () => {},
        onQuestion: (question) => {
          agent?.answer(question.id, question.options[0]?.label ?? "Continue");
        },
        onStderr: (text) => this.#journal?.write("acp-stderr", text),
      });
      if (this.#disposed) return;
      this.#analyst = agent;
      await Promise.race([
        agent.run(`/flow-change ${directory}\n\n${context}`),
        timeout(this.#analystTimeoutMs),
      ]);
    } catch (error) {
      if (this.#disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#journal?.write("server-error", `flow analyst failed: ${message}`);
      // A binding failure has no peer to close and no turn to blame; the
      // fallback below reports it once, like a failed analyst result.
      if (agent === undefined) bindingFailure = message;
    } finally {
      agent?.close();
      this.#analyst = undefined;
    }

    const elapsed = Date.now() - started;
    const timedOut = elapsed >= this.#analystTimeoutMs - 5;
    const answer = readJson<{ widgets?: unknown }>(widgetsPath);
    if (this.#session !== session) {
      // The turn outlived its session. Its answer belongs to the session it
      // analyzed, so persisting or broadcasting it would attach stale widgets
      // to the replacement. The pending tick, if any, now belongs to the new
      // session and gets its own turn.
      if (this.#analystPending) {
        this.#analystPending = false;
        this.#startAnalyst();
      }
      return;
    }
    const raw =
      answer !== null && typeof answer === "object" && Array.isArray(answer.widgets)
        ? (answer.widgets as RawWidget[])
        : undefined;
    const validated = raw === undefined ? undefined : this.#validateWidgets(raw, session.files);
    if (validated === undefined) {
      this.#error(
        bindingFailure !== undefined
          ? `The Flow analyst could not start: ${bindingFailure}. Every changed file is shown as a structure change.`
          : timedOut
            ? "The Flow analyst timed out; every changed file is shown as a structure change."
            : "The Flow analyst returned no valid widget list; every changed file is shown as a structure change.",
      );
      session.widgets = this.#reconcile([], session.files, session);
      session.accepted = session.accepted.filter((signature) =>
        session.widgets.some((widget) => widget.id === signature),
      );
      writeJson(widgetsPath, { widgets: this.#widgetsAsRaw(session.widgets) });
      this.#persist();
      this.#persistArtifacts();
      this.#broadcast({ type: "flowWidgets", widgets: session.widgets });
      this.#publish();
    } else {
      session.widgets = this.#reconcile(validated, session.files, session);
      session.accepted = session.accepted.filter((signature) =>
        session.widgets.some((widget) => widget.id === signature),
      );
      this.#persist();
      this.#persistArtifacts();
      this.#broadcast({ type: "flowWidgets", widgets: session.widgets });
      this.#publish();
    }

    if (this.#analystPending) {
      this.#analystPending = false;
      this.#startAnalyst();
    }
  }

  #validateWidgets(raw: RawWidget[], files: FlowFile[]): RawWidget[] | undefined {
    const paths = new Set(files.map((file) => file.path));
    const widgets: RawWidget[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const category = entry.category;
      const concept = entry.concept;
      const summary = entry.summary;
      const rationale = entry.rationale;
      const listed = entry.files;
      if (typeof category !== "string" || !CATEGORY_SET.has(category)) return undefined;
      if (typeof concept !== "string" || concept.trim().length === 0) return undefined;
      if (typeof summary !== "string" || summary.trim().length === 0) return undefined;
      if (typeof rationale !== "string" || rationale.trim().length === 0) return undefined;
      if (!Array.isArray(listed) || listed.length === 0) return undefined;
      if (!listed.every((path) => typeof path === "string")) return undefined;
      if (!listed.every((path) => paths.has(path))) return undefined;
      widgets.push({
        category,
        concept,
        summary,
        rationale,
        files: [...new Set(listed as string[])],
      });
    }
    return widgets;
  }

  #reconcile(raw: RawWidget[], files: FlowFile[], session: FlowSession): FlowWidget[] {
    const diffs = new Map(files.map((file) => [file.path, file.diff]));
    const byPath = new Map(files.map((file) => [file.path, file]));
    const widgets: FlowWidget[] = [];
    const covered = new Set<string>();
    const accepted = new Set(session.accepted);

    for (const entry of raw) {
      if (typeof entry.category !== "string" || !CATEGORY_SET.has(entry.category)) continue;
      const paths = entry.files.filter((path) => byPath.has(path));
      if (paths.length === 0) continue;
      const signature = widgetSignature(entry.category, paths, diffs);
      for (const path of paths) covered.add(path);
      if (widgets.some((widget) => widget.id === signature)) continue;
      widgets.push({
        id: signature,
        category: entry.category as FlowCategory,
        concept: entry.concept,
        summary: entry.summary,
        rationale: entry.rationale,
        files: [...new Set(paths)].sort(),
        accepted: accepted.has(signature),
      });
    }

    for (const file of files) {
      if (covered.has(file.path)) continue;
      const signature = widgetSignature("structure", [file.path], diffs);
      if (widgets.some((widget) => widget.id === signature)) continue;
      widgets.push({
        id: signature,
        category: "structure",
        concept: file.path,
        summary: `Changed file ${file.path}`,
        rationale: "No change widget named this file, so it is shown as a structure change.",
        files: [file.path],
        accepted: accepted.has(signature),
      });
    }

    return widgets;
  }

  // -------------------------------------------------------- checkpoints

  async #syncCheckpoints(session: FlowSession): Promise<void> {
    if (session.baseRevision === null) return;
    const log = await this.#git(session.worktree, [
      "log",
      "--reverse",
      "--format=%H%x1f%s%x1f%cI",
      `${session.baseRevision}..HEAD`,
    ]);
    if (log.code !== 0) return;
    const commits = log.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [hash, subject, timestamp] = line.split("\x1f");
        return { hash: hash ?? "", subject: subject ?? "", timestamp: timestamp ?? "" };
      })
      .filter((entry) => entry.hash.length > 0);
    if (commits.length === 0) return;

    const recorded = readJsonLines<Partial<FlowCheckpoint>>(this.#path("checkpoints.jsonl"));
    let added = false;
    for (const commit of commits) {
      const short = commit.hash.slice(0, 7);
      if (session.checkpoints.some((entry) => entry.commit === short)) continue;
      const match = recorded.find(
        (entry) => typeof entry.commit === "string" && commit.hash.startsWith(entry.commit),
      );
      if (match !== undefined) {
        const entry: FlowCheckpoint = {
          id: typeof match.id === "string" ? match.id : `checkpoint-${short}`,
          timestamp: typeof match.timestamp === "string" ? match.timestamp : commit.timestamp,
          summary: typeof match.summary === "string" ? match.summary : commit.subject,
          files: typeof match.files === "number" ? match.files : 0,
          commit: short,
          verification: verificationStatus(match.verification),
        };
        session.checkpoints.push(entry);
      } else {
        const changed = await this.#git(session.worktree, [
          "show",
          "--name-only",
          "--format=",
          commit.hash,
        ]);
        const fileCount = changed.stdout.split("\n").filter((line) => line.trim().length > 0).length;
        session.checkpoints.push({
          id: `checkpoint-${short}`,
          timestamp: commit.timestamp,
          summary: commit.subject,
          files: fileCount,
          commit: short,
          verification: session.verification?.status ?? STALE_VERIFICATION,
        });
      }
      this.#seenCommits.add(short);
      added = true;
    }

    if (added) {
      this.#persist();
      this.#broadcast({ type: "flowCheckpoints", checkpoints: session.checkpoints });
    }

    const tip = commits[commits.length - 1]?.hash ?? null;
    if (tip !== null && tip !== session.pushedTip && session.prFailedTip !== tip) {
      await this.#syncPullRequest(session, tip);
    }
  }

  // --------------------------------------------------------------- forge

  async #syncPullRequest(session: FlowSession, tip: string): Promise<void> {
    if (this.#prBusy) {
      // A checkpoint that lands during a push is not dropped: the running sync
      // picks up the newest tip when it finishes.
      this.#prPendingTip = tip;
      return;
    }
    this.#prBusy = true;
    try {
      const pushed = await this.#git(session.worktree, ["push", "origin", session.branch]);
      if (pushed.code !== 0) {
        session.prFailedTip = tip;
        session.prError = pushed.stderr.trim() || `exit code ${pushed.code}`;
        this.#persist();
        this.#error(`Could not push ${session.branch}: ${session.prError}`);
        this.#publish();
        return;
      }

      const target = await this.#target();
      if (target === undefined) {
        session.prFailedTip = tip;
        session.prError = "The origin remote does not name a supported repository.";
        this.#persist();
        this.#error(session.prError);
        this.#publish();
        return;
      }

      const input = {
        cwd: this.repoDir,
        target,
        head: session.branch,
        base: "main",
        title: prTitle(session.goal),
        body: prBody(session.goal, session.decisions),
      };

      if (session.pr === null || session.pr.state === "error") {
        const created = await this.#forge.createDraft(input);
        session.pr = {
          forge: target.forge,
          number: created.number,
          url: created.url,
          state: "draft",
        };
        this.#broadcast({ type: "flowPr", pr: session.pr });
      } else {
        await this.#forge.update({ ...input, number: session.pr.number });
        if (session.pr.state === "draft") {
          session.pr = { ...session.pr, url: session.pr.url };
        }
      }
      session.prError = null;
      session.prFailedTip = null;
      session.pushedTip = tip;
      this.#persist();
      this.#broadcast({ type: "flowPr", pr: session.pr });
      this.#publish();
    } catch (error) {
      session.prFailedTip = tip;
      session.prError = error instanceof Error ? error.message : String(error);
      this.#persist();
      this.#error(session.prError);
      this.#publish();
    } finally {
      this.#prBusy = false;
      const pending = this.#prPendingTip;
      this.#prPendingTip = null;
      if (pending !== null && pending !== session.pushedTip) {
        void this.#syncPullRequest(session, pending);
      }
    }
  }

  async #target(): Promise<ForgeTarget | undefined> {
    if (this.#forgeTarget !== undefined) return this.#forgeTarget;
    const remote = await this.#git(this.repoDir, ["remote", "get-url", "origin"]);
    if (remote.code !== 0) return undefined;
    return classifyOrigin(remote.stdout);
  }

  async retryPr(): Promise<void> {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    if (session.prFailedTip !== null) {
      const tip = session.prFailedTip;
      session.prFailedTip = null;
      await this.#syncPullRequest(session, tip);
      return;
    }
    this.#error("There is no failed pull request to retry.");
  }

  async markPrReady(): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.pr === null) {
      this.#error("No Flow pull request exists.");
      return;
    }
    if (this.#implementation !== undefined) {
      this.#error("Stop the Flow implementation before marking the pull request ready.");
      return;
    }
    if (session.pr.state !== "draft") {
      this.#error("Only a draft pull request can be marked ready.");
      return;
    }
    if (!(await this.#isClean(session.worktree))) {
      this.#error("Commit or discard the Flow worktree changes before marking the pull request ready.");
      return;
    }
    const target = await this.#target();
    if (target === undefined) {
      this.#error("The origin remote does not name a supported repository.");
      return;
    }
    try {
      await this.#forge.markReady(this.repoDir, target, session.pr.number);
      const state = await this.#forge.view(this.repoDir, target, session.pr.number);
      session.pr = {
        ...session.pr,
        url: state.url,
        state: state.state === "merged" ? "merged" : state.draft ? "draft" : "live",
      };
      this.#persist();
      this.#broadcast({ type: "flowPr", pr: session.pr });
      this.#publish();
    } catch (error) {
      this.#error(error instanceof Error ? error.message : String(error));
    }
  }

  async mergePr(): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.pr === null) {
      this.#error("No Flow pull request exists.");
      return;
    }
    if (this.#implementation !== undefined) {
      this.#error("Stop the Flow implementation before merging the pull request.");
      return;
    }
    const goalWork = this.#goalWorkLabel();
    if (goalWork !== undefined) {
      this.#error(`Goal Mode is active (${goalWork}). Stop it before merging the Flow pull request.`);
      return;
    }
    if (session.pr.state !== "live") {
      this.#error("Only a live pull request can be merged.");
      return;
    }
    if (!(await this.#isClean(session.worktree))) {
      this.#error("Commit or discard the Flow worktree changes before merging.");
      return;
    }
    const target = await this.#target();
    if (target === undefined) {
      this.#error("The origin remote does not name a supported repository.");
      return;
    }

    try {
      // The forge is the authority on the request's current state: a request
      // closed or reopened elsewhere is never merged on stale local state.
      const current = await this.#forge.view(this.repoDir, target, session.pr.number);
      if (current.state === "merged") {
        // A previous merge reached the forge but not this session's state:
        // adopt it instead of refusing the only local recovery path.
        this.#adoptMerge(session, session.pr, current.url);
      } else if (current.state !== "open" || current.draft) {
        this.#error("The pull request is not an open, live pull request.");
        return;
      } else {
        await this.#forge.merge(this.repoDir, target, session.pr.number);
        // The successful merge call is the authority. The confirming read
        // only refreshes the URL: a failed or lagging read must not leave the
        // forge merged while this session stays live and unmergeable.
        let url = session.pr.url;
        try {
          url = (await this.#forge.view(this.repoDir, target, session.pr.number)).url;
        } catch {
          // The merge itself succeeded; only the optional URL refresh was lost.
        }
        this.#adoptMerge(session, session.pr, url);
      }
    } catch (error) {
      this.#error(error instanceof Error ? error.message : String(error));
      return;
    }

    const leftover = await this.#cleanupAfterMerge(session);
    session.leftover = leftover;
    // A cleanup that left something keeps the retry armed: the next restore
    // finds the merged session still owed its worktree and branches. Only a
    // cleanup with nothing left releases it.
    session.cleanupPending = leftover !== null;
    this.#persist();
    if (leftover !== null) {
      this.#error(
        `The merge completed, but cleanup left ${leftover}. It will be retried at the next Flow start.`,
      );
    }
    this.#publish();
  }

  /**
   * Records a merge the forge has confirmed and arms the cleanup. One write
   * carries the merged request, the merged status, and the pending cleanup, so
   * a restart can never restore a merged request beside a status that still
   * allows starting work on it.
   */
  #adoptMerge(session: FlowSession, pr: FlowPr, url: string): void {
    session.pr = { ...pr, url, state: "merged" };
    session.status = "merged";
    session.leftover = null;
    session.cleanupPending = true;
    this.#persist();
    this.#broadcast({ type: "flowPr", pr: session.pr });
    this.#registerHistory();
    this.#stopWatchdog();
  }

  /** Removes the merged work, reporting what it could not clean up. */
  async #cleanupAfterMerge(session: FlowSession): Promise<string | null> {
    const leftovers: string[] = [];

    const fetched = await this.#git(this.repoDir, ["fetch", "origin"]);
    if (fetched.code !== 0) {
      // Without a refreshed origin/main the ancestry check would blame the
      // branch for a stale remote view. The failed fetch is its own leftover,
      // and the rest waits for the retry.
      const detail = fetched.stderr.trim();
      leftovers.push(
        detail.length === 0 ? "git fetch origin failed" : `git fetch origin failed (${detail})`,
      );
      return leftovers.join("; ");
    }
    const head = await this.#git(this.repoDir, ["symbolic-ref", "--short", "HEAD"]);
    if (head.code === 0 && head.stdout.trim() === "main") {
      const status = await this.#git(this.repoDir, ["status", "--porcelain"]);
      if (status.code === 0 && status.stdout.trim().length === 0) {
        const fastForward = await this.#git(this.repoDir, ["merge", "--ff-only", "origin/main"]);
        if (fastForward.code !== 0) {
          leftovers.push(`the host checkout could not fast-forward to origin/main`);
        }
      }
    }

    const tip = existsSync(session.worktree)
      ? await this.#git(session.worktree, ["rev-parse", "HEAD"])
      : undefined;
    const tipRevision = tip !== undefined && tip.code === 0 ? tip.stdout.trim() : "";
    if (tip !== undefined) {
      const removed = await this.#git(this.repoDir, ["worktree", "remove", session.worktree]);
      if (removed.code !== 0) {
        leftovers.push(`the worktree at ${session.worktree} (${session.branch})`);
        return leftovers.join("; ");
      }
    }
    // A resumed cleanup finds the worktree already removed; the branch's own
    // tip then stands in for the revision that had to reach origin/main.
    const branchRef = await this.#git(this.repoDir, [
      "rev-parse",
      "--verify",
      `refs/heads/${session.branch}`,
    ]);
    let branchGone = branchRef.code !== 0;
    if (!branchGone) {
      const revision = tipRevision.length > 0 ? tipRevision : branchRef.stdout.trim();
      const ancestor =
        revision.length === 0
          ? { code: 1 }
          : await this.#git(this.repoDir, ["merge-base", "--is-ancestor", revision, "origin/main"]);
      if (ancestor.code !== 0) {
        leftovers.push(`the branch ${session.branch} (its tip is not an ancestor of origin/main)`);
      } else {
        const local = await this.#git(this.repoDir, ["branch", "-d", session.branch]);
        if (local.code !== 0) leftovers.push(`the local branch ${session.branch}`);
        else branchGone = true;
      }
    }
    if (branchGone) {
      // Only a remote branch that still exists is a deletion candidate, so
      // finishing a cleanup that already deleted it stays silent.
      const remote = await this.#git(this.repoDir, [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        session.branch,
      ]);
      if (remote.code === 0) {
        try {
          await this.#forge.deleteRemoteBranch(this.repoDir, session.branch);
        } catch {
          leftovers.push(`the remote branch ${session.branch}`);
        }
      } else if (remote.code !== 2) {
        leftovers.push(`the remote branch ${session.branch} (could not check it)`);
      }
    }

    return leftovers.length === 0 ? null : leftovers.join("; ");
  }

  // ------------------------------------------------- steering / decisions

  sendSteering(text: unknown, source = "developer"): boolean {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return false;
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      this.#error("A steering note needs non-empty text.");
      return false;
    }
    const note: FlowSteeringNote = {
      id: `steer-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: nowIso(this.#now),
      source,
      text,
      status: "new",
    };
    session.steering.push(note);
    try {
      this.#appendSteering(note);
    } catch (error) {
      this.#error(
        `Could not record the steering note: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#persist();
    this.#broadcast({ type: "flowSteering", notes: session.steering });
    this.#publish();
    return true;
  }

  #syncSteeringAcks(session: FlowSession): void {
    const directory = this.sessionDir;
    if (directory === undefined) return;
    const acks = new Set(
      readJsonLines<{ id?: unknown } | string>(join(directory, "steering-ack.jsonl")).map((entry) =>
        typeof entry === "string" ? entry : String(entry.id ?? ""),
      ),
    );
    let changed = false;
    session.steering = session.steering.map((note) => {
      if (note.status === "new" && acks.has(note.id)) {
        changed = true;
        return { ...note, status: "read" };
      }
      return note;
    });
    if (changed) {
      this.#persist();
      this.#broadcast({ type: "flowSteering", notes: session.steering });
    }
  }

  saveDecisions(text: unknown): void {
    if (typeof text !== "string") {
      this.#error("saveFlowDecisions needs the decision board text.");
      return;
    }
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    session.decisions = text;
    this.#persist();
    try {
      writeText(this.#path("decisions.md"), text);
    } catch (error) {
      this.#error(
        `Could not write the decision board: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#broadcast({ type: "flowDecisions", text });
    this.#publish();
  }

  /** Appends a timestamped, source-named section without touching developer text. */
  #appendDecisions(source: string, text: string): Promise<void> {
    this.#decisionsChain = this.#decisionsChain.then(async () => {
      const session = this.#session;
      if (session === undefined) return;
      const section = `\n\n## ${nowIso(this.#now)} — ${source}\n\n${text.replace(/\s+$/, "")}\n`;
      session.decisions = `${session.decisions.replace(/\s+$/, "")}${section}`;
      try {
        writeText(this.#path("decisions.md"), session.decisions);
      } catch (error) {
        this.#error(
          `Could not write the decision board: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#persist();
      this.#broadcast({ type: "flowDecisions", text: session.decisions });
      this.#publish();
    });
    return this.#decisionsChain;
  }

  // ------------------------------------------------------ diff / widgets

  acceptWidget(id: unknown, accepted: unknown): void {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    if (typeof id !== "string") {
      this.#error("A widget acceptance needs the widget id.");
      return;
    }
    const widget = session.widgets.find((entry) => entry.id === id);
    if (widget === undefined) {
      this.#error("That Flow widget is no longer current.");
      return;
    }
    const shouldAccept = accepted !== false;
    session.accepted = shouldAccept
      ? [...new Set([...session.accepted, id])]
      : session.accepted.filter((signature) => signature !== id);
    session.widgets = session.widgets.map((entry) =>
      entry.id === id ? { ...entry, accepted: shouldAccept } : entry,
    );
    this.#persist();
    try {
      writeJson(this.#path("accepted.json"), { signatures: session.accepted });
    } catch {
      // The machine state above is the source of truth.
    }
    this.#broadcast({ type: "flowWidgets", widgets: session.widgets });
    this.#publish();
  }

  refuseWidget(id: unknown, reason: unknown): void {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    if (typeof id !== "string" || !session.widgets.some((widget) => widget.id === id)) {
      this.#error("That Flow widget is no longer current.");
      return;
    }
    const detail = typeof reason === "string" ? reason.trim() : "";
    const text =
      detail.length > 0
        ? `Refuse widget ${id}: ${detail} Abandon this change and implement another solution.`
        : `Refuse widget ${id}: abandon this change and implement another solution.`;
    this.sendSteering(text, `widget:${id}`);
  }

  // ------------------------------------------------------- conversation

  async openConversation(widgetId: unknown): Promise<void> {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    if (typeof widgetId !== "string") {
      this.#error("A widget conversation needs the widget id.");
      return;
    }
    const widget = session.widgets.find((entry) => entry.id === widgetId);
    if (widget === undefined) {
      this.#error("That Flow widget is no longer current.");
      return;
    }
    this.closeConversation(true);

    const conversation: Conversation = {
      widgetId,
      agent: undefined,
      messages: [],
      activity: [],
      question: null,
      busy: false,
      queue: [],
    };
    this.#conversation = conversation;
    this.#broadcast({ type: "flowConversationStarted", widgetId });
    this.#publish();

    const directory = this.sessionDir;
    if (directory === undefined) return;
    const files = widget.files
      .map((path) => session.files.find((file) => file.path === path))
      .filter((file): file is FlowFile => file !== undefined);
    const context = [
      `Widget category: ${widget.category}`,
      `Widget concept: ${widget.concept}`,
      `Widget summary: ${widget.summary}`,
      `Widget rationale: ${widget.rationale}`,
      "",
      "Session goal:",
      session.goal,
      "",
      "Decision board:",
      session.decisions,
      "",
      "Files and diffs:",
      ...files.map((file) => [`--- ${file.path} (${file.status}) ---`, file.diff].join("\n")),
      "",
      "This conversation is read-only. Never edit code or the worktree.",
    ].join("\n");

    try {
      const env = await this.#agentEnvironment();
      // A close, a replacement, or a disposal during provider selection clears
      // the owner; constructing now would leave a peer nothing can close.
      if (this.#conversation !== conversation) return;
      const agent = new AcpConnection({
        command: this.#agentCommand,
        cwd: this.repoDir,
        env,
        permissionPolicy: "read-only",
        onActivity: (activity: AcpActivity) => {
          if (this.#conversation !== conversation) return;
          const append = activity.append && conversation.activity.length > 0;
          if (append) conversation.activity[conversation.activity.length - 1] += activity.text;
          else conversation.activity.push(activity.text);
          this.#broadcast({
            type: "flowConversationActivity",
            text: activity.text,
            append,
          });
        },
        onQuestion: (question: AcpQuestion) => {
          if (this.#conversation !== conversation) return;
          conversation.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          this.#broadcast({
            type: "flowConversationQuestion",
            id: question.id,
            message: question.message,
            options: question.options,
          });
          this.#publish();
        },
        onStderr: (text) => this.#journal?.write("acp-stderr", text),
      });
      if (this.#conversation !== conversation) {
        agent.close();
        return;
      }
      conversation.agent = agent;
      void this.#pumpConversation(conversation, `/flow-widget ${directory} ${widgetId}\n\n${context}`);
    } catch (error) {
      // A rejection that lands after a replacement belongs to the superseded
      // conversation and must never close the current one.
      if (this.#conversation !== conversation) return;
      this.#error(error instanceof Error ? error.message : String(error));
      this.closeConversation();
    }
  }

  /** One prompt at a time; a message sent while the peer answers waits its turn. */
  async #pumpConversation(conversation: Conversation, prompt: string): Promise<void> {
    conversation.busy = true;
    try {
      await conversation.agent?.run(prompt);
    } catch (error) {
      if (this.#conversation !== conversation) return;
      this.#error(error instanceof Error ? error.message : String(error));
    } finally {
      conversation.busy = false;
      const next = conversation.queue.shift();
      if (next !== undefined && this.#conversation === conversation) {
        // The opening run created the session; every later turn must reuse it
        // so the queued text keeps the conversation's context and read-only rule.
        void this.#promptConversation(conversation, next);
      }
    }
  }

  sendConversationMessage(text: unknown): void {
    const conversation = this.#conversation;
    if (conversation === undefined) {
      this.#error("No widget conversation is open.");
      return;
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      this.#error("A conversation message needs non-empty text.");
      return;
    }
    conversation.messages.push({ role: "developer", text });
    this.#broadcast({ type: "flowConversationMessage", role: "developer", text });
    if (conversation.busy || conversation.agent === undefined) {
      // No peer can take the text yet while `openConversation` awaits the
      // provider environment; the opening prompt's pump drains this queue.
      conversation.queue.push(text);
    } else {
      void this.#promptConversation(conversation, text);
    }
    this.#publish();
  }

  async #promptConversation(conversation: Conversation, text: string): Promise<void> {
    if (conversation.agent === undefined) return;
    conversation.busy = true;
    try {
      await conversation.agent.prompt(text);
    } catch (error) {
      if (this.#conversation !== conversation) return;
      this.#error(error instanceof Error ? error.message : String(error));
    } finally {
      conversation.busy = false;
      const next = conversation.queue.shift();
      if (next !== undefined && this.#conversation === conversation) {
        void this.#promptConversation(conversation, next);
      }
    }
  }

  closeConversation(silent = false): void {
    const conversation = this.#conversation;
    if (conversation === undefined) {
      if (!silent) this.#error("No widget conversation is open.");
      return;
    }
    this.#conversation = undefined;
    conversation.question = null;
    conversation.agent?.close();
    conversation.agent = undefined;
    this.#broadcast({ type: "flowConversationStopped", widgetId: conversation.widgetId });
    if (!silent) this.#publish();
  }

  async sendConversationConclusion(text: unknown): Promise<void> {
    const conversation = this.#conversation;
    const session = this.#session;
    if (conversation === undefined || session === undefined) {
      this.#error("No widget conversation is open.");
      return;
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      this.#error("A conclusion needs non-empty text.");
      return;
    }
    const widget = session.widgets.find((entry) => entry.id === conversation.widgetId);
    await this.#appendDecisions(
      `Widget conversation ${conversation.widgetId}`,
      text,
    );
    this.sendSteering(
      `Conclusion for widget ${conversation.widgetId}${widget === undefined ? "" : ` (${widget.concept})`}: ${text}`,
      `widget-chat:${conversation.widgetId}`,
    );
  }

  // ----------------------------------------------------- verification

  #syncVerification(session: FlowSession): void {
    const path = this.#path("verification.json");
    const stored = readJson<Record<string, unknown>>(path);
    if (stored === null || typeof stored !== "object") return;
    const status =
      stored.status === "passed" || stored.status === "failed" || stored.status === "not-run"
        ? stored.status
        : undefined;
    if (status === undefined) return;
    const verification: FlowVerification = {
      command: typeof stored.command === "string" ? stored.command : "",
      status,
      timestamp: typeof stored.timestamp === "string" ? stored.timestamp : nowIso(this.#now),
      output: typeof stored.output === "string" ? boundedTail(stored.output) : "",
    };
    if (
      session.verification !== null &&
      session.verification.command === verification.command &&
      session.verification.status === verification.status &&
      session.verification.timestamp === verification.timestamp
    ) {
      return;
    }
    session.verification = verification;
    this.#persist();
    this.#broadcast({ type: "flowVerification", verification });
  }

  // ---------------------------------------------------------- blockers

  #addBlocker(text: string): void {
    const session = this.#session;
    const trimmed = text.trim();
    if (session === undefined || trimmed.length === 0) return;
    // A marker text is admitted at most once per session. Rescanning the
    // activity that produced it, or the agent printing it again, must never
    // resurrect a blocker the developer already dismissed: the dismissed entry
    // is a tombstone, not a reason to append a fresh id.
    if (session.blockers.some((blocker) => blocker.text === trimmed)) return;
    const blocker: FlowBlocker = {
      id: `blocker-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: nowIso(this.#now),
      text: trimmed,
      dismissed: false,
    };
    session.blockers.push(blocker);
    try {
      appendLine(this.#path("blockers.jsonl"), {
        id: blocker.id,
        timestamp: blocker.timestamp,
        text: blocker.text,
      });
    } catch {
      // The session state still carries it.
    }
    this.#persist();
    this.#broadcast({ type: "flowBlockers", blockers: session.blockers });
    this.#publish();
  }

  #syncBlockers(session: FlowSession): void {
    const directory = this.sessionDir;
    if (directory === undefined) return;
    const recorded = readJsonLines<{ id?: string; timestamp?: string; text?: string }>(
      join(directory, "blockers.jsonl"),
    );
    let changed = false;
    for (const entry of recorded) {
      if (typeof entry.text !== "string" || entry.text.trim().length === 0) continue;
      if (session.blockers.some((blocker) => blocker.text === entry.text)) continue;
      session.blockers.push({
        id: typeof entry.id === "string" ? entry.id : `blocker-${randomUUID().slice(0, 8)}`,
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : nowIso(this.#now),
        text: entry.text,
        dismissed: false,
      });
      changed = true;
    }
    if (changed) {
      this.#persist();
      this.#broadcast({ type: "flowBlockers", blockers: session.blockers });
    }
  }

  dismissBlocker(id: unknown): void {
    const session = this.#session;
    if (session === undefined) {
      this.#error("No Flow session exists.");
      return;
    }
    if (typeof id !== "string") {
      this.#error("A blocker dismissal needs the blocker id.");
      return;
    }
    const blocker = session.blockers.find((entry) => entry.id === id);
    if (blocker === undefined) {
      this.#error("That Flow blocker does not exist.");
      return;
    }
    session.blockers = session.blockers.map((entry) =>
      entry.id === id ? { ...entry, dismissed: true } : entry,
    );
    this.#persist();
    this.#broadcast({ type: "flowBlockers", blockers: session.blockers });
    this.#publish();
  }

  // -------------------------------------------------------------- answer

  answer(id: unknown, value: unknown, target: unknown): void {
    if (
      id === undefined ||
      (typeof id !== "string" && typeof id !== "number") ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      this.#error("An answer needs the question id and a non-empty value.");
      return;
    }
    if (target === "conversation") {
      const conversation = this.#conversation;
      if (
        conversation === undefined ||
        conversation.question === null ||
        String(conversation.question.id) !== String(id) ||
        conversation.agent === undefined ||
        !conversation.agent.answer(conversation.question.id, value)
      ) {
        this.#error("No pending conversation question with that id.");
        return;
      }
      conversation.question = null;
      this.#publish();
      return;
    }
    if (target === "goal") {
      const creation = this.#goalCreation;
      if (
        creation === undefined ||
        creation.question === null ||
        String(creation.question.id) !== String(id) ||
        creation.agent === undefined ||
        !creation.agent.answer(creation.question.id, value)
      ) {
        this.#error("No pending Flow goal question with that id.");
        return;
      }
      creation.question = null;
      return;
    }

    const session = this.#session;
    const implementation = this.#implementation;
    if (
      session === undefined ||
      implementation === undefined ||
      implementation.agent === undefined ||
      session.question === null ||
      String(session.question.id) !== String(id) ||
      !implementation.agent.answer(session.question.id, value)
    ) {
      this.#error("No pending Flow question with that id.");
      return;
    }
    session.question = null;
    this.#persist();
    this.#publish();
  }

  // --------------------------------------------------------- replay bits

  #emitSections(options: { files?: boolean; widgets?: boolean }): void {
    const session = this.#session;
    if (session === undefined) return;
    if (options.files !== false) this.#broadcast({ type: "flowFiles", files: session.files });
    if (options.widgets !== false) this.#broadcast({ type: "flowWidgets", widgets: session.widgets });
    this.#broadcast({ type: "flowSteering", notes: session.steering });
    this.#broadcast({ type: "flowDecisions", text: session.decisions });
    this.#broadcast({ type: "flowCheckpoints", checkpoints: session.checkpoints });
    this.#broadcast({ type: "flowVerification", verification: session.verification });
    this.#broadcast({ type: "flowBlockers", blockers: session.blockers });
    this.#broadcast({ type: "flowPr", pr: session.pr });
  }
}

function verificationStatus(value: unknown): "passed" | "failed" | "not-run" {
  return value === "passed" || value === "failed" ? value : "not-run";
}

/** Parses `git status --porcelain=v1 -z`. */
export function parseStatusZ(
  text: string,
): { status: "added" | "modified" | "deleted" | "renamed" | "untracked"; path: string }[] {
  const parts = text.split("\0");
  const entries: { status: "added" | "modified" | "deleted" | "renamed" | "untracked"; path: string }[] =
    [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length < 4) continue;
    const code = part.slice(0, 2);
    const path = part.slice(3);
    if (code === "??") {
      entries.push({ status: "untracked", path });
      continue;
    }
    if (code.startsWith("R") || code.startsWith("C")) {
      // The source path follows as its own NUL-terminated field.
      index += 1;
      entries.push({ status: "renamed", path });
      continue;
    }
    if (code.includes("D")) {
      entries.push({ status: "deleted", path });
      continue;
    }
    if (code.includes("A")) {
      entries.push({ status: "added", path });
      continue;
    }
    entries.push({ status: "modified", path });
  }
  return entries;
}

/** The forge named by an origin URL, reusing the tracker's classification. */
export function classifyOrigin(
  remote: string,
  environment: Record<string, string | undefined> = process.env,
): ForgeTarget | undefined {
  const parsed = parseForgeRemote(remote, environment);
  if (parsed === undefined) return undefined;
  return {
    forge: parsed.forge,
    host: parsed.host,
    project: parsed.project,
    ...(parsed.forge === "gitea"
      ? { baseUrl: giteaBaseUrl(parsed, environment) }
      : {}),
  };
}

export function prTitle(goal: string): string {
  const line = firstLine(goal);
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function prBody(goal: string, decisions: string): string {
  return [
    "## Goal",
    "",
    goal.trim(),
    "",
    "## Decisions",
    "",
    decisions.trim().length === 0 ? "No decisions recorded." : decisions.trim(),
    "",
  ].join("\n");
}

/** Keeps the exported worktree name reachable for the client's summary. */
export function worktreeLabel(repoDir: string, sessionId: string): string {
  return relative(repoDir, join(repoDir, ".worktree", `flow-${sessionId}`));
}

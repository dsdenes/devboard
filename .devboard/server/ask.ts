import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { nextActivity, type ActivityStream } from "./acp";
import { DetachedPeer } from "./detached-run";
import { pidAlive } from "../issues/lock";
import { journalKey } from "./journal";

/**
 * The element-scoped Ask conversation. One controller lives with the server;
 * one conversation lives with each open report panel.
 *
 * The peer is a minimal ACP client rather than `AcpConnection` because the
 * transcript must show only assistant message text: `AcpConnection` forwards
 * thoughts and tool-call titles through the same activity log, and its public
 * surface carries no update kind. The protocol framing, permission answers,
 * and session reuse mirror `AcpConnection`, and the update mapping is its
 * exported `nextActivity`.
 */

const MAX_CONVERSATION_ID = 200;
const MAX_QUESTION = 4000;
/**
 * Wall-clock bound for one conversation turn. A peer that accepts a prompt and
 * stops producing output, or a provider selection that never resolves, must not
 * hold the conversation busy for the rest of the page's life.
 */
export const ASK_TURN_TIMEOUT_MS = 120_000;
/** Bounds shared with the client's capture; a larger value is refused. */
const ASK_CONTEXT_LIMITS = {
  route: 2000,
  url: 2000,
  selector: 500,
  viewport: 500,
  captured_at: 100,
  visible_text: 1500,
  dom_excerpt: 4000,
} as const;

type AskContextField = keyof typeof ASK_CONTEXT_LIMITS;

type AskContext = Record<AskContextField, string>;

interface AskRequest {
  conversationId: string;
  question: string;
  context: AskContext;
}

interface AskTranscriptEntry {
  role: "developer" | "agent";
  text: string;
}

/** A payload the server refuses without touching the agent. */
class AskRequestError extends Error {}

const READ_ONLY_SENTENCE =
  "This conversation is read-only. Never edit files, run mutating commands, file issues, commit, or push.";
const BREVITY_SENTENCE =
  "Answer in at most three short sentences and about 400 characters. No preamble and no restating the question.";
const PLAIN_SENTENCE = "Reply in plain text without Markdown.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedField(
  context: Record<string, unknown>,
  name: AskContextField,
): string {
  const value = context[name];
  if (typeof value !== "string") throw new AskRequestError(`The ask context is missing ${name}.`);
  if (value.length > ASK_CONTEXT_LIMITS[name]) {
    throw new AskRequestError(`The ask context ${name} is longer than ${ASK_CONTEXT_LIMITS[name]}.`);
  }
  return value;
}

/** Validates one client ask; unknown fields are ignored for forwards compatibility. */
function parseAskRequest(value: unknown): AskRequest {
  const request = asRecord(value);
  if (request === undefined) throw new AskRequestError("The ask is not an object.");

  const conversationId = request.conversationId;
  if (typeof conversationId !== "string") {
    throw new AskRequestError("The ask has no conversation id.");
  }
  const id = conversationId.trim();
  if (id.length === 0 || id.length > MAX_CONVERSATION_ID) {
    throw new AskRequestError(`The conversation id must be 1-${MAX_CONVERSATION_ID} characters.`);
  }

  const question = request.question;
  if (typeof question !== "string") throw new AskRequestError("The ask has no question.");
  const trimmed = question.trim();
  if (trimmed.length === 0) throw new AskRequestError("The question is empty.");
  if (trimmed.length > MAX_QUESTION) {
    throw new AskRequestError(`The question is longer than ${MAX_QUESTION} characters.`);
  }

  const context = asRecord(request.context);
  if (context === undefined) throw new AskRequestError("The ask has no element context.");
  return {
    conversationId: id,
    question: trimmed,
    context: {
      route: boundedField(context, "route"),
      url: boundedField(context, "url"),
      selector: boundedField(context, "selector"),
      viewport: boundedField(context, "viewport"),
      captured_at: boundedField(context, "captured_at"),
      visible_text: boundedField(context, "visible_text"),
      dom_excerpt: boundedField(context, "dom_excerpt"),
    },
  };
}

function contextLines(context: AskContext): string[] {
  return (Object.keys(ASK_CONTEXT_LIMITS) as AskContextField[]).map(
    (name) => `${name}: ${context[name]}`,
  );
}

/** The deadline in the ask error; milliseconds below one second stay exact. */
function timeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} seconds` : `${timeoutMs}ms`;
}

/** The prompt's invariant instruction block, repeated on every turn. */
function instructions(): string[] {
  return [READ_ONLY_SENTENCE, BREVITY_SENTENCE, PLAIN_SENTENCE];
}

function earlierTurns(transcript: AskTranscriptEntry[]): string[] {
  if (transcript.length === 0) return [];
  return [
    "Earlier in this conversation:",
    ...transcript.map(
      (entry) => `${entry.role === "developer" ? "Developer" : "Agent"}: ${entry.text}`,
    ),
    "",
  ];
}

/** The first prompt of a conversation, or of a replacement peer. */
function askPrompt(request: AskRequest, transcript: AskTranscriptEntry[]): string {
  return [
    "You are answering a question about a UI element in the running Devboard interface.",
    "Answer from the captured context and this conversation; change nothing.",
    "",
    ...instructions(),
    "",
    ...earlierTurns(transcript),
    `Question: ${request.question}`,
    "",
    "Captured element context:",
    ...contextLines(request.context),
  ].join("\n");
}

/** A follow-up keeps the live session's context and repeats the instructions. */
function followUpPrompt(question: string): string {
  return [...instructions(), "", `Question: ${question}`].join("\n");
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface AskPeerOptions {
  command: string;
  cwd: string;
  /** The exact peer environment, resolved from the provider selection. */
  env: Record<string, string | undefined>;
  /** `deny` cancels every permission request, for a read-only conversation. */
  permissionPolicy: "allow" | "deny";
  /** Receives assistant message text only; thoughts and tool activity are dropped. */
  onText: (text: string) => void;
}

/**
 * One ACP peer: initialize, open a session, and prompt it repeatedly. Session
 * updates are classified with `nextActivity`, so only `agent_message_chunk`
 * text reaches the transcript.
 */
class AskPeer {
  readonly #process: Subprocess<"pipe", "pipe", "pipe">;
  readonly #cwd: string;
  readonly #permissionPolicy: "allow" | "deny";
  readonly #onText: (text: string) => void;
  readonly #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;
  #sessionId: string | undefined;
  #stream: ActivityStream | undefined;

  constructor(options: AskPeerOptions) {
    const argv = options.command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) throw new Error("AGENT_COMMAND is empty.");
    this.#cwd = options.cwd;
    this.#permissionPolicy = options.permissionPolicy;
    this.#onText = options.onText;
    this.#process = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#readStdout();
    void this.#drainStderr();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Whether the handshake completed far enough to prompt this peer. */
  get hasSession(): boolean {
    return this.#sessionId !== undefined;
  }

  async run(prompt: string): Promise<unknown> {
    await this.#request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "devboard-adr-ui", version: "0.1.0" },
    });
    const session = asRecord(
      await this.#request("session/new", { cwd: this.#cwd, mcpServers: [] }),
    );
    const sessionId = session?.sessionId;
    if (typeof sessionId !== "string") throw new Error("Agent did not return a session id.");
    this.#sessionId = sessionId;
    return await this.prompt(prompt);
  }

  /** Sends another prompt on the session this peer opened. */
  async prompt(prompt: string): Promise<unknown> {
    if (this.#sessionId === undefined) throw new Error("No agent session is open.");
    return await this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#process.kill("SIGCONT");
    } catch {
      // The process already exited.
    }
    try {
      this.#process.kill();
    } catch {
      // The process already exited.
    }
  }

  async #readStdout(): Promise<void> {
    const reader = this.#process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) this.#handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) this.#handleLine(buffer.trim());
    } finally {
      this.#closed = true;
      for (const request of this.#pending.values()) {
        request.reject(new Error("Agent process exited before answering."));
      }
      this.#pending.clear();
    }
  }

  async #drainStderr(): Promise<void> {
    const reader = this.#process.stderr.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // stderr is diagnostic only.
    }
  }

  #handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        this.#handleRequest(message.id, message.method, message.params);
      } else if (message.method === "session/update") {
        this.#handleSessionUpdate(message.params);
      }
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.#pending.get(String(message.id));
    if (pending === undefined) return;
    this.#pending.delete(String(message.id));
    if (message.error !== undefined) {
      const error: Error & { code?: number; data?: unknown } = new Error(
        message.error.message ?? "Agent request failed.",
      );
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  #handleRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case "session/update":
        this.#handleSessionUpdate(params);
        this.#respond(id, null);
        return;
      case "elicitation/create":
        // The Ask conversation asks the agent nothing of its own.
        this.#respond(id, { action: "cancel" });
        return;
      case "session/request_permission": {
        if (this.#permissionPolicy === "deny") {
          this.#respond(id, { outcome: { outcome: "cancelled" } });
          return;
        }
        const request = asRecord(params) ?? {};
        const options = Array.isArray(request.options) ? request.options : [];
        const option = options.find((candidate) => {
          const kind = asRecord(candidate)?.kind;
          return typeof kind === "string" && kind.startsWith("allow");
        });
        const optionId = asRecord(option)?.optionId;
        this.#respond(
          id,
          typeof optionId === "string"
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
        return;
      }
      default:
        this.#respondError(id, -32601, `Method not found: ${method}`);
    }
  }

  #handleSessionUpdate(params: unknown): void {
    const next = nextActivity(asRecord(params)?.update, this.#stream);
    if (next === undefined) return;
    this.#stream = next.stream;
    // Thoughts, tool calls, plans, and echo of the user prompt never render.
    if (next.stream?.kind !== "agent_message_chunk") return;
    this.#onText(next.activity.text);
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("Agent process is not running.");
    const id = this.#nextRequestId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(String(id), { resolve, reject });
    try {
      this.#write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.#pending.delete(String(id));
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return await promise;
  }

  #respond(id: number | string, result: unknown): void {
    try {
      this.#write({ jsonrpc: "2.0", id, result });
    } catch {
      // The peer is gone; nothing left to answer.
    }
  }

  #respondError(id: number | string, code: number, message: string): void {
    try {
      this.#write({ jsonrpc: "2.0", id, error: { code, message } });
    } catch {
      // The peer is gone; nothing left to answer.
    }
  }

  #write(message: unknown): void {
    if (this.#closed) throw new Error("Agent process is not running.");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
    void this.#process.stdin.flush();
  }
}

interface AskSocket {
  send(data: string): unknown;
}

interface Conversation {
  id: string;
  socket: AskSocket | null;
  peer: DetachedPeer | undefined;
  /** Visible turns, replayed to a replacement peer. */
  transcript: AskTranscriptEntry[];
  busy: boolean;
  /** The answer being streamed; a closed or replaced turn discards it. */
  answer: string;
  closed: boolean;
  turn: number;
  /** The prompt of the turn in flight, so a replacement can re-attach. */
  lastPrompt: string | null;
}

export interface AskControllerOptions {
  /** `AGENT_COMMAND`: executable plus leading arguments of the ACP peer. */
  command: string;
  /** The host repository root every peer runs in. */
  cwd: string;
  /** Resolves the selected provider's environment; throws when none is eligible. */
  environment: () => Promise<Record<string, string | undefined>>;
  /** Wall-clock bound for one turn; defaults to `ASK_TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number;
  /** The dashboard state directory that retains conversations. */
  stateDir?: string;
  /** The dashboard instance that owns detached runs. */
  instance?: string;
  harnessVersion?: string | null;
  /** True while this process is being replaced; conversations then survive. */
  isRestarting?: () => boolean;
}

interface StoredConversation {
  id: string;
  transcript: AskTranscriptEntry[];
  turn: number;
  busy: boolean;
  lastPrompt: string | null;
}

/** `<STATE_DIR>/ask/<repository key>`. */
function askDirectory(stateDir: string, repoDir: string): string {
  return join(resolve(stateDir), "ask", journalKey(resolve(repoDir)));
}

function conversationPath(stateDir: string, repoDir: string, id: string): string {
  const key = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(askDirectory(stateDir, repoDir), `${key}.json`);
}

function readConversations(stateDir: string, repoDir: string): StoredConversation[] {
  let names: string[];
  try {
    names = readdirSync(askDirectory(stateDir, repoDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const conversations: StoredConversation[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(askDirectory(stateDir, repoDir), name), "utf8"),
      );
      if (typeof parsed !== "object" || parsed === null) continue;
      const value = parsed as Record<string, unknown>;
      if (typeof value.id !== "string" || !Array.isArray(value.transcript)) continue;
      conversations.push({
        id: value.id,
        transcript: value.transcript.filter(
          (entry): entry is AskTranscriptEntry =>
            typeof entry === "object" &&
            entry !== null &&
            ((entry as Record<string, unknown>).role === "developer" ||
              (entry as Record<string, unknown>).role === "agent") &&
            typeof (entry as Record<string, unknown>).text === "string",
        ),
        turn: typeof value.turn === "number" && Number.isInteger(value.turn) ? value.turn : 0,
        busy: value.busy === true,
        lastPrompt: typeof value.lastPrompt === "string" ? value.lastPrompt : null,
      });
    } catch {
      // An unreadable conversation is not a reason to stop serving.
    }
  }
  return conversations;
}

/**
 * Owns every open Ask conversation. Each turn is a detached run, so a server
 * replacement leaves the peer alive; the transcript and the in-flight prompt
 * are retained under STATE_DIR so the replacement can re-attach.
 */
export class AskController {
  readonly #options: AskControllerOptions;
  readonly #conversations = new Map<string, Conversation>();
  readonly #turnTimeoutMs: number;
  readonly #stateDir: string | undefined;

  constructor(options: AskControllerOptions) {
    this.#options = options;
    this.#turnTimeoutMs = Math.max(1, options.turnTimeoutMs ?? ASK_TURN_TIMEOUT_MS);
    this.#stateDir = options.stateDir === undefined ? undefined : resolve(options.stateDir);
    if (this.#stateDir === undefined) return;
    for (const stored of readConversations(this.#stateDir, options.cwd)) {
      this.#conversations.set(stored.id, {
        id: stored.id,
        socket: null,
        peer: undefined,
        transcript: stored.transcript,
        busy: stored.busy,
        answer: "",
        closed: false,
        turn: stored.turn,
        lastPrompt: stored.lastPrompt,
      });
    }
  }

  #persist(conversation: Conversation): void {
    if (this.#stateDir === undefined) return;
    try {
      const path = conversationPath(this.#stateDir, this.#options.cwd, conversation.id);
      mkdirSync(dirname(path), { recursive: true });
      const stored: StoredConversation = {
        id: conversation.id,
        transcript: conversation.transcript,
        turn: conversation.turn,
        busy: conversation.busy,
        lastPrompt: conversation.lastPrompt,
      };
      writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(stored)}\n`);
      renameSync(`${path}.${process.pid}.tmp`, path);
    } catch {
      // A read-only state directory still serves the conversation in memory.
    }
  }

  #detached(
    conversation: Conversation,
    key: string,
    prompt: string,
    attachOnly: boolean,
  ): DetachedPeer {
    return new DetachedPeer({
      repoDir: this.#options.cwd,
      stateDir: this.#stateDir ?? join(this.#options.cwd, ".devboard", ".tmp"),
      kind: "ask",
      key,
      instance: this.#options.instance ?? "ask",
      harnessVersion: this.#options.harnessVersion ?? null,
      attachOnly,
      multi: true,
      command: this.#options.command,
      cwd: this.#options.cwd,
      permissionPolicy: "deny",
      onActivity: () => undefined,
      onText: (text) => {
        if (conversation.closed || !conversation.busy) return;
        conversation.answer += text;
        if (conversation.socket !== null) {
          this.#send(conversation.socket, {
            type: "askChunk",
            conversationId: conversation.id,
            text,
          });
        }
      },
      onQuestion: () => undefined,
    });
  }

  async ask(socket: AskSocket, message: { conversationId?: unknown; question?: unknown; context?: unknown }): Promise<void> {
    const candidateId =
      typeof message.conversationId === "string" ? message.conversationId : "";
    const refuse = (text: string): void =>
      this.#send(socket, { type: "askError", conversationId: candidateId, message: text });

    let request: AskRequest;
    try {
      request = parseAskRequest(message);
    } catch (error) {
      if (error instanceof AskRequestError) {
        refuse(error.message);
        return;
      }
      throw error;
    }

    const existing = this.#conversations.get(request.conversationId);
    if (existing !== undefined && existing.socket !== null && existing.socket !== socket) {
      refuse("This conversation belongs to another client.");
      return;
    }
    if (existing !== undefined && existing.busy && existing.peer !== undefined) {
      refuse("The agent is still answering the previous question.");
      return;
    }

    const conversation: Conversation = existing ?? {
      id: request.conversationId,
      socket,
      peer: undefined,
      transcript: [],
      busy: false,
      answer: "",
      closed: false,
      turn: 0,
      lastPrompt: null,
    };
    conversation.socket = socket;
    conversation.closed = false;
    if (existing === undefined) this.#conversations.set(conversation.id, conversation);

    // A replacement re-attaches to the turn that was already in flight.
    const live = (turn: number): boolean =>
      !conversation.closed && conversation.turn === turn && conversation.socket === socket;
    let deadline: Timer | undefined;
    const clearDeadline = (): void => {
      if (deadline === undefined) return;
      clearTimeout(deadline);
      deadline = undefined;
    };
    const fail = (error: unknown, turn: number): void => {
      clearDeadline();
      if (!live(turn)) return;
      conversation.busy = false;
      // A peer that is gone needs a fresh owner; a live peer that refused one
      // turn keeps its session for the next question.
      const peer = conversation.peer;
      if (peer !== undefined && (peer.pid === undefined || !pidAlive(peer.pid))) {
        peer.close();
        conversation.peer = undefined;
      }
      this.#persist(conversation);
      this.#send(socket, {
        type: "askError",
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    };

    if (conversation.busy && conversation.lastPrompt !== null) {
      const attachedTurn = conversation.turn;
      const peer = this.#detached(conversation, conversation.id, conversation.lastPrompt, true);
      conversation.peer = peer;
      // Attachment begins polling only through `run`; the owner already has
      // the turn, so this promise settles with the run's own outcome.
      void peer.run("").catch(() => undefined);
      void peer.waitTurn(attachedTurn).then(
        () => {
          if (!live(attachedTurn)) return;
          conversation.busy = false;
          if (conversation.answer.trim().length > 0) {
            conversation.transcript.push({ role: "agent", text: conversation.answer });
          }
          conversation.answer = "";
          this.#persist(conversation);
          this.#send(socket, { type: "askDone", conversationId: conversation.id });
        },
        (error: unknown) => fail(error, attachedTurn),
      );
      return;
    }

    const firstTurn = conversation.peer === undefined || conversation.peer.closed;
    const turnNumber = ++conversation.turn;
    conversation.busy = true;
    conversation.answer = "";
    conversation.transcript.push({ role: "developer", text: request.question });
    const prompt = firstTurn
      ? askPrompt(request, conversation.transcript.slice(0, -1))
      : followUpPrompt(request.question);
    conversation.lastPrompt = prompt;
    this.#persist(conversation);
    // The turn starts with the provider selection, so a peer that accepts the
    // prompt and stops producing output cannot hold the conversation busy: the
    // deadline invalidates the turn, drops the peer, and reports the timeout.
    deadline = setTimeout(() => {
      deadline = undefined;
      if (!live(turnNumber)) return;
      conversation.turn += 1;
      conversation.busy = false;
      conversation.answer = "";
      conversation.peer?.close();
      conversation.peer = undefined;
      this.#persist(conversation);
      this.#send(socket, {
        type: "askError",
        conversationId: conversation.id,
        message: `The ask agent did not answer within ${timeoutLabel(this.#turnTimeoutMs)}.`,
      });
    }, this.#turnTimeoutMs);

    let peer: DetachedPeer;
    try {
      if (!firstTurn) {
        peer = conversation.peer as DetachedPeer;
      } else {
        const env = await this.#options.environment();
        // A close, disconnect, or deadline during provider selection discards
        // the conversation. Constructing now would leave a peer no callback can
        // reach, so this turn ends without a process.
        if (!live(turnNumber)) {
          clearDeadline();
          return;
        }
        const created = new DetachedPeer({
          repoDir: this.#options.cwd,
          stateDir: this.#stateDir ?? join(this.#options.cwd, ".devboard", ".tmp"),
          kind: "ask",
          key: conversation.id,
          instance: this.#options.instance ?? "ask",
          harnessVersion: this.#options.harnessVersion ?? null,
          multi: true,
          command: this.#options.command,
          cwd: this.#options.cwd,
          env,
          permissionPolicy: "deny",
          onActivity: () => undefined,
          onText: (text) => {
            // A late chunk of a replaced or timed-out peer belongs to no
            // visible answer, even when a later ask made the conversation busy.
            if (conversation.peer !== created || !conversation.busy) return;
            conversation.answer += text;
            if (conversation.socket !== null) {
              this.#send(conversation.socket, {
                type: "askChunk",
                conversationId: conversation.id,
                text,
              });
            }
          },
          onQuestion: () => undefined,
        });
        // A close that lands between the guard and the constructor must still
        // end with no live peer.
        if (!live(turnNumber)) {
          created.close();
          clearDeadline();
          return;
        }
        peer = created;
        conversation.peer = created;
      }
    } catch (error) {
      fail(error, turnNumber);
      return;
    }

    const turn = firstTurn ? peer.run(prompt) : peer.prompt(prompt);
    void turn.then(
      () => {
        clearDeadline();
        if (!live(turnNumber)) return;
        conversation.busy = false;
        if (conversation.answer.trim().length > 0) {
          conversation.transcript.push({ role: "agent", text: conversation.answer });
        }
        conversation.answer = "";
        this.#persist(conversation);
        this.#send(socket, { type: "askDone", conversationId: conversation.id });
      },
      (error: unknown) => fail(error, turnNumber),
    );
  }

  /** Closes one conversation and stops its run; a stale id is ignored. */
  close(socket: AskSocket, conversationId: unknown): void {
    if (typeof conversationId !== "string") return;
    const conversation = this.#conversations.get(conversationId);
    if (conversation === undefined) return;
    if (conversation.socket !== null && conversation.socket !== socket) return;
    this.#discard(conversation);
  }

  /** A closed socket owns no conversation; a replacement keeps them. */
  disconnect(socket: AskSocket): void {
    for (const conversation of [...this.#conversations.values()]) {
      if (conversation.socket !== socket) continue;
      if (this.#options.isRestarting?.() === true) {
        conversation.socket = null;
        this.#persist(conversation);
      } else {
        this.#discard(conversation);
      }
    }
  }

  /** Stops every peer unless a replacement is about to adopt them. */
  dispose(): void {
    if (this.#options.isRestarting?.() === true) {
      for (const conversation of this.#conversations.values()) {
        conversation.socket = null;
        this.#persist(conversation);
      }
      return;
    }
    for (const conversation of [...this.#conversations.values()]) {
      this.#discard(conversation);
    }
  }

  #discard(conversation: Conversation): void {
    conversation.closed = true;
    conversation.busy = false;
    conversation.turn += 1;
    conversation.answer = "";
    conversation.transcript = [];
    conversation.lastPrompt = null;
    conversation.peer?.close();
    conversation.peer = undefined;
    this.#conversations.delete(conversation.id);
    if (this.#stateDir !== undefined) {
      try {
        rmSync(conversationPath(this.#stateDir, this.#options.cwd, conversation.id), {
          force: true,
        });
      } catch {
        // Already gone.
      }
    }
  }

  #send(socket: AskSocket, event: unknown): void {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // The socket closed between accepting the ask and sending the reply.
    }
  }
}

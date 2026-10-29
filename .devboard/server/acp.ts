import type { Subprocess } from "bun";

export interface AcpQuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface AcpQuestion {
  id: number | string;
  message: string;
  options: AcpQuestionOption[];
  properties: Record<string, unknown>;
  required: string[] | undefined;
}

export interface AcpConnectionOptions {
  command: string;
  cwd: string;
  /** The exact peer environment; omitted means the server's own. */
  env?: Record<string, string | undefined>;
  /**
   * `allow` selects the first allow option for a permission request. `deny`
   * cancels every request and every elicitation, for a peer that must answer
   * from its prompt alone. `read-only` cancels permission requests but still
   * surfaces elicitations as questions.
   */
  permissionPolicy?: "allow" | "deny" | "read-only";
  onActivity: (activity: AcpActivity) => void;
  /**
   * Called for every `session/update` frame, including tool progress that maps
   * to no visible activity line. An owner that bounds a silent turn uses it as
   * the peer's liveness signal.
   */
  onSessionUpdate?: () => void;
  onQuestion: (question: AcpQuestion) => void;
  /** Receives assistant message text only; thoughts and tool activity are dropped. */
  onText?: (text: string) => void;
  onStderr?: (text: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingQuestion extends AcpQuestion {
  wireId: number | string;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "devboard-adr-ui", version: "0.1.0" };

/** JSON-RPC parameters arrive as parsed JSON; narrow once before member access. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

interface ParsedOption {
  label: string;
  description?: string;
}

function parsedOption(entry: unknown): ParsedOption | undefined {
  if (typeof entry === "string") return { label: entry };
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const label = [record.title, record.const, record.label, record.value].find(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (label === undefined) return undefined;
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description
      : undefined;
  return description === undefined ? { label } : { label, description };
}

function propertyOptions(property: unknown): ParsedOption[] {
  const record = asRecord(property);
  if (record === undefined) return [];
  const containers = [record.enum, record.oneOf, record.anyOf];
  const items = asRecord(record.items);
  if (items !== undefined) {
    containers.push(items.enum, items.oneOf, items.anyOf, items.const);
  }
  containers.push(record.const);

  const options: ParsedOption[] = [];
  const labels = new Set<string>();
  for (const container of containers) {
    const entries = Array.isArray(container) ? container : container === undefined ? [] : [container];
    for (const entry of entries) {
      const option = parsedOption(entry);
      if (option === undefined || labels.has(option.label)) continue;
      labels.add(option.label);
      options.push(option);
    }
  }
  return options;
}

function propertyLabels(property: unknown): string[] {
  return propertyOptions(property).map((option) => option.label);
}

function questionOptions(properties: Record<string, unknown>): AcpQuestionOption[] {
  const options: AcpQuestionOption[] = [];
  const labels = new Set<string>();
  for (const [key, property] of Object.entries(properties)) {
    if (key.endsWith("__other")) continue;
    const record = asRecord(property);
    const recommended = typeof record?.default === "string" ? record.default : undefined;
    for (const option of propertyOptions(property)) {
      if (labels.has(option.label)) continue;
      labels.add(option.label);
      options.push({ ...option, recommended: option.label === recommended });
    }
  }
  // A question with choices always shows one recommendation: when the peer
  // omits a default, the first option is the suggestion the UI marks.
  const first = options[0];
  if (first !== undefined && !options.some((option) => option.recommended)) {
    first.recommended = true;
  }
  return options;
}

function answerContent(question: PendingQuestion, value: string): Record<string, unknown> {
  const keys = Object.keys(question.properties);
  const choiceKeys = keys.filter((key) => propertyLabels(question.properties[key]).length > 0);
  const matchingKey = choiceKeys.find((key) => propertyLabels(question.properties[key]).includes(value));

  if (matchingKey !== undefined) {
    const property = asRecord(question.properties[matchingKey]);
    return { [matchingKey]: property?.type === "array" ? [value] : value };
  }

  const primaryKey = choiceKeys[0];
  const otherKey = primaryKey === undefined ? undefined : `${primaryKey}__other`;
  if (otherKey !== undefined && Object.hasOwn(question.properties, otherKey)) {
    return { [otherKey]: value };
  }

  if (primaryKey !== undefined) return { [primaryKey]: value };

  const key =
    question.required?.find((candidate) => Object.hasOwn(question.properties, candidate)) ?? keys[0];
  if (key === undefined) return {};
  return { [key]: value };
}

/** One entry in the developer-facing activity log. */
export interface AcpActivity {
  text: string;
  /** True when `text` continues the previous activity line instead of starting one. */
  append: boolean;
}

/** The message whose streamed chunks are currently being joined. */
export interface ActivityStream {
  kind: string;
  messageId: string | undefined;
}

/**
 * Maps one ACP session update to an activity entry. Text updates arrive as
 * deltas of one assistant message, identified by `messageId`; a delta that
 * continues the stream already in progress is marked for appending so the log
 * shows the message, not its chunks. Without a message id a text update is
 * taken as a complete line.
 */
export function nextActivity(
  update: unknown,
  stream: ActivityStream | undefined,
): { activity: AcpActivity; stream: ActivityStream | undefined } | undefined {
  const notification = asRecord(update);
  if (notification === undefined) return undefined;

  switch (notification.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const content = asRecord(notification.content);
      const text = content?.text;
      if (typeof text !== "string" || text.length === 0) return undefined;
      const kind = notification.sessionUpdate;
      const messageId =
        typeof notification.messageId === "string" ? notification.messageId : undefined;
      const append =
        messageId !== undefined &&
        stream !== undefined &&
        stream.kind === kind &&
        stream.messageId === messageId;
      return { activity: { text, append }, stream: { kind, messageId } };
    }
    case "tool_call":
    case "tool_call_update": {
      const title = notification.title;
      if (typeof title !== "string" || title.length === 0) return undefined;
      return { activity: { text: title, append: false }, stream: undefined };
    }
    case "plan": {
      const entries = notification.entries;
      if (!Array.isArray(entries)) return undefined;
      const lines = entries
        .map((entry) => asRecord(entry)?.content)
        .filter((line): line is string => typeof line === "string" && line.length > 0);
      if (lines.length === 0) return undefined;
      return { activity: { text: lines.join("\n"), append: false }, stream: undefined };
    }
    default:
      return undefined;
  }
}

/** True when the peer rejected a prompt because its previous turn is still running. */
export function isSessionBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32003;
}

/**
 * A minimal ACP client: JSON-RPC 2.0 over newline-delimited JSON on the child's
 * stdio. It starts a session, sends one prompt, relays session updates as
 * activity, and holds elicitation requests until the developer answers.
 */
export class AcpConnection {
  readonly #process: Subprocess<"pipe", "pipe", "pipe">;
  readonly #options: AcpConnectionOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #questions = new Map<string, PendingQuestion>();
  readonly #argv: string[];
  #nextRequestId = 1;
  #closed = false;
  #closing = false;
  #sessionId: string | undefined;
  #activityStream: ActivityStream | undefined;

  constructor(options: AcpConnectionOptions) {
    this.#options = options;
    const argv = options.command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) throw new Error("AGENT_COMMAND is empty.");
    this.#argv = argv;

    this.#process = Bun.spawn(argv, {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void this.#readStdout();
    void this.#readStderr();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The child's pid, recorded so a replacement can end an orphaned peer. */
  get pid(): number | undefined {
    return this.#closed ? undefined : this.#process.pid;
  }

  /** The exact argv the child was spawned with, used to prove its identity. */
  get argv(): string[] {
    return [...this.#argv];
  }

  async run(prompt: string): Promise<unknown> {
    await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: CLIENT_INFO,
    });

    const session = asRecord(
      await this.#request("session/new", {
        cwd: this.#options.cwd,
        mcpServers: [],
      }),
    );

    const sessionId = session?.sessionId;
    if (typeof sessionId !== "string") {
      throw new Error("Agent did not return a session id.");
    }
    this.#sessionId = sessionId;

    return await this.prompt(prompt);
  }

  /** Sends another prompt on the session this connection opened. */
  async prompt(prompt: string): Promise<unknown> {
    if (this.#sessionId === undefined) throw new Error("No agent session is open.");
    return await this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
  }

  answer(id: number | string, value: string): boolean {
    const key = String(id);
    const question = this.#questions.get(key);
    if (question === undefined) return false;

    this.#questions.delete(key);
    this.#respond(question.wireId, {
      action: "accept",
      content: answerContent(question, value),
    });
    return true;
  }

  /**
   * Suspends the child without ending its ACP session. The pipe buffers keep
   * any answer written meanwhile, and the pending request survives.
   */
  pause(): boolean {
    if (this.#closed) return false;
    try {
      this.#process.kill("SIGSTOP");
      return true;
    } catch {
      return false;
    }
  }

  resume(): boolean {
    if (this.#closed) return false;
    try {
      this.#process.kill("SIGCONT");
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    try {
      // A stopped child does not process SIGTERM until it runs again.
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
      this.#questions.clear();
    }
  }

  async #readStderr(): Promise<void> {
    const reader = this.#process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        // A peer this process terminates reports its own shutdown on stderr.
        // That notice is a consequence of the close, not evidence of a fault,
        // so an owner must never journal it as an ACP failure.
        if (text.length > 0 && !this.#closing) this.#options.onStderr?.(text);
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
        this.#handleElicitation(id, params);
        return;
      case "session/request_permission": {
        if (
          this.#options.permissionPolicy === "deny" ||
          this.#options.permissionPolicy === "read-only"
        ) {
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
    this.#options.onSessionUpdate?.();
    const next = nextActivity(asRecord(params)?.update, this.#activityStream);
    if (next === undefined) return;
    this.#activityStream = next.stream;
    this.#options.onActivity(next.activity);
    if (next.stream?.kind === "agent_message_chunk") {
      this.#options.onText?.(next.activity.text);
    }
  }

  #handleElicitation(wireId: number | string, params: unknown): void {
    const request = asRecord(params);
    if (request === undefined) {
      this.#respond(wireId, { action: "cancel" });
      return;
    }
    if (this.#options.permissionPolicy === "deny") {
      this.#respond(wireId, { action: "cancel" });
      return;
    }
    const schema = asRecord(request.requestedSchema);
    const properties = asRecord(schema?.properties) ?? {};
    const required = Array.isArray(schema?.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : undefined;
    const message = typeof request.message === "string" ? request.message : "";

    const question: PendingQuestion = {
      id: wireId,
      wireId,
      message,
      options: questionOptions(properties),
      properties,
      required,
    };

    this.#questions.set(String(wireId), question);
    this.#options.onQuestion(question);
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

export function agentPrompt(adrDir: string, file: string): string {
  const path = `${adrDir.replace(/[\\/]+$/, "")}/${file}`;
  return [
    `/adr-resolve ${path}`,
    "",
    `Resolve only ${path}.`,
    "Do not open, read, or resolve any other record. Stop as soon as this record's `status` is no longer `proposed` or `draft`.",
  ].join("\n");
}

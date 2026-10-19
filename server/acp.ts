import type { Subprocess } from "bun";

export interface AcpQuestion {
  id: number | string;
  message: string;
  choices: string[];
  properties: Record<string, unknown>;
  required: string[] | undefined;
}

export interface AcpConnectionOptions {
  command: string;
  cwd: string;
  onActivity: (text: string) => void;
  onQuestion: (question: AcpQuestion) => void;
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

function propertyChoices(property: unknown): string[] {
  const record = asRecord(property);
  if (record === undefined) return [];
  const containers = [record.enum, record.oneOf, record.anyOf];
  const items = asRecord(record.items);
  if (items !== undefined) {
    containers.push(items.enum, items.oneOf, items.anyOf, items.const);
  }
  containers.push(record.const);

  const choices: string[] = [];
  for (const container of containers) {
    const entries = Array.isArray(container) ? container : container === undefined ? [] : [container];
    for (const entry of entries) {
      const entryRecord = asRecord(entry);
      const label =
        typeof entry === "string"
          ? entry
          : entryRecord !== undefined
            ? [entryRecord.title, entryRecord.const, entryRecord.label, entryRecord.value].find(
                (candidate): candidate is string => typeof candidate === "string",
              )
            : undefined;
      if (label !== undefined && !choices.includes(label)) choices.push(label);
    }
  }
  return choices;
}

function questionChoices(properties: Record<string, unknown>): string[] {
  const choices: string[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (key.endsWith("__other")) continue;
    for (const choice of propertyChoices(property)) {
      if (!choices.includes(choice)) choices.push(choice);
    }
  }
  return choices;
}

function answerContent(question: PendingQuestion, value: string): Record<string, unknown> {
  const keys = Object.keys(question.properties);
  const choiceKeys = keys.filter((key) => propertyChoices(question.properties[key]).length > 0);
  const matchingKey = choiceKeys.find((key) => propertyChoices(question.properties[key]).includes(value));

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

function activityText(update: unknown): string | undefined {
  const notification = asRecord(update);
  if (notification === undefined) return undefined;

  switch (notification.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const content = asRecord(notification.content);
      const text = content?.text;
      return typeof text === "string" && text.length > 0 ? text : undefined;
    }
    case "tool_call":
    case "tool_call_update": {
      const title = notification.title;
      return typeof title === "string" && title.length > 0 ? title : undefined;
    }
    case "plan": {
      const entries = notification.entries;
      if (!Array.isArray(entries)) return undefined;
      const lines = entries
        .map((entry) => asRecord(entry)?.content)
        .filter((line): line is string => typeof line === "string" && line.length > 0);
      return lines.length > 0 ? lines.join("\n") : undefined;
    }
    default:
      return undefined;
  }
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
  #nextRequestId = 1;
  #closed = false;
  #sessionId: string | undefined;

  constructor(options: AcpConnectionOptions) {
    this.#options = options;
    const argv = options.command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) throw new Error("AGENT_COMMAND is empty.");

    this.#process = Bun.spawn(argv, {
      cwd: options.cwd,
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

    return await this.#request("session/prompt", {
      sessionId,
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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
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
        if (text.length > 0) this.#options.onStderr?.(text);
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
      pending.reject(new Error(message.error.message ?? "Agent request failed."));
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
    const text = activityText(asRecord(params)?.update);
    if (text !== undefined) this.#options.onActivity(text);
  }

  #handleElicitation(wireId: number | string, params: unknown): void {
    const request = asRecord(params);
    if (request === undefined) {
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
      choices: questionChoices(properties),
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
    "Do not open, read, or resolve any other record. Stop as soon as this record's status is no longer Proposed.",
  ].join("\n");
}

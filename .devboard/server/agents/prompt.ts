import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isHarnessSourceCheckout } from "../version";
import {
  AcpConnection,
  type AcpActivity,
  type AcpQuestion,
} from "../acp";
import type { AgentRegistry } from "./registry";

/**
 * The prompt half of a background agent's page. Auto Scout runs one agent per
 * scan, so its page shows the command and the effective prompt file. Watchdog
 * runs no agent at all and says so. Editing exists only where the dashboard
 * serves the harness source checkout: an installed prefix is read-only, and
 * every prompt command from it is refused without touching a file.
 */

export const SCOUT_PROMPT_FILE = "scout-recommendations.md";
export const PROMPT_CHAT_FILE = "agent-prompt-chat.md";
const CHAT_TIMEOUT_MS = 5 * 60_000;
const SCAN_ID_PLACEHOLDER = "<scan-id>";

/** One agent's prompt section, as the browser renders it. */
export interface AgentPromptState {
  id: string;
  /** True for an agent that runs no agent and therefore has no prompt. */
  absent: boolean;
  editable: boolean;
  /** The invocation the worker passes, with the scan id still unassigned. */
  command: string | null;
  /** The effective prompt file's bytes, or null when it cannot be read. */
  text: string | null;
  error: string | null;
}

export interface AgentPromptSocket {
  send(data: string): unknown;
}

export interface AgentPromptOptions {
  registry: AgentRegistry;
  repoDir: string;
  agentCommand: string;
  agentEnvironment: () => Promise<Record<string, string | undefined>>;
  /** The harness that carries the chat instructions; installed or source. */
  harnessDir: string;
  /** Sends an event to every connected client. */
  send: (event: unknown, except?: AgentPromptSocket) => void;
  log?: (line: string) => void;
}

/**
 * The complete replacement prompt a chat turn proposed, or null. The markers
 * are line-anchored so a prompt that itself contains Markdown fences survives
 * intact.
 */
export function parsePromptProposal(reply: string): string | null {
  const block = /^<prompt-file>\r?\n([\s\S]*?)^<\/prompt-file>\r?$/gm;
  let proposal: string | null = null;
  for (const match of reply.matchAll(block)) {
    proposal = match[1] ?? null;
  }
  return proposal;
}

/** The turn the chat agent receives: its instructions, the base, the request. */
export function buildChatPrompt(instructions: string, base: string, message: string): string {
  return [
    instructions.trimEnd(),
    "",
    "## Current prompt",
    "",
    "The text between the two markers is the complete file the operator currently has in the",
    "editor.",
    "",
    "<<<PROMPT",
    base,
    "PROMPT>>>",
    "",
    "## Operator request",
    "",
    message,
  ].join("\n");
}

export class AgentPromptController {
  private readonly registry: AgentRegistry;
  private readonly repoDir: string;
  private readonly agentCommand: string;
  private readonly agentEnvironment: () => Promise<Record<string, string | undefined>>;
  private readonly harnessDir: string;
  private readonly send: (event: unknown, except?: AgentPromptSocket) => void;
  private readonly log: (line: string) => void;
  private peer: AcpConnection | undefined;
  private peerOpen = false;
  private emitChunk: ((chunk: string) => void) | undefined;
  private chatQueue: Promise<void> = Promise.resolve();
  private turn = 0;

  constructor(options: AgentPromptOptions) {
    this.registry = options.registry;
    this.repoDir = resolve(options.repoDir);
    this.agentCommand = options.agentCommand;
    this.agentEnvironment = options.agentEnvironment;
    this.harnessDir = options.harnessDir;
    this.send = options.send;
    this.log = options.log ?? (() => undefined);
  }

  dispose(): void {
    this.peer?.close();
    this.peer = undefined;
    this.peerOpen = false;
  }

  /** The prompt file the command `/scout-recommendations` opens. */
  promptPath(): string {
    return join(this.repoDir, ".devboard", "prompts", SCOUT_PROMPT_FILE);
  }

  private chatInstructionsPath(): string {
    return join(this.harnessDir, "prompts", PROMPT_CHAT_FILE);
  }

  snapshot(id: string): AgentPromptState | null {
    const descriptor = this.registry.get(id);
    if (descriptor === undefined) return null;
    if (id !== "scout") {
      return {
        id,
        absent: true,
        editable: false,
        command: null,
        text: null,
        error: null,
      };
    }
    const path = this.promptPath();
    let text: string | null = null;
    let error: string | null = null;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      error =
        `Could not read the Auto Scout prompt at ${path}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return {
      id,
      absent: false,
      editable: isHarnessSourceCheckout(this.repoDir),
      command:
        `/scout-recommendations ${join(
          this.repoDir,
          ".devboard",
          ".tmp",
          "scout",
          "scans",
          SCAN_ID_PLACEHOLDER,
        )}`,
      text,
      error,
    };
  }

  /** Sends both agents' prompt state to one client on connect. */
  replay(target: AgentPromptSocket): void {
    for (const descriptor of this.registry.descriptors) {
      this.sendTo(target, {
        type: "agentPromptState",
        id: descriptor.id,
        prompt: this.snapshot(descriptor.id),
      });
    }
  }

  replayOne(target: AgentPromptSocket, id: string): void {
    const prompt = this.snapshot(id);
    if (prompt === null) {
      this.sendTo(target, {
        type: "agentPromptError",
        id,
        message: `Unknown background agent: ${id}.`,
      });
      return;
    }
    this.sendTo(target, { type: "agentPromptState", id, prompt });
  }

  /** The one refusal every prompt command shares, or null when it may run. */
  private refusal(id: string): string | null {
    const descriptor = this.registry.get(id);
    if (descriptor === undefined) return `Unknown background agent: ${id}.`;
    if (id !== "scout") {
      return `${descriptor.label} runs no agent and has no prompt.`;
    }
    if (!isHarnessSourceCheckout(this.repoDir)) {
      return "Editing the Auto Scout prompt requires a harness source checkout.";
    }
    return null;
  }

  /** Writes the editor's exact bytes, and only when the operator saved. */
  save(target: AgentPromptSocket, id: string, text: unknown): void {
    const refusal = this.refusal(id);
    if (refusal !== null) {
      this.sendTo(target, { type: "agentPromptError", id, message: refusal });
      return;
    }
    if (typeof text !== "string") {
      this.sendTo(target, {
        type: "agentPromptError",
        id,
        message: "A prompt save needs the editor's text.",
      });
      return;
    }
    const path = this.promptPath();
    try {
      writeFileSync(path, text, "utf8");
    } catch (cause) {
      this.sendTo(target, {
        type: "agentPromptError",
        id,
        message:
          `Could not write the Auto Scout prompt: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }
    this.sendTo(target, {
      type: "agentPromptSaved",
      id,
      text,
      notice: "Prompt saved. The next scan reads this file.",
    });
    this.send({ type: "agentPromptState", id, prompt: this.snapshot(id) });
  }

  /** One chat turn at a time; the reply streams to the client and writes nothing. */
  chat(
    target: AgentPromptSocket,
    id: string,
    message: unknown,
    text: unknown,
  ): Promise<void> {
    const turn = this.chatQueue.then(() => this.chatOnce(target, id, message, text));
    this.chatQueue = turn.catch(() => undefined);
    return turn;
  }

  private async chatOnce(
    target: AgentPromptSocket,
    id: string,
    message: unknown,
    text: unknown,
  ): Promise<void> {
    const refusal = this.refusal(id);
    if (refusal !== null) {
      this.sendTo(target, { type: "agentPromptChatError", id, message: refusal });
      return;
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      this.sendTo(target, {
        type: "agentPromptChatError",
        id,
        message: "A chat turn needs a message.",
      });
      return;
    }
    let instructions: string;
    let base: string;
    try {
      instructions = readFileSync(this.chatInstructionsPath(), "utf8");
      base = typeof text === "string" ? text : readFileSync(this.promptPath(), "utf8");
    } catch (cause) {
      this.sendTo(target, {
        type: "agentPromptChatError",
        id,
        message:
          `Could not read the prompt chat instructions: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }

    const peer = await this.connection(target, id);
    if (peer === undefined) return;
    const turnId = `${Date.now()}-${this.turn++}`;
    let reply = "";
    this.emitChunk = (chunk) => {
      if (chunk.length === 0) return;
      reply += chunk;
      this.sendTo(target, {
        type: "agentPromptChat",
        id,
        turnId,
        role: "assistant",
        text: chunk,
        append: true,
      });
    };
    const prompt = buildChatPrompt(instructions, base, message);
    const bounded = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => bounded.reject(new Error("the prompt chat agent did not answer in time")),
      CHAT_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      await Promise.race([this.peerOpen ? peer.prompt(prompt) : peer.run(prompt), bounded.promise]);
      this.peerOpen = true;
      this.sendTo(target, {
        type: "agentPromptChatDone",
        id,
        turnId,
        proposal: parsePromptProposal(reply),
      });
    } catch (cause) {
      this.peer?.close();
      this.peer = undefined;
      this.peerOpen = false;
      this.sendTo(target, {
        type: "agentPromptChatError",
        id,
        message: `The prompt chat failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    } finally {
      clearTimeout(timer);
      this.emitChunk = undefined;
    }
  }

  /**
   * One multi-turn ACP session per dashboard, opened on the first chat turn
   * and reused after it. A peer that exited is replaced on the next turn.
   */
  private async connection(
    target: AgentPromptSocket,
    id: string,
  ): Promise<AcpConnection | undefined> {
    if (this.peer !== undefined && !this.peer.closed) return this.peer;
    this.peer?.close();
    this.peer = undefined;
    this.peerOpen = false;
    try {
      const environment = await this.agentEnvironment();
      this.peer = new AcpConnection({
        command: this.agentCommand,
        cwd: this.repoDir,
        env: environment,
        onActivity: (_activity: AcpActivity) => undefined,
        onText: (chunk) => this.emitChunk?.(chunk),
        onQuestion: (question) => this.answer(question),
        onStderr: (line) => this.log(`prompt chat: ${line.trim()}`),
      });
      return this.peer;
    } catch (cause) {
      this.sendTo(target, {
        type: "agentPromptChatError",
        id,
        message:
          `Could not start the prompt chat agent: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return undefined;
    }
  }

  /** A chat peer never waits on the operator; it takes the recommendation. */
  private answer(question: AcpQuestion): void {
    const choice = question.options.find((option) => option.recommended) ?? question.options[0];
    this.peer?.answer(question.id, choice?.label ?? "yes");
  }

  private sendTo(target: AgentPromptSocket, event: unknown): void {
    try {
      target.send(JSON.stringify(event));
    } catch {
      // The socket closed.
    }
  }
}

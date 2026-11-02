import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DISCOVER_AGENTS,
  discoverAgent,
  type AgentDescriptor,
  type AgentRegistry,
} from "./registry";

/**
 * The prompt half of a background agent's page. A descriptor with a prompt
 * file shows that effective file; a descriptor without one states its absence.
 * The bytes are the same in a harness source checkout and an installed host:
 * no prompt command writes a file.
 */

/** One agent's prompt section, as the browser renders it. */
export interface AgentPromptState {
  id: string;
  /** True when the descriptor declares no prompt file. */
  absent: boolean;
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
}

export class AgentPromptController {
  private readonly registry: AgentRegistry;
  private readonly repoDir: string;

  constructor(options: AgentPromptOptions) {
    this.registry = options.registry;
    this.repoDir = resolve(options.repoDir);
  }

  /** The file a descriptor's prompt section reads. */
  private promptPath(descriptor: AgentDescriptor): string {
    if (descriptor.prompt.kind !== "file") {
      throw new Error(`${descriptor.label} has no prompt file.`);
    }
    return join(this.repoDir, ".devboard", "prompts", descriptor.prompt.file);
  }

  snapshot(id: string): AgentPromptState | null {
    const descriptor = this.registry.get(id);
    if (descriptor === undefined) return null;
    if (descriptor.prompt.kind === "absent") {
      return {
        id,
        absent: true,
        text: null,
        error: null,
      };
    }
    const path = this.promptPath(descriptor);
    let text: string | null = null;
    let error: string | null = null;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      error =
        `Could not read the ${descriptor.label} prompt at ${path}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return {
      id,
      absent: false,
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

  private sendTo(target: AgentPromptSocket, event: unknown): void {
    try {
      target.send(JSON.stringify(event));
    } catch {
      // The socket closed.
    }
  }
}

// ------------------------------------------------------- discover prompts

/**
 * The prompt half of the seven Discover agent cards. Each card reads exactly
 * its own prompt file; the bytes are the same in a harness source checkout and
 * an installed host, and no prompt command writes a file.
 */

export interface DiscoverPromptState {
  /** The Discover agent this prompt belongs to. */
  agent: string;
  text: string | null;
  error: string | null;
}

export interface DiscoverPromptControllerOptions {
  repoDir: string;
}

export class DiscoverPromptController {
  private readonly repoDir: string;

  constructor(options: DiscoverPromptControllerOptions) {
    this.repoDir = resolve(options.repoDir);
  }

  snapshot(id: string): DiscoverPromptState | null {
    const descriptor = discoverAgent(id);
    if (descriptor === undefined) return null;
    let text: string | null = null;
    let error: string | null = null;
    try {
      text = readFileSync(
        join(this.repoDir, ".devboard", "prompts", descriptor.promptFile),
        "utf8",
      );
    } catch (cause) {
      error =
        `Could not read the ${descriptor.label} prompt: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return {
      agent: id,
      text,
      error,
    };
  }

  /** Every card's prompt state, sent before a client's own command replies. */
  replay(target: AgentPromptSocket): void {
    for (const descriptor of DISCOVER_AGENTS) {
      this.sendTo(target, {
        type: "discoverPromptState",
        agent: descriptor.id,
        prompt: this.snapshot(descriptor.id),
      });
    }
  }

  private sendTo(target: AgentPromptSocket, event: unknown): void {
    try {
      target.send(JSON.stringify(event));
    } catch {
      // The socket closed.
    }
  }
}

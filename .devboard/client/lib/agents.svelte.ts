import { agentRegistry } from "../../server/agents/registry";
import type {
  AgentActivityDetail,
  AgentDescriptor,
  AgentPromptState,
  AgentSnapshot,
} from "./types";
import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityDetail(value: unknown): value is AgentActivityDetail {
  return (
    isObject(value) &&
    value.panel === "activity" &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => typeof entry === "string")
  );
}

/** A snapshot is trusted only when it carries every shared fact. */
function isSnapshot(value: unknown): value is AgentSnapshot {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.label !== "string") return false;
  if (typeof value.lifecycle !== "string") return false;
  if (!isObject(value.cadence) || typeof value.cadence.minutes !== "number") return false;
  if (!isObject(value.limits) || !Array.isArray(value.issues)) return false;
  if (!isObject(value.sync) || typeof value.sync.state !== "string") return false;
  if (!isObject(value.detail) || typeof value.detail.panel !== "string") return false;
  return true;
}

interface ActivityEntry {
  text: string;
  append: boolean;
}

/** One visible prompt-chat turn; assistant chunks append to the same entry. */
export interface PromptChatEntry {
  turnId: string;
  role: "user" | "assistant";
  text: string;
}

/** A chat turn's proposed complete prompt, waiting for an explicit Save. */
export interface PromptProposal {
  turnId: string;
  text: string;
}

function isEntry(value: unknown): value is ActivityEntry {
  return isObject(value) && typeof value.text === "string" && typeof value.append === "boolean";
}

function applyActivity(lines: string[], entries: ActivityEntry[], replay: boolean): string[] {
  const next = replay ? [] : [...lines];
  for (const entry of entries) {
    if (entry.append && next.length > 0) next[next.length - 1] += entry.text;
    else next.push(entry.text);
  }
  return next;
}

/**
 * The one store behind every background-agent page. It never polls and never
 * starts a worker: the server replays both agents on connect and pushes a
 * changed snapshot, while controls only send commands carrying the agent id.
 */
export class AgentsStore {
  snapshots = $state<Record<string, AgentSnapshot>>({});
  activity = $state<Record<string, string[]>>({});
  activityScan = $state<Record<string, string | null>>({});
  prompts = $state<Record<string, AgentPromptState>>({});
  promptChat = $state<Record<string, PromptChatEntry[]>>({});
  promptProposal = $state<Record<string, PromptProposal | null>>({});
  promptError = $state<Record<string, string | null>>({});
  promptChatError = $state<Record<string, string | null>>({});
  promptNotice = $state<Record<string, string | null>>({});
  private readonly seen = new Set<string>();
  private readonly lastError = new Map<string, string | null>();
  private readonly lastNotice = new Map<string, string | null>();

  get descriptors(): readonly AgentDescriptor[] {
    return agentRegistry.descriptors;
  }

  snapshot(id: string): AgentSnapshot | null {
    return this.snapshots[id] ?? null;
  }

  order(): AgentSnapshot[] {
    return agentRegistry.descriptors
      .map((descriptor) => this.snapshots[descriptor.id])
      .filter((snapshot): snapshot is AgentSnapshot => snapshot !== undefined);
  }

  count(id: string): number {
    return this.snapshots[id]?.pending ?? 0;
  }

  lifecycle(id: string): string {
    return this.snapshots[id]?.lifecycle ?? "stopped";
  }

  detail(id: string): AgentActivityDetail | null {
    const detail = this.snapshots[id]?.detail;
    return detail?.panel === "activity" ? detail : null;
  }

  start(id: string): void {
    connection.send({ type: "startAgent", id });
  }

  stop(id: string): void {
    connection.send({ type: "stopAgent", id });
  }

  saveSettings(
    id: string,
    minutes: number,
    maxPerHour: number | null,
    maxPending: number | null,
  ): void {
    connection.send({ type: "setAgentSettings", id, minutes, maxPerHour, maxPending });
  }

  disableTimer(id: string): void {
    connection.send({ type: "disableAgentTimer", id });
  }

  /** Sends the editor's exact text; the server writes only this command. */
  savePrompt(id: string, text: string): void {
    this.promptError[id] = null;
    this.promptNotice[id] = null;
    connection.send({ type: "saveAgentPrompt", id, text });
  }

  sendPromptChat(id: string, message: string, text: string): void {
    this.promptChatError[id] = null;
    this.promptNotice[id] = null;
    const entries = this.promptChat[id] ?? [];
    entries.push({ turnId: "pending", role: "user", text: message });
    this.promptChat[id] = entries;
    connection.send({ type: "sendAgentPromptChat", id, message, text });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "agentPromptState" && typeof message.id === "string") {
      const prompt = message.prompt as AgentPromptState | null;
      if (prompt !== null && typeof prompt === "object") this.prompts[message.id] = prompt;
      return;
    }
    if (message.type === "agentPromptSaved" && typeof message.id === "string") {
      this.promptNotice[message.id] =
        typeof message.notice === "string" ? message.notice : "Prompt saved.";
      this.promptError[message.id] = null;
      const prompt = this.prompts[message.id];
      if (prompt !== undefined && typeof message.text === "string") {
        this.prompts[message.id] = { ...prompt, text: message.text };
      }
      return;
    }
    if (message.type === "agentPromptError" && typeof message.id === "string") {
      this.promptError[message.id] =
        typeof message.message === "string" ? message.message : "The prompt command failed.";
      this.promptNotice[message.id] = null;
      return;
    }
    if (message.type === "agentPromptChatError" && typeof message.id === "string") {
      this.promptChatError[message.id] =
        typeof message.message === "string" ? message.message : "The prompt chat failed.";
      return;
    }
    if (
      message.type === "agentPromptChat" &&
      typeof message.id === "string" &&
      typeof message.turnId === "string" &&
      typeof message.text === "string"
    ) {
      const id = message.id;
      const entries = this.promptChat[id] ?? [];
      const last = entries[entries.length - 1];
      if (last !== undefined && last.role === "assistant" && last.turnId === message.turnId) {
        last.text += message.text;
      } else {
        entries.push({ turnId: message.turnId, role: "assistant", text: message.text });
      }
      this.promptChat[id] = entries;
      return;
    }
    if (
      message.type === "agentPromptChatDone" &&
      typeof message.id === "string" &&
      typeof message.turnId === "string"
    ) {
      const proposal = message.proposal;
      if (typeof proposal === "string" && proposal.length > 0) {
        this.promptProposal[message.id] = { turnId: message.turnId, text: proposal };
      }
      return;
    }
    if (message.type === "agentsState" && Array.isArray(message.agents)) {
      for (const snapshot of message.agents) this.accept(snapshot);
      return;
    }
    if (message.type === "agentState") {
      this.accept(message.agent);
      return;
    }
    if (
      message.type === "agentActivity" &&
      typeof message.id === "string" &&
      typeof message.scanId === "string"
    ) {
      const id = message.id;
      const current = this.snapshots[id]?.detail;
      const currentScan =
        current?.panel === "activity" ? current.scanId : (this.activityScan[id] ?? null);
      if (currentScan !== null && message.scanId !== currentScan) return;
      this.activityScan[id] = message.scanId;
      const entries = Array.isArray(message.entries)
        ? message.entries.filter(isEntry)
        : [];
      this.activity[id] = applyActivity(
        this.activity[id] ?? [],
        entries,
        message.replay === true,
      );
    }
  }

  private accept(value: unknown): void {
    if (!isSnapshot(value)) return;
    const first = !this.seen.has(value.id);
    this.seen.add(value.id);
    const previousError = this.lastError.get(value.id) ?? null;
    this.snapshots[value.id] = value;
    if (value.detail.panel === "activity" && isActivityDetail(value.detail)) {
      const currentScan = this.activityScan[value.id] ?? null;
      if (currentScan !== value.detail.scanId) {
        this.activityScan[value.id] = value.detail.scanId;
        this.activity[value.id] = [...value.detail.entries];
      }
    }
    if (value.error !== previousError) {
      this.lastError.set(value.id, value.error);
      if (!first && value.error !== null) {
        notifications.push("Background agents", "error", value.error);
      }
    }
    const previousNotice = this.lastNotice.get(value.id) ?? null;
    if (value.notice !== previousNotice) {
      this.lastNotice.set(value.id, value.notice);
      if (!first && value.notice !== null && value.notice.startsWith("Filed ")) {
        notifications.push(
          value.label === "Auto Scout" ? "Auto Scout" : "Background agents",
          "success",
          value.notice,
        );
      }
    }
  }
}

export const agents = new AgentsStore();

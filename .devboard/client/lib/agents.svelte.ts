import { agentRegistry } from "../../server/agents/registry";
import type {
  AgentActivityDetail,
  AgentDescriptor,
  AgentPromptState,
  AgentSnapshot,
  RunQuestion,
} from "./types";
import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { saveFeedback } from "./save-feedback.svelte";

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

/** One comparable key for the three settings a save sends. */
function settingsSignature(
  minutes: number,
  maxPerHour: number | null,
  maxPending: number | null,
): string {
  return `${minutes}/${maxPerHour ?? "-"}/${maxPending ?? "-"}`;
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
  private readonly seen = new Set<string>();
  private readonly lastError = new Map<string, string | null>();
  private readonly lastNotice = new Map<string, string | null>();
  /** Settings sent per agent, kept until a snapshot echoes them. */
  private readonly pendingSettings = new Map<
    string,
    { signature: string; scope: string }
  >();

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

  /** The sidebar count: the rows the agent's page lists. */
  count(id: string): number {
    const snapshot = this.snapshots[id];
    if (snapshot === undefined) return 0;
    if (agentRegistry.get(id)?.releases !== undefined) {
      return snapshot.releases?.length ?? 0;
    }
    return snapshot.issues.length;
  }

  lifecycle(id: string): string {
    return this.snapshots[id]?.lifecycle ?? "stopped";
  }

  /**
   * A background agent's pending operator question, when its snapshot carries
   * one. No current descriptor asks, so this stays null until an agent does.
   */
  question(id: string): RunQuestion | null {
    const value = (this.snapshots[id] as { question?: RunQuestion | null } | undefined)?.question;
    return value ?? null;
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

  pause(id: string): void {
    connection.send({ type: "pauseAgent", id });
  }

  resume(id: string): void {
    connection.send({ type: "resumeAgent", id });
  }

  /** Ask the adapter for a fresh read; the Release Train runs its gate. */
  checkNow(id: string): void {
    connection.send({ type: "refreshAgent", id });
  }

  saveSettings(
    id: string,
    minutes: number,
    maxPerHour: number | null,
    maxPending: number | null,
    scope: string,
  ): void {
    if (
      connection.send({ type: "setAgentSettings", id, minutes, maxPerHour, maxPending })
    ) {
      this.pendingSettings.set(id, {
        signature: settingsSignature(minutes, maxPerHour, maxPending),
        scope,
      });
    }
  }

  disableTimer(id: string): void {
    connection.send({ type: "disableAgentTimer", id });
  }

  /**
   * A page opened this agent: ask for one fresh read. The server only answers
   * an attached worker, and a page opened before the socket settles sends it
   * when the connection opens.
   */
  refresh(id: string): void {
    if (!connection.open) return;
    connection.send({ type: "refreshAgent", id });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "agentPromptState" && typeof message.id === "string") {
      const prompt = message.prompt as AgentPromptState | null;
      if (prompt !== null && typeof prompt === "object") this.prompts[message.id] = prompt;
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
        notifications.push(value.label, "error", value.error);
      }
    }
    const pending = this.pendingSettings.get(value.id);
    if (
      pending !== undefined &&
      settingsSignature(
        value.cadence.minutes,
        value.limits.maxPerHour,
        value.limits.maxPending,
      ) === pending.signature
    ) {
      this.pendingSettings.delete(value.id);
      saveFeedback.saved(pending.scope, `${value.label} settings saved.`);
    }
    const previousNotice = this.lastNotice.get(value.id) ?? null;
    if (value.notice !== previousNotice) {
      this.lastNotice.set(value.id, value.notice);
      if (!first && value.notice !== null && value.notice.startsWith("Filed ")) {
        notifications.push(value.label, "success", value.notice);
      }
    }
  }
}

export const agents = new AgentsStore();

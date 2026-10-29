import { agentRegistry } from "../../server/agents/registry";
import type { AgentActivityDetail, AgentDescriptor, AgentSnapshot } from "./types";
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

  handleEvent(message: Record<string, unknown>): void {
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

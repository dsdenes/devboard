import {
  AgentRegistryError,
  agentRegistry,
  projectAgentSnapshot,
} from "../../lib/agent-registry.ts";
import type {
  AgentActivityDetail,
  AgentDescriptor,
  AgentPromptState,
  AgentSnapshot,
  AgentSnapshotInput,
  RunQuestion,
} from "./types";
import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { saveFeedback } from "./save-feedback.svelte";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  /** Reads the agents resource; the poll repeats it once a second. */
  request(): void {
    connection.send({ type: "getAgents" }, "refresh");
  }

  snapshots = $state<Record<string, AgentSnapshot>>({});
  activity = $state<Record<string, string[]>>({});
  activityScan = $state<Record<string, string | null>>({});
  prompts = $state<Record<string, AgentPromptState>>({});
  /** A refused prompt read's text, cleared when that agent's prompt arrives. */
  promptErrors = $state<Record<string, string>>({});
  private readonly seen = new Set<string>();
  private readonly lastError = new Map<string, string | null>();
  private readonly lastNotice = new Map<string, string | null>();
  /**
   * Increments on every accepted snapshot for an agent, including one whose
   * values repeat. A command control latches this instead of a domain field,
   * so every answering frame releases its busy word.
   */
  private readonly revisions = $state<Record<string, number>>({});
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
   * The number of accepted `agentState` frames for an agent. It changes on
   * every answering frame, even one that repeats the current values, so a
   * Start or Stop control never waits for the ceiling after the server
   * answered.
   */
  revision(id: string): number {
    return this.revisions[id] ?? 0;
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

  /**
   * One settings command for all three fields. Returns false when the socket
   * refused the envelope, so the control never waits for an answer it never
   * asked for.
   */
  saveSettings(
    id: string,
    minutes: number,
    maxPerHour: number | null,
    maxPending: number | null,
    scope: string,
  ): boolean {
    if (
      !connection.send({ type: "setAgentSettings", id, minutes, maxPerHour, maxPending })
    ) {
      return false;
    }
    this.pendingSettings.set(id, {
      signature: settingsSignature(minutes, maxPerHour, maxPending),
      scope,
    });
    return true;
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

  /**
   * The prompt section opened for this agent: ask for its document. The
   * store's snapshot read carries no prompt, and a section mounted before the
   * socket settles sends this when it opens.
   */
  readPrompt(id: string): void {
    if (!connection.open) return;
    connection.send({ type: "getAgentPrompt", id });
  }

  /** The section closed: stop polling a prompt no page shows. */
  forgetPrompt(id: string): void {
    connection.forget({ type: "getAgentPrompt", id });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "agentPromptState" && typeof message.id === "string") {
      const prompt = message.prompt as AgentPromptState | null;
      if (prompt !== null && typeof prompt === "object") {
        this.prompts[message.id] = prompt;
        delete this.promptErrors[message.id];
      }
      return;
    }
    if (message.type === "agentPromptError" && typeof message.id === "string") {
      this.promptErrors[message.id] =
        typeof message.message === "string" && message.message.length > 0
          ? message.message
          : "The prompt could not be read.";
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

  /**
   * A snapshot is stored only when the shared projection accepts it: it carries
   * every fact the page reads, so no render path dereferences a missing field.
   */
  private accept(value: unknown): void {
    if (!isObject(value) || typeof value.id !== "string") return;
    const descriptor = agentRegistry.get(value.id);
    if (descriptor === undefined) return;
    let snapshot: AgentSnapshot;
    try {
      snapshot = projectAgentSnapshot(descriptor, value as unknown as AgentSnapshotInput);
    } catch (error) {
      if (error instanceof AgentRegistryError) return;
      throw error;
    }
    const first = !this.seen.has(snapshot.id);
    this.seen.add(snapshot.id);
    this.revisions[snapshot.id] = (this.revisions[snapshot.id] ?? 0) + 1;
    const previousError = this.lastError.get(snapshot.id) ?? null;
    this.snapshots[snapshot.id] = snapshot;
    if (snapshot.detail.panel === "activity") {
      const currentScan = this.activityScan[snapshot.id] ?? null;
      if (currentScan !== snapshot.detail.scanId) {
        this.activityScan[snapshot.id] = snapshot.detail.scanId;
        this.activity[snapshot.id] = [...snapshot.detail.entries];
      }
    }
    if (snapshot.error !== previousError) {
      this.lastError.set(snapshot.id, snapshot.error);
      if (!first && snapshot.error !== null) {
        notifications.push(snapshot.label, "error", snapshot.error);
      }
    }
    const pending = this.pendingSettings.get(snapshot.id);
    if (
      pending !== undefined &&
      settingsSignature(
        snapshot.cadence.minutes,
        snapshot.limits.maxPerHour,
        snapshot.limits.maxPending,
      ) === pending.signature
    ) {
      this.pendingSettings.delete(snapshot.id);
      saveFeedback.saved(pending.scope, `${snapshot.label} settings saved.`);
    }
    const previousNotice = this.lastNotice.get(snapshot.id) ?? null;
    if (snapshot.notice !== previousNotice) {
      this.lastNotice.set(snapshot.id, snapshot.notice);
      if (!first && snapshot.notice !== null && snapshot.notice.startsWith("Filed ")) {
        notifications.push(snapshot.label, "success", snapshot.notice);
      }
    }
  }
}

export const agents = new AgentsStore();

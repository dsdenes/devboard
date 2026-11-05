import { connection } from "./connection.svelte";
import { saveFeedback } from "./save-feedback.svelte";

/** The budget and cap the governor applies, in whole MiB and peer slots. */
export interface ResourceSettings {
  maxAgentPeers: number;
  memoryHighMb: number;
  memoryMaxMb: number;
  memoryReserveMb: number;
}

/** The governor's current counters; the slice fields are zero without one. */
export interface ResourceLive {
  activeAgents: number;
  availableMb: number;
  slicePresent: boolean;
  memoryHighMb: number;
  memoryMaxMb: number;
  memoryCurrentMb: number;
}

/** The saved values, the effective values, and the live counters. */
export interface ResourcesState {
  /** The values explicitly saved to disk; null while the server derives all four. */
  saved: ResourceSettings | null;
  effective: ResourceSettings;
  live: ResourceLive;
}

/** A non-negative finite figure; anything else is a value the server never sent. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** One complete settings row, or `undefined` when any figure is malformed. */
function settingsRow(value: unknown): ResourceSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (
    !isCount(row.maxAgentPeers) ||
    !isCount(row.memoryHighMb) ||
    !isCount(row.memoryMaxMb) ||
    !isCount(row.memoryReserveMb)
  ) {
    return undefined;
  }
  return {
    maxAgentPeers: row.maxAgentPeers,
    memoryHighMb: row.memoryHighMb,
    memoryMaxMb: row.memoryMaxMb,
    memoryReserveMb: row.memoryReserveMb,
  };
}

/** One live-counters row, or `undefined` when any figure is malformed. */
function liveRow(value: unknown): ResourceLive | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.slicePresent !== "boolean") return undefined;
  if (
    !isCount(row.activeAgents) ||
    !isCount(row.availableMb) ||
    !isCount(row.memoryHighMb) ||
    !isCount(row.memoryMaxMb) ||
    !isCount(row.memoryCurrentMb)
  ) {
    return undefined;
  }
  return {
    activeAgents: row.activeAgents,
    availableMb: row.availableMb,
    slicePresent: row.slicePresent,
    memoryHighMb: row.memoryHighMb,
    memoryMaxMb: row.memoryMaxMb,
    memoryCurrentMb: row.memoryCurrentMb,
  };
}

/**
 * The resources frame the server pushes. A malformed section drops the whole
 * frame rather than leaving the form or the counters showing a value the
 * server never sent, so no NaN ever reaches a field or a label.
 */
export function parseResourcesState(value: unknown): ResourcesState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as Record<string, unknown>;
  const effective = settingsRow(frame.effective);
  const live = liveRow(frame.live);
  if (effective === undefined || live === undefined) return undefined;
  let saved: ResourceSettings | null = null;
  if (frame.saved !== null && frame.saved !== undefined) {
    const row = settingsRow(frame.saved);
    if (row === undefined) return undefined;
    saved = row;
  }
  return { saved, effective, live };
}

/**
 * Holds the resource governor's budget. The page asks once per connection and
 * renders each frame the server pushes; a save only reports success once the
 * server broadcasts the frame that follows it.
 */
export class ResourcesStore {
  state = $state<ResourcesState | null>(null);
  /** The Save control waiting for the next frame, if any. */
  private pendingScope: string | null = null;

  request(): void {
    connection.send({ type: "getResources" });
  }

  save(settings: ResourceSettings, scope: string): void {
    if (connection.send({ type: "setResources", ...settings })) {
      this.pendingScope = scope;
    }
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type !== "resourcesState") return;
    const state = parseResourcesState(message.state);
    if (state === undefined) return;
    this.state = state;
    if (this.pendingScope === null) return;
    saveFeedback.saved(this.pendingScope, "Resource settings saved.");
    this.pendingScope = null;
  }
}

export const resources = new ResourcesStore();

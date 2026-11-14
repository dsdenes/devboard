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

/** True when both rows carry the same four figures. */
function sameBudget(left: ResourceSettings, right: ResourceSettings): boolean {
  return (
    left.maxAgentPeers === right.maxAgentPeers &&
    left.memoryHighMb === right.memoryHighMb &&
    left.memoryMaxMb === right.memoryMaxMb &&
    left.memoryReserveMb === right.memoryReserveMb
  );
}

/**
 * Holds the resource governor's budget. The scheduler reads it at the
 * Resources page's cadence and renders each frame the server pushes; a save
 * only reports success once a frame's effective row is the budget that save
 * submitted, so a refused save stays unconfirmed however many polls follow it.
 */
export class ResourcesStore {
  state = $state<ResourcesState | null>(null);
  /** The Save control waiting for its budget, and the budget it submitted. */
  private pending: { scope: string; budget: ResourceSettings } | null = null;

  save(settings: ResourceSettings, scope: string): void {
    if (connection.send({ type: "setResources", ...settings })) {
      this.pending = { scope, budget: { ...settings } };
    }
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type !== "resourcesState") return;
    const state = parseResourcesState(message.state);
    if (state === undefined) return;
    this.state = state;
    const pending = this.pending;
    if (pending === null) return;
    if (!sameBudget(state.effective, pending.budget)) return;
    this.pending = null;
    saveFeedback.saved(pending.scope, "Resource settings saved.");
  }
}

export const resources = new ResourcesStore();

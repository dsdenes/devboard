import { connection } from "./connection.svelte";
import { saveFeedback } from "./save-feedback.svelte";

/** The budget and cap the governor applies, in whole MiB and peer slots. */
export interface ResourceSettings {
  maxAgentPeers: number;
  /**
   * The memory marks, or null when the server could not read the host's
   * memory total. A budget with null marks carries no memory limit at all.
   */
  memoryHighMb: number | null;
  memoryMaxMb: number | null;
  memoryReserveMb: number | null;
}

/** The governor's current counters; the slice fields are zero without one. */
export interface ResourceLive {
  /** Live peers that hold the global cap. */
  activeAgents: number;
  /** Live Discover peers outside the cap. */
  exemptAgents: number;
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
  /**
   * Why the saved settings file was refused, or null when nothing was saved or
   * it read as a budget. The effective row is the derived budget either way.
   */
  settingsError: string | null;
  /**
   * Why the host's memory total could not be read, or null when it was. The
   * effective memory marks are null in that case and the slice carries no
   * memory limit.
   */
  memoryError: string | null;
  effective: ResourceSettings;
  live: ResourceLive;
}

/** A non-negative whole figure; anything else is a value the server never sent. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * One settings row, or `undefined` when a figure it carries is malformed.
 * `base` completes the figures the row omits: the settings writer emits only
 * the keys the file carries, so an absent figure is a default the effective
 * budget already resolved rather than a value the server failed to send.
 * Without a base every figure must be present, which is the effective row.
 * A null memory mark is the server reporting that the host's memory total
 * could not be read; the three marks are all present or all null.
 */
function settingsRow(
  value: unknown,
  base?: ResourceSettings,
): ResourceSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const figure = (key: keyof ResourceSettings): number | null | undefined => {
    const present = row[key];
    if (present === null) return null;
    if (present === undefined) return base?.[key];
    return isCount(present) ? present : undefined;
  };
  const maxAgentPeers = figure("maxAgentPeers");
  const memoryHighMb = figure("memoryHighMb");
  const memoryMaxMb = figure("memoryMaxMb");
  const memoryReserveMb = figure("memoryReserveMb");
  if (
    maxAgentPeers === undefined ||
    maxAgentPeers === null ||
    memoryHighMb === undefined ||
    memoryMaxMb === undefined ||
    memoryReserveMb === undefined
  ) {
    return undefined;
  }
  const marks = [memoryHighMb, memoryMaxMb, memoryReserveMb];
  // The effective row is the whole budget in force, so half a memory budget
  // names no limit the page could render. A saved row may hold one mark the
  // file carries while the effective row has none, because that budget is not
  // in force on a host whose memory total could not be read.
  if (
    base === undefined &&
    marks.some((mark) => mark === null) &&
    marks.some((mark) => mark !== null)
  ) {
    return undefined;
  }
  return { maxAgentPeers, memoryHighMb, memoryMaxMb, memoryReserveMb };
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
  // A frame from a harness that predates the separate count carries no exempt
  // peers because it never admitted one outside the cap.
  if (row.exemptAgents !== undefined && !isCount(row.exemptAgents)) {
    return undefined;
  }
  return {
    activeAgents: row.activeAgents,
    exemptAgents: isCount(row.exemptAgents) ? row.exemptAgents : 0,
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
    // The settings file may carry any subset of the four figures, so the
    // saved row names the budget in force: what the file carries plus the
    // remainder the effective row resolved. Only a present figure that is
    // malformed drops the frame.
    const row = settingsRow(frame.saved, effective);
    if (row === undefined) return undefined;
    saved = row;
  }
  // A frame from a server that predates the reported refusal carries no
  // reason; a reason of another type is a frame this client cannot trust.
  let settingsError: string | null = null;
  if (frame.settingsError !== null && frame.settingsError !== undefined) {
    if (typeof frame.settingsError !== "string") return undefined;
    settingsError = frame.settingsError;
  }
  // The same rule for the memory read: no field is an older server, and a
  // value of another type is a frame this client cannot trust.
  let memoryError: string | null = null;
  if (frame.memoryError !== null && frame.memoryError !== undefined) {
    if (typeof frame.memoryError !== "string") return undefined;
    memoryError = frame.memoryError;
  }
  return { saved, settingsError, memoryError, effective, live };
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
  /**
   * The server's message for the one save it refused, or `null`. A refusal is
   * an answer for the control that dispatched the command, so the page renders
   * this beside the form; the next dispatch clears it.
   */
  refusal = $state<string | null>(null);
  /**
   * Bumped only when a pending save's own budget lands. A control that waits
   * for its save reads this instead of `state`: the invalidation refetch a
   * refused answer triggers writes a fresh `resourcesState` frame, which is
   * not a confirmation and must not end the control's latch silently.
   */
  confirmed = $state(0);
  /** The Save control waiting for its budget, and the budget it submitted. */
  private pending: { scope: string; budget: ResourceSettings } | null = null;

  save(settings: ResourceSettings, scope: string): void {
    this.refusal = null;
    if (connection.send({ type: "setResources", ...settings })) {
      this.pending = { scope, budget: { ...settings } };
    }
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "error") {
      // Only a refusal names the command it refused; another control's refusal
      // is not this store's answer.
      if (message.command !== "setResources") return;
      this.pending = null;
      this.refusal =
        typeof message.message === "string" && message.message.trim().length > 0
          ? message.message
          : "The server refused the resource settings.";
      return;
    }
    if (message.type !== "resourcesState") return;
    const state = parseResourcesState(message.state);
    if (state === undefined) return;
    this.state = state;
    const pending = this.pending;
    if (pending === null) return;
    if (!sameBudget(state.effective, pending.budget)) return;
    this.pending = null;
    this.confirmed += 1;
    saveFeedback.saved(pending.scope, "Resource settings saved.");
  }
}

export const resources = new ResourcesStore();

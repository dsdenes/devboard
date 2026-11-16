import { connection } from "./connection.svelte";
import { saveFeedback } from "./save-feedback.svelte";

/** What a background family does with the change it produced. */
export type DeliveryMode = "merge" | "pull-request";

/** The one place a mode's visible name is written. */
export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  merge: "Merge to main",
  "pull-request": "Open pull request",
};

/** The save confirmation this store owns, so its own control renders it. */
export const DELIVERY_FEEDBACK_SCOPE = "delivery.mode";

/** The mode one activation of `mode` switches to. */
export function otherDeliveryMode(mode: DeliveryMode): DeliveryMode {
  return mode === "merge" ? "pull-request" : "merge";
}

/** A new save or refusal never leaves the previous save's note in place. */
function clearOwnFeedback(): void {
  if (saveFeedback.scope === DELIVERY_FEEDBACK_SCOPE) saveFeedback.dismiss();
}

/** Whether this checkout may switch delivery at all. */
export interface DeliveryAvailability {
  state: "enabled" | "disabled";
  reason: string | null;
}

function isMode(value: unknown): value is DeliveryMode {
  return value === "merge" || value === "pull-request";
}

function availabilityOf(value: unknown): DeliveryAvailability | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (row.state !== "enabled" && row.state !== "disabled") return undefined;
  const reason = row.reason;
  if (reason !== null && typeof reason !== "string") return undefined;
  return {
    state: row.state,
    reason: reason as string | null,
  };
}

/**
 * The per-repository delivery mode the sidebar switches.
 *
 * The confirmed mode follows the server's project payload only; `shown` is the
 * pending mode while a save is in flight, so the switch flips at once without
 * rewriting `mode`. A confirming frame clears the pending save and posts the
 * one transient success note; a refusal clears it, restores `shown` to `mode`,
 * and states the server's reason. On a harness source checkout the control
 * renders disabled with the availability reason.
 */
export class DeliveryStore {
  mode = $state<DeliveryMode>("merge");
  availability = $state<DeliveryAvailability>({ state: "enabled", reason: null });
  /** The mode a save is awaiting, so a repeated click does not dispatch twice. */
  pending = $state<DeliveryMode | null>(null);
  error = $state<string | null>(null);
  /** True once a project frame stated the mode; before that, `merge` is a default. */
  resolved = $state(false);

  get disabled(): boolean {
    return this.availability.state === "disabled";
  }

  get reason(): string | null {
    return this.availability.reason;
  }

  /** The optimistic mode: the pending save, else the confirmed one. */
  get shown(): DeliveryMode {
    return this.pending ?? this.mode;
  }

  /** True while one save awaits its server frame. */
  get saving(): boolean {
    return this.pending !== null;
  }

  /** The mode one activation switches to. */
  get other(): DeliveryMode {
    return otherDeliveryMode(this.shown);
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "error") {
      if (this.pending === null) return;
      clearOwnFeedback();
      this.error =
        typeof message.message === "string" && message.message.length > 0
          ? message.message
          : "The server refused the delivery mode.";
      this.pending = null;
      return;
    }
    if (message.type !== "project") return;
    if (!isMode(message.deliveryMode)) return;
    const availability = availabilityOf(message.deliveryModeAvailability);
    if (availability === undefined) return;
    this.mode = message.deliveryMode;
    this.availability = availability;
    this.resolved = true;
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.error = null;
    if (pending === this.mode) {
      saveFeedback.saved(
        DELIVERY_FEEDBACK_SCOPE,
        `Delivery mode saved: ${DELIVERY_MODE_LABELS[this.mode]}.`,
      );
    }
  }

  /** Dispatches one save. A disabled checkout dispatches nothing. */
  choose(mode: DeliveryMode): void {
    if (this.disabled) return;
    // One save at a time: activation while pending dispatches nothing.
    if (this.pending !== null) return;
    clearOwnFeedback();
    this.error = null;
    this.pending = mode;
    const sent = connection.send({ type: "setDeliveryMode", mode });
    if (!sent) {
      this.pending = null;
      this.error = "Could not reach the server.";
    }
  }

  /** Test seam: applies the store's own state without a server. */
  reset(): void {
    this.mode = "merge";
    this.availability = { state: "enabled", reason: null };
    this.pending = null;
    this.error = null;
    this.resolved = false;
  }
}

export const delivery = new DeliveryStore();

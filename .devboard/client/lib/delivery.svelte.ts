import { connection } from "./connection.svelte";

/** What a background family does with the change it produced. */
export type DeliveryMode = "merge" | "pull-request";

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
 * The selection follows the server's project payload only: a choose dispatches
 * the save, and the radio stays on the previous value until a frame carries
 * the new one. A refusal names its reason and leaves the previous selection in
 * place. On a harness source checkout the group renders disabled with the
 * availability reason.
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

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "error") {
      if (this.pending === null) return;
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
    if (this.pending === this.mode) {
      this.pending = null;
      this.error = null;
    }
  }

  /** Dispatches one save. A disabled checkout dispatches nothing. */
  choose(mode: DeliveryMode): void {
    if (this.disabled) return;
    if (this.pending === mode) return;
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

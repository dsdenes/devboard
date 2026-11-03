import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { saveFeedback } from "./save-feedback.svelte";
import type {
  ProviderId,
  ProviderKeyStatus,
  ProviderSelection,
  ProviderSubscription,
  ProviderWindow,
  ProvidersState,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const STATUSES: readonly ProviderKeyStatus[] = [
  "ok",
  "near-limit",
  "exhausted",
  "invalid",
  "unknown",
];

function windowFrom(value: unknown): ProviderWindow | null {
  if (!isObject(value)) return null;
  const key = string(value.key);
  const label = string(value.label);
  const remaining = numberOrNull(value.remainingFraction);
  if (key === null || label === null || remaining === null) return null;
  return {
    key,
    label,
    percentUsed: numberOrNull(value.percentUsed),
    remainingFraction: remaining,
    resetsAt: string(value.resetsAt),
  };
}

function subscriptionFrom(value: unknown): ProviderSubscription | null {
  if (!isObject(value)) return null;
  const id = string(value.id);
  const provider = string(value.provider);
  const providerName = string(value.providerName);
  const label = string(value.label);
  const maskedKey = string(value.maskedKey);
  const status = string(value.status);
  if (
    id === null ||
    (provider !== "opencode-go" && provider !== "openrouter") ||
    providerName === null ||
    label === null ||
    maskedKey === null ||
    status === null ||
    !STATUSES.includes(status as ProviderKeyStatus)
  ) {
    return null;
  }
  return {
    id,
    provider: provider as ProviderId,
    providerName,
    label,
    enabled: value.enabled === true,
    maskedKey,
    status: status as ProviderKeyStatus,
    windows: Array.isArray(value.windows)
      ? value.windows.map(windowFrom).filter((window): window is ProviderWindow => window !== null)
      : [],
    remainingFraction: numberOrNull(value.remainingFraction),
    lastCheckedAt: string(value.lastCheckedAt),
    error: string(value.error),
  };
}

function selectionFrom(value: unknown): ProviderSelection | null {
  if (!isObject(value)) return null;
  const provider = string(value.provider);
  const providerName = string(value.providerName);
  const label = string(value.label);
  const model = string(value.model);
  if (
    (provider !== "opencode-go" && provider !== "openrouter") ||
    providerName === null ||
    label === null ||
    model === null
  ) {
    return null;
  }
  return {
    provider,
    providerName,
    label,
    model,
    remainingFraction: numberOrNull(value.remainingFraction),
  };
}

/** What a tracked provider change asks the server to do. */
type ProviderChangeKind = "save" | "delete" | "enable";

/**
 * The Providers dialog's state. The server owns the credentials, selection,
 * and usage; this store only mirrors the masked view and tracks its requests.
 */
export class ProviderStore {
  subscriptions = $state<ProviderSubscription[]>([]);
  selection = $state<ProviderSelection | null>(null);
  refusal = $state<string | null>(null);
  rule = $state("rotates at 1% remaining");
  open = $state(false);
  error = $state<string | null>(null);
  busy = $state(false);
  loaded = $state(false);
  /** The answer to the latest save: its request id and whether it was applied. */
  saveResult = $state<{ requestId: number; ok: boolean } | null>(null);
  /**
   * Change requests the server has not answered yet, by kind. Every save,
   * delete, and enable carries a client-generated id the server echoes in its
   * own acknowledgement, so a state broadcast never settles someone else's
   * request and only that request's answer clears the busy state.
   */
  private pending = new Map<number, ProviderChangeKind>();
  private nextRequestId = 1;

  /**
   * Reconciles operations a reconnect may have lost: a change frame answered
   * while the socket was down never arrives, so nothing may stay busy.
   */
  resetActiveOperations(): void {
    this.pending.clear();
    this.busy = false;
    this.saveResult = null;
  }

  request(): void {
    connection.send({ type: "getProviders" });
  }

  refresh(): void {
    connection.send({ type: "refreshProviders" });
  }

  /** Saves and returns the request id whose answer settles it, or null when unsent. */
  save(input: {
    id?: string;
    provider: ProviderId;
    label: string;
    key?: string;
  }): number | null {
    this.saveResult = null;
    return this.#change("save", (requestId) => ({ type: "saveProvider", requestId, ...input }));
  }

  remove(id: string): number | null {
    return this.#change("delete", (requestId) => ({ type: "deleteProvider", requestId, id }));
  }

  setEnabled(id: string, enabled: boolean): number | null {
    return this.#change("enable", (requestId) => ({
      type: "setProviderEnabled",
      requestId,
      id,
      enabled,
    }));
  }

  /**
   * Sends one change under a fresh id. A socket that refuses the send leaves
   * the store idle instead of busy, because no answer can ever arrive.
   */
  #change(
    kind: ProviderChangeKind,
    command: (requestId: number) => Record<string, unknown>,
  ): number | null {
    this.error = null;
    const requestId = this.nextRequestId;
    if (!connection.send(command(requestId))) return null;
    this.nextRequestId += 1;
    this.pending.set(requestId, kind);
    this.busy = true;
    return requestId;
  }

  /** Settles one answered change; a stale id changes nothing. */
  #settle(requestId: number | null, ok: boolean): ProviderChangeKind | null {
    if (requestId === null) return null;
    const kind = this.pending.get(requestId);
    if (kind === undefined) return null;
    this.pending.delete(requestId);
    this.busy = this.pending.size > 0;
    if (kind === "save") this.saveResult = { requestId, ok };
    return kind;
  }

  openDialog(): void {
    this.open = true;
    this.error = null;
    this.request();
  }

  closeDialog(): void {
    this.open = false;
    this.error = null;
  }

  handleEvent(message: Record<string, unknown>): boolean {
    if (message.type === "providersState") {
      const subscriptions = Array.isArray(message.subscriptions)
        ? message.subscriptions
            .map(subscriptionFrom)
            .filter((entry): entry is ProviderSubscription => entry !== null)
        : [];
      this.subscriptions = subscriptions;
      this.selection = selectionFrom(message.selection);
      this.refusal = string(message.refusal) ?? (this.selection === null ? "No provider" : null);
      this.rule = string(message.rule) ?? this.rule;
      this.loaded = true;
      this.error = null;
      // A broadcast says what the server holds now, never that a change of
      // ours was applied: only the acknowledgement for its own id settles it.
      return true;
    }
    if (message.type === "providerChanged") {
      const kind = this.#settle(numberOrNull(message.requestId), true);
      if (kind === "save") saveFeedback.saved("providers.form", "Provider saved.");
      return kind !== null;
    }
    if (message.type === "providerError") {
      const text = string(message.message) ?? "The provider change failed.";
      this.error = text;
      this.#settle(numberOrNull(message.requestId), false);
      notifications.push("Providers", "error", text);
      return true;
    }
    return false;
  }
}

export const providers = new ProviderStore();

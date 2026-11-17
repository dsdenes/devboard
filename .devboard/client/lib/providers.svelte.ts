import { connection } from "./connection.svelte";
import { queryClient } from "./query-client";
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

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
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
   * The enabled value the operator asked for, by subscription id, until the
   * server answers that row's own change. The checkbox follows this draft, so a
   * refused change puts the row back on the stored value; a state frame that
   * catches up with it drops it.
   */
  enabledDraft = $state<Record<string, boolean>>({});
  /** Subscription ids whose enable change the server has not answered yet. */
  enablePending = $state<Record<string, true>>({});
  /** The subscription each in-flight enable names, by request id. */
  private enableIds = new Map<number, string>();
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
    this.enableIds.clear();
    this.enabledDraft = {};
    this.enablePending = {};
    this.busy = false;
    this.saveResult = null;
  }

  request(): void {
    void queryClient.invalidateQueries({ queryKey: ["getProviders"] });
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
    const type = input.id === undefined ? "createProvider" : "saveProvider";
    return this.#change("save", (requestId) => ({ type, requestId, ...input }));
  }

  remove(id: string): number | null {
    return this.#change("delete", (requestId) => ({ type: "deleteProvider", requestId, id }));
  }

  setEnabled(id: string, enabled: boolean): number | null {
    const requestId = this.#change("enable", (requestId) => ({
      type: "setProviderEnabled",
      requestId,
      id,
      enabled,
    }));
    if (requestId === null) return null;
    this.enableIds.set(requestId, id);
    this.enablePending = { ...this.enablePending, [id]: true };
    this.enabledDraft = { ...this.enabledDraft, [id]: enabled };
    return requestId;
  }

  /**
   * The checkbox value for one row: the operator's pending choice until the
   * server answers it, then the stored value again.
   */
  enabledValue(subscription: ProviderSubscription): boolean {
    return this.enabledDraft[subscription.id] ?? subscription.enabled;
  }

  /** Whether that row's own enable change is still waiting on the server. */
  enabling(subscription: ProviderSubscription): boolean {
    return this.enablePending[subscription.id] === true;
  }

  /**
   * Sends one change under a fresh id. A socket that refuses the send leaves
   * the store idle instead of busy, because no answer can ever arrive, and a
   * refused answer abandons its own id for the same reason: the transport
   * answers over HTTP, so a failed request produces no acknowledgement frame.
   */
  #change(
    kind: ProviderChangeKind,
    command: (requestId: number) => Record<string, unknown>,
  ): number | null {
    this.error = null;
    const requestId = this.nextRequestId;
    if (!connection.send(command(requestId), "operator", () => this.#abandon(requestId))) {
      return null;
    }
    this.nextRequestId += 1;
    this.pending.set(requestId, kind);
    this.busy = true;
    return requestId;
  }

  /**
   * Drops one change whose answer never arrived, so the next change is not
   * queued behind it. A failure is reported by the transport, never here:
   * `saveResult` and `saveFeedback` stay untouched so nothing claims success.
   */
  #abandon(requestId: number): void {
    if (!this.pending.delete(requestId)) return;
    this.busy = this.pending.size > 0;
    const id = this.enableIds.get(requestId);
    if (id === undefined) return;
    this.enableIds.delete(requestId);
    this.#restoreEnabled(id);
  }

  /**
   * Puts one row's checkbox back on the stored value: its change was not
   * applied, so the operator's toggle must not outlive the refusal.
   */
  #restoreEnabled(id: string): void {
    this.enablePending = withoutKey(this.enablePending, id);
    this.enabledDraft = withoutKey(this.enabledDraft, id);
  }

  /** Settles one answered change; a stale id changes nothing. */
  #settle(requestId: number | null, ok: boolean): ProviderChangeKind | null {
    if (requestId === null) return null;
    const kind = this.pending.get(requestId);
    if (kind === undefined) return null;
    this.pending.delete(requestId);
    this.busy = this.pending.size > 0;
    if (kind === "save") this.saveResult = { requestId, ok };
    if (kind === "enable") {
      const id = this.enableIds.get(requestId);
      this.enableIds.delete(requestId);
      if (id === undefined) return kind;
      // An applied enable keeps its draft until the server's own view of the
      // row carries it; a refusal puts the row back at once.
      if (ok) this.enablePending = withoutKey(this.enablePending, id);
      else this.#restoreEnabled(id);
    }
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
      // A draft survives only while its own enable is unanswered and the
      // server's view has not caught up with it; once they agree, or the row
      // changed elsewhere, the stored value is the row's truth again.
      const drafts: Record<string, boolean> = {};
      for (const subscription of subscriptions) {
        const draft = this.enabledDraft[subscription.id];
        if (draft === undefined || draft === subscription.enabled) continue;
        if (this.enablePending[subscription.id] === true) drafts[subscription.id] = draft;
      }
      this.enabledDraft = drafts;
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
      // The provider's verdict on a key the operator just entered is their own
      // input error, and the dialog reports it inline. Every other refusal is a
      // harness or stored-state fault, which the app-wide error notification
      // and the issue it files exist to surface.
      if (message.keyRefused !== true) notifications.push("Providers", "error", text);
      return true;
    }
    return false;
  }
}

export const providers = new ProviderStore();

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

/** Formats a remaining fraction as a compact percentage. */
export function percentText(fraction: number | null): string {
  if (fraction === null) return "unknown";
  const percent = Math.max(0, Math.min(100, fraction * 100));
  if (percent === 100) return "100%";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** The status text one subscription row shows. */
export function statusText(status: ProviderKeyStatus): string {
  switch (status) {
    case "ok":
      return "ok";
    case "near-limit":
      return "near limit";
    case "exhausted":
      return "exhausted";
    case "invalid":
      return "invalid";
    default:
      return "unknown";
  }
}

/**
 * The Providers dialog and status-bar control. The server owns the
 * credentials, selection, and usage; this store only mirrors the masked view.
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
  /** A save awaiting the state frame that confirms it. */
  private pendingSave = false;

  get indicatorLabel(): string {
    const selection = this.selection;
    if (selection === null) return "No provider";
    return `${selection.providerName} · ${percentText(selection.remainingFraction)}`;
  }

  get indicatorTitle(): string {
    const selection = this.selection;
    if (selection === null) {
      return this.refusal ?? "No provider subscription is configured. Open the Providers dialog.";
    }
    return `${selection.providerName} (${selection.label}) serves peers on ${selection.model}; ${percentText(
      selection.remainingFraction,
    )} remaining. ${this.rule}.`;
  }

  request(): void {
    connection.send({ type: "getProviders" });
  }

  refresh(): void {
    this.busy = true;
    connection.send({ type: "refreshProviders" });
  }

  save(input: {
    id?: string;
    provider: ProviderId;
    label: string;
    key?: string;
  }): void {
    this.error = null;
    this.busy = true;
    if (connection.send({ type: "saveProvider", ...input })) this.pendingSave = true;
  }

  remove(id: string): void {
    this.error = null;
    this.busy = true;
    connection.send({ type: "deleteProvider", id });
  }

  setEnabled(id: string, enabled: boolean): void {
    this.busy = true;
    connection.send({ type: "setProviderEnabled", id, enabled });
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
      this.busy = false;
      this.error = null;
      if (this.pendingSave) {
        this.pendingSave = false;
        saveFeedback.saved("Provider saved.");
      }
      return true;
    }
    if (message.type === "providerError") {
      const text = string(message.message) ?? "The provider change failed.";
      this.error = text;
      this.busy = false;
      this.pendingSave = false;
      notifications.push("Providers", "error", text);
      return true;
    }
    return false;
  }
}

export const providers = new ProviderStore();

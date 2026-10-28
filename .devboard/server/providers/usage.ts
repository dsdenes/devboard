import {
  ELIGIBILITY_THRESHOLD,
  PROVIDERS,
  USAGE_TIMEOUT_MS,
  type ProviderId,
} from "./catalog";
import type { StoredSubscription } from "./store";

/**
 * Reads one subscription's remaining quota. Every gating window is reduced to
 * a remaining fraction; a failed or malformed read is `unknown` (and still
 * eligible), while a rejected key is `invalid` (never eligible).
 */

export type UsageStatus = "ok" | "near-limit" | "exhausted" | "invalid" | "unknown";

export interface UsageWindowState {
  key: string;
  label: string;
  /** Percent of the window used, when the provider reports one. */
  percentUsed: number | null;
  /** Fraction of the window left, 0 through 1. */
  remainingFraction: number;
  resetsAt: string | null;
}

export interface UsageReport {
  status: UsageStatus;
  checkedAt: string;
  windows: UsageWindowState[];
  /** The smallest remaining fraction, or null when the headroom is unknown. */
  remainingFraction: number | null;
  error: string | null;
}

export interface UsageRequestOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

function finitePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function reportStatus(windows: UsageWindowState[]): UsageStatus {
  if (windows.some((window) => window.remainingFraction <= 0)) return "exhausted";
  const lowest = Math.min(...windows.map((window) => window.remainingFraction));
  return lowest <= ELIGIBILITY_THRESHOLD * 10 ? "near-limit" : "ok";
}

function lowest(windows: UsageWindowState[]): number {
  return Math.min(...windows.map((window) => window.remainingFraction));
}

const WINDOW_LABELS: Record<string, string> = {
  rolling: "Rolling 5h",
  weekly: "Weekly",
  monthly: "Monthly",
  limit: "Account limit",
};

function parseOpenCodeGo(payload: unknown): UsageWindowState[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const windows: UsageWindowState[] = [];
  for (const definition of PROVIDERS["opencode-go"].windows) {
    const window = record[definition.key];
    if (typeof window !== "object" || window === null) return undefined;
    const percent = finitePercent((window as Record<string, unknown>).percent);
    if (percent === undefined) return undefined;
    const resetsAt = (window as Record<string, unknown>).resetsAt;
    windows.push({
      key: definition.key,
      label: WINDOW_LABELS[definition.key] ?? definition.key,
      percentUsed: percent,
      remainingFraction: Math.max(0, 1 - percent / 100),
      resetsAt: typeof resetsAt === "string" ? resetsAt : null,
    });
  }
  return windows;
}

function parseOpenRouter(payload: unknown): UsageWindowState[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const outer = payload as Record<string, unknown>;
  const data =
    typeof outer.data === "object" && outer.data !== null
      ? (outer.data as Record<string, unknown>)
      : outer;
  const remaining = data.limit_remaining;
  const limit = data.limit;
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) return undefined;
  if (limit === null || limit === undefined) {
    // No account limit: unlimited headroom.
    return [
      {
        key: "limit",
        label: WINDOW_LABELS.limit ?? "limit",
        percentUsed: null,
        remainingFraction: 1,
        resetsAt: null,
      },
    ];
  }
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined;
  const fraction = Math.min(1, Math.max(0, remaining / limit));
  return [
    {
      key: "limit",
      label: WINDOW_LABELS.limit ?? "limit",
      percentUsed: (1 - fraction) * 100,
      remainingFraction: fraction,
      resetsAt: null,
    },
  ];
}

/**
 * Fetches one subscription's usage. A 401 or 403 marks the key invalid; every
 * other failure (network, timeout, 5xx, malformed body) leaves the headroom
 * unknown so the key stays eligible but ranks below every known one.
 */
export async function fetchUsage(
  subscription: Pick<StoredSubscription, "provider" | "key">,
  options: UsageRequestOptions,
): Promise<UsageReport> {
  const provider = PROVIDERS[subscription.provider];
  const checkedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const signal = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? USAGE_TIMEOUT_MS));
  const fetchImpl = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(
      `${options.baseUrl.replace(/\/+$/, "")}${provider.usagePath}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${subscription.key}`,
        },
        signal,
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      status: "unknown",
      checkedAt,
      windows: [],
      remainingFraction: null,
      error: timedOut
        ? "The usage check timed out."
        : "The usage check could not reach the provider.",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "invalid",
      checkedAt,
      windows: [],
      remainingFraction: null,
      error: `The provider rejected this key (HTTP ${response.status}).`,
    };
  }
  if (!response.ok) {
    return {
      status: "unknown",
      checkedAt,
      windows: [],
      remainingFraction: null,
      error: `The usage check failed (HTTP ${response.status}).`,
    };
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return {
      status: "unknown",
      checkedAt,
      windows: [],
      remainingFraction: null,
      error: "The usage response was not JSON.",
    };
  }

  const windows =
    subscription.provider === "opencode-go"
      ? parseOpenCodeGo(payload)
      : parseOpenRouter(payload);
  if (windows === undefined || windows.length === 0) {
    return {
      status: "unknown",
      checkedAt,
      windows: [],
      remainingFraction: null,
      error: "The usage response did not report every quota window.",
    };
  }

  return {
    status: reportStatus(windows),
    checkedAt,
    windows,
    remainingFraction: lowest(windows),
    error: null,
  };
}

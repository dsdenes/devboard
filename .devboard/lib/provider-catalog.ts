/**
 * The provider catalog. Exactly two providers exist: the OpenCode Go
 * subscription and the OpenRouter fallback. Nothing here reads OMP's login
 * state; a peer gets only the keys the operator registers in the dashboard.
 */

export const PROVIDER_IDS = ["opencode-go", "openrouter"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  /** Environment variable that carries the selected key to a peer. */
  envVar: "OPENCODE_API_KEY" | "OPENROUTER_API_KEY";
  /** Model selector a peer runs when this provider serves it. */
  model: string;
  /** Base URL of the usage endpoint; overridable for tests. */
  defaultUsageBaseUrl: string;
  /** Environment variable that overrides `defaultUsageBaseUrl`. */
  usageBaseUrlEnv: string;
  /** Path appended to the base URL by the usage fetch. */
  usagePath: string;
  /** Quota windows that gate eligibility, in display order. */
  windows: readonly ProviderWindowDefinition[];
}

export interface ProviderWindowDefinition {
  key: string;
  label: string;
}

export const OPENCODE_GO_MODEL = "opencode-go/deepseek-v4.1-flash";
export const OPENROUTER_FALLBACK_MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";

/** The model roles a generated per-peer config pins. */
export const MODEL_ROLES = ["default", "plan", "smol", "slow", "task"] as const;

/** A subscription at or below this remaining fraction is skipped. */
export const ELIGIBILITY_THRESHOLD = 0.01;

/** The fixed rule the Providers dialog states. */
export const ROTATION_RULE = "rotates at 1% remaining";

/** Usage is fetched at most once per this interval unless forced. */
export const USAGE_TTL_MS = 60_000;

/** One usage fetch may take at most this long. */
export const USAGE_TIMEOUT_MS = 5_000;

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    envVar: "OPENCODE_API_KEY",
    model: OPENCODE_GO_MODEL,
    defaultUsageBaseUrl: "https://opencode.ai/zen/go",
    usageBaseUrlEnv: "DEVBOARD_OPENCODE_GO_USAGE_BASE_URL",
    usagePath: "/v1/usage",
    windows: [
      { key: "rolling", label: "Rolling 5h" },
      { key: "weekly", label: "Weekly" },
      { key: "monthly", label: "Monthly" },
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    model: OPENROUTER_FALLBACK_MODEL,
    defaultUsageBaseUrl: "https://openrouter.ai/api",
    usageBaseUrlEnv: "DEVBOARD_OPENROUTER_USAGE_BASE_URL",
    usagePath: "/v1/key",
    windows: [{ key: "limit", label: "Account limit" }],
  },
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerName(id: ProviderId): string {
  return PROVIDERS[id].name;
}

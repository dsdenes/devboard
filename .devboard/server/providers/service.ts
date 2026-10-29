import { randomUUID } from "node:crypto";
import {
  PROVIDERS,
  ROTATION_RULE,
  USAGE_TTL_MS,
  isProviderId,
  type ProviderId,
} from "./catalog";
import {
  credentialsPath,
  loadSubscriptions,
  maskKey,
  saveSubscriptions,
  type StoredSubscription,
} from "./store";
import { fetchUsage, type UsageReport, type UsageStatus } from "./usage";
import {
  removeSelectionSnapshot,
  writeSelectionSnapshot,
} from "./snapshot";
import {
  agentDirectory,
  decideProvider,
  generatedConfig,
  peerEnvironment,
  rankSubscriptions,
  writeAgentDirectory,
  type PeerBinding,
  type RankedSubscription,
} from "./selection";

/**
 * The dashboard's provider capability: the credential store, the usage cache,
 * the selection, and the per-peer environment. Every ACP peer start goes
 * through `select`; a refusal throws before any process is spawned.
 */

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface ProviderServiceOptions {
  stateDir: string;
  /** The environment a peer inherits; the operator's shell by default. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Test seam: replaces the provider base URLs from the environment. */
  usageBaseUrls?: Partial<Record<ProviderId, string>>;
  log?: (line: string) => void;
}

export interface ProviderWindowView {
  key: string;
  label: string;
  percentUsed: number | null;
  remainingFraction: number;
  resetsAt: string | null;
}

export interface ProviderSubscriptionView {
  id: string;
  provider: ProviderId;
  providerName: string;
  label: string;
  enabled: boolean;
  maskedKey: string;
  status: UsageStatus;
  windows: ProviderWindowView[];
  remainingFraction: number | null;
  lastCheckedAt: string | null;
  error: string | null;
}

export interface ProviderSelectionView {
  provider: ProviderId;
  providerName: string;
  label: string;
  model: string;
  remainingFraction: number | null;
}

export interface ProvidersView {
  subscriptions: ProviderSubscriptionView[];
  selection: ProviderSelectionView | null;
  /** The refusal reason when no provider can serve a peer. */
  refusal: string | null;
  rule: string;
}

export interface SaveProviderInput {
  id?: string;
  provider?: unknown;
  label?: unknown;
  key?: unknown;
}

export type SaveProviderResult =
  | { ok: true }
  | { ok: false; message: string };

interface ValidatedInput {
  provider: ProviderId;
  label: string;
  key: string | undefined;
}

function clampLabel(label: string, fallback: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, 80);
}

export class ProviderService {
  readonly #stateDir: string;
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #timeoutMs: number | undefined;
  readonly #usageBaseUrls: Partial<Record<ProviderId, string>>;
  readonly #log: (line: string) => void;

  #subscriptions: StoredSubscription[];
  #usage = new Map<string, UsageReport>();
  /** One in-flight fetch per subscription, whatever asks while it runs. */
  #inflight = new Map<string, Promise<UsageReport>>();

  constructor(options: ProviderServiceOptions) {
    this.#stateDir = options.stateDir;
    this.#baseEnv = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs;
    this.#usageBaseUrls = options.usageBaseUrls ?? {};
    this.#log = options.log ?? (() => undefined);
    const loaded = loadSubscriptions(options.stateDir);
    this.#subscriptions = loaded.subscriptions;
    if (loaded.preserved !== undefined) {
      this.#log(`providers: unusable credentials were preserved at ${loaded.preserved}`);
    }
  }

  get credentialsPath(): string {
    return credentialsPath(this.#stateDir);
  }

  /** The internal list, including keys; never serialize this. */
  list(): StoredSubscription[] {
    return this.#subscriptions.map((subscription) => ({ ...subscription }));
  }

  /**
   * Re-reads the credential file for a long-lived worker, keeping cached usage
   * for an unchanged key and dropping it for a removed or replaced one.
   */
  reload(): void {
    const loaded = loadSubscriptions(this.#stateDir);
    const next = loaded.subscriptions;
    const nextIds = new Set(next.map((subscription) => subscription.id));
    for (const id of this.#usage.keys()) {
      if (!nextIds.has(id)) this.#usage.delete(id);
    }
    for (const subscription of next) {
      const previous = this.#subscriptions.find((entry) => entry.id === subscription.id);
      if (
        previous !== undefined &&
        (previous.key !== subscription.key || previous.provider !== subscription.provider)
      ) {
        this.#usage.delete(subscription.id);
      }
    }
    this.#subscriptions = next;
    if (loaded.preserved !== undefined) {
      this.#log(`providers: unusable credentials were preserved at ${loaded.preserved}`);
    }
  }

  #baseUrl(provider: ProviderId): string {
    return (
      this.#usageBaseUrls[provider] ??
      this.#baseEnv[PROVIDERS[provider].usageBaseUrlEnv] ??
      PROVIDERS[provider].defaultUsageBaseUrl
    );
  }

  #fetchUsage(subscription: Pick<StoredSubscription, "provider" | "key">): Promise<UsageReport> {
    return fetchUsage(subscription, {
      baseUrl: this.#baseUrl(subscription.provider),
      now: this.#now,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
  }

  #checkedAtMs(report: UsageReport): number {
    const parsed = Date.parse(report.checkedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Reads every subscription whose cached usage is older than the TTL, or all
   * of them when the operator forces a refresh. Fetches run concurrently.
   */
  async refresh(force = false): Promise<void> {
    const now = this.#now();
    const pending = this.#subscriptions.filter((subscription) => {
      if (force) return true;
      const cached = this.#usage.get(subscription.id);
      if (cached === undefined) return true;
      return now - this.#checkedAtMs(cached) >= USAGE_TTL_MS;
    });
    await Promise.all(
      pending.map(async (subscription) => {
        const key = subscription.key;
        let request = this.#inflight.get(subscription.id);
        if (request === undefined) {
          request = this.#fetchUsage(subscription);
          this.#inflight.set(subscription.id, request);
        }
        const report = await request;
        this.#inflight.delete(subscription.id);
        // A save may have replaced the key while this fetch ran; that key owns
        // the cache from then on.
        const current = this.#subscriptions.find((entry) => entry.id === subscription.id);
        if (current !== undefined && current.key === key) this.#usage.set(subscription.id, report);
      }),
    );
    this.#publishSelection();
  }

  #ranked(): RankedSubscription[] {
    return rankSubscriptions(this.#subscriptions, this.#usage);
  }

  /**
   * Publishes the dashboard's decision so detached workers can follow it
   * without probing usage themselves. A refusal removes the file, so no worker
   * keeps using a key the dashboard has stopped selecting.
   */
  #publishSelection(): void {
    const decision = decideProvider(this.#ranked(), this.#subscriptions.length > 0);
    try {
      if (decision.kind === "selected") {
        writeSelectionSnapshot(this.#stateDir, {
          provider: decision.subscription.provider,
          subscriptionId: decision.subscription.id,
          label: decision.subscription.label,
          model: PROVIDERS[decision.subscription.provider].model,
          remainingFraction: decision.usage?.remainingFraction ?? null,
          checkedAt: new Date(this.#now()).toISOString(),
        });
      } else {
        removeSelectionSnapshot(this.#stateDir);
      }
    } catch (error) {
      this.#log(
        `providers: the selection snapshot could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  view(): ProvidersView {
    const ranked = this.#ranked();
    const decision = decideProvider(ranked, this.#subscriptions.length > 0);
    const subscriptions = ranked.map((candidate) => {
      const usage = candidate.usage;
      return {
        id: candidate.subscription.id,
        provider: candidate.subscription.provider,
        providerName: PROVIDERS[candidate.subscription.provider].name,
        label: candidate.subscription.label,
        enabled: candidate.subscription.enabled,
        maskedKey: maskKey(candidate.subscription.key),
        status: usage?.status ?? "unknown",
        windows: (usage?.windows ?? []).map((window) => ({ ...window })),
        remainingFraction: usage?.remainingFraction ?? null,
        lastCheckedAt: usage?.checkedAt ?? null,
        error: usage?.error ?? null,
      } satisfies ProviderSubscriptionView;
    });

    if (decision.kind === "refused") {
      return { subscriptions, selection: null, refusal: decision.reason, rule: ROTATION_RULE };
    }
    return {
      subscriptions,
      selection: {
        provider: decision.subscription.provider,
        providerName: PROVIDERS[decision.subscription.provider].name,
        label: decision.subscription.label,
        model: PROVIDERS[decision.subscription.provider].model,
        remainingFraction: decision.usage?.remainingFraction ?? null,
      },
      refusal: null,
      rule: ROTATION_RULE,
    };
  }

  #validated(input: SaveProviderInput): ValidatedInput | { error: string } {
    if (!isProviderId(input.provider)) {
      return { error: "Choose OpenCode Go or OpenRouter." };
    }
    const provider = input.provider;
    const label = clampLabel(
      typeof input.label === "string" ? input.label : "",
      PROVIDERS[provider].name,
    );
    const key = typeof input.key === "string" && input.key.trim().length > 0 ? input.key.trim() : undefined;
    return { provider, label, key };
  }

  /**
   * Adds or edits one subscription. A new or changed key is validated first:
   * a rejection (HTTP 401/403) refuses the save; an unreachable or 5xx
   * endpoint saves it with unknown status. An edit without a key only changes
   * the label (and enablement), so it never revalidates.
   */
  async save(input: SaveProviderInput): Promise<SaveProviderResult> {
    const validated = this.#validated(input);
    if ("error" in validated) return { ok: false, message: validated.error };

    const existing =
      typeof input.id === "string"
        ? this.#subscriptions.find((subscription) => subscription.id === input.id)
        : undefined;
    if (typeof input.id === "string" && existing === undefined) {
      return { ok: false, message: "That subscription no longer exists." };
    }

    const key = validated.key ?? existing?.key;
    if (key === undefined) return { ok: false, message: "An API key is required." };

    const validates = validated.key !== undefined;
    let report: UsageReport | undefined;
    if (validates) {
      report = await this.#fetchUsage({ provider: validated.provider, key });
      if (report.status === "invalid") {
        return {
          ok: false,
          message: report.error ?? "The provider rejected this key.",
        };
      }
    }

    const timestamp = new Date(this.#now()).toISOString();
    const id = existing?.id ?? randomUUID();
    const subscription: StoredSubscription = {
      id,
      provider: validated.provider,
      label: validated.label,
      key,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const next =
      existing === undefined
        ? [...this.#subscriptions, subscription]
        : this.#subscriptions.map((entry) => (entry.id === id ? subscription : entry));

    try {
      saveSubscriptions(this.#stateDir, next);
    } catch (error) {
      return {
        ok: false,
        message: `The credentials file could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    this.#subscriptions = next;
    if (existing !== undefined && existing.key !== key) this.#usage.delete(id);
    if (report !== undefined) this.#usage.set(id, report);
    this.#publishSelection();
    return { ok: true };
  }

  remove(id: string): SaveProviderResult {
    const next = this.#subscriptions.filter((subscription) => subscription.id !== id);
    if (next.length === this.#subscriptions.length) {
      return { ok: false, message: "That subscription no longer exists." };
    }
    try {
      saveSubscriptions(this.#stateDir, next);
    } catch (error) {
      return {
        ok: false,
        message: `The credentials file could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.#subscriptions = next;
    this.#usage.delete(id);
    this.#publishSelection();
    return { ok: true };
  }

  setEnabled(id: string, enabled: boolean): SaveProviderResult {
    const existing = this.#subscriptions.find((subscription) => subscription.id === id);
    if (existing === undefined) return { ok: false, message: "That subscription no longer exists." };
    const next = this.#subscriptions.map((subscription) =>
      subscription.id === id
        ? { ...subscription, enabled, updatedAt: new Date(this.#now()).toISOString() }
        : subscription,
    );
    try {
      saveSubscriptions(this.#stateDir, next);
    } catch (error) {
      return {
        ok: false,
        message: `The credentials file could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.#subscriptions = next;
    this.#publishSelection();
    return { ok: true };
  }

  /**
   * Resolves the peer binding. Throws `ProviderUnavailableError` before any
   * process exists when no subscription can serve a peer.
   */
  async select(): Promise<PeerBinding> {
    await this.refresh(false);
    const decision = decideProvider(this.#ranked(), this.#subscriptions.length > 0);
    if (decision.kind === "refused") throw new ProviderUnavailableError(decision.reason);

    const provider = decision.subscription.provider;
    const model = PROVIDERS[provider].model;
    const directory = agentDirectory(this.#stateDir, provider, decision.subscription.id);
    writeAgentDirectory(directory, generatedConfig(provider, model));

    const binding: Omit<PeerBinding, "env"> = {
      provider,
      providerName: PROVIDERS[provider].name,
      subscriptionId: decision.subscription.id,
      subscriptionLabel: decision.subscription.label,
      model,
      remainingFraction: decision.usage?.remainingFraction ?? null,
      agentDir: directory,
    };
    return {
      ...binding,
      env: peerEnvironment(
        this.#baseEnv,
        binding,
        decision.subscription.key,
        decision.fallback?.key,
      ),
    };
  }
}

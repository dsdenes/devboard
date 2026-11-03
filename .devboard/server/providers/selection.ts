import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ELIGIBILITY_THRESHOLD,
  MODEL_ROLES,
  OPENROUTER_FALLBACK_MODEL,
  type ProviderId,
} from "./catalog";
import type { StoredSubscription } from "./store";
import type { UsageReport } from "./usage";

/**
 * Headroom selection and the per-peer binding. Eligible subscriptions rank by
 * their lowest remaining window; unknown headroom ranks below every known one;
 * ties keep the operator's list order. A peer gets one generated agent
 * directory and only the keys the selection names.
 */

export interface RankedSubscription {
  subscription: StoredSubscription;
  usage: UsageReport | undefined;
  /** The lowest remaining fraction, or null when the headroom is unknown. */
  headroom: number | null;
  eligible: boolean;
  /** Position in the operator's list; the tie-breaker. */
  index: number;
}

export type ProviderDecision =
  | {
      kind: "selected";
      subscription: StoredSubscription;
      usage: UsageReport | undefined;
      /** The best enabled OpenRouter key, attached for a Go fallback chain. */
      fallback: StoredSubscription | undefined;
      fallbackUsage: UsageReport | undefined;
    }
  | { kind: "refused"; reason: string };

function isEligible(usage: UsageReport | undefined): boolean {
  if (usage === undefined) return true;
  if (usage.status === "invalid") return false;
  if (usage.status === "unknown" || usage.remainingFraction === null) return true;
  // 1 - 99/100 is 0.010000000000000009, so compare with a small tolerance:
  // exactly 1% remaining is not above the threshold.
  return usage.remainingFraction > ELIGIBILITY_THRESHOLD + 1e-9;
}

/** Ranks every subscription; disabled ones are reported but never eligible. */
export function rankSubscriptions(
  subscriptions: StoredSubscription[],
  usageById: Map<string, UsageReport>,
): RankedSubscription[] {
  return subscriptions.map((subscription, index) => {
    const usage = usageById.get(subscription.id);
    return {
      subscription,
      usage,
      headroom: usage?.remainingFraction ?? null,
      eligible: subscription.enabled && isEligible(usage),
      index,
    };
  });
}

function best(candidates: RankedSubscription[]): RankedSubscription | undefined {
  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => {
      if (left.headroom === null && right.headroom === null) return left.index - right.index;
      if (left.headroom === null) return 1;
      if (right.headroom === null) return -1;
      if (right.headroom !== left.headroom) return right.headroom - left.headroom;
      return left.index - right.index;
    });
  return eligible[0];
}

/** Best enabled subscription of one provider, eligible or not. */
function bestEnabled(candidates: RankedSubscription[]): RankedSubscription | undefined {
  return candidates
    .filter((candidate) => candidate.subscription.enabled)
    .sort((left, right) => {
      if (left.headroom === null && right.headroom === null) return left.index - right.index;
      if (left.headroom === null) return 1;
      if (right.headroom === null) return -1;
      if (right.headroom !== left.headroom) return right.headroom - left.headroom;
      return left.index - right.index;
    })[0];
}

function providerReason(name: string, candidates: RankedSubscription[]): string {
  if (candidates.length === 0) return `${name} has no subscription`;
  const enabled = candidates.filter((candidate) => candidate.subscription.enabled);
  if (enabled.length === 0) return `${name} has no enabled subscription`;
  if (enabled.every((candidate) => candidate.usage?.status === "invalid")) {
    return `${name} rejected every key`;
  }
  return `${name} has no subscription above 1% remaining`;
}

/**
 * Chooses the provider for one peer. An eligible OpenCode Go subscription
 * wins; otherwise an eligible OpenRouter subscription serves the fallback
 * model; otherwise the peer is refused with a reason naming both providers.
 */
export function decideProvider(
  ranked: RankedSubscription[],
  configured: boolean,
): ProviderDecision {
  if (!configured) {
    return {
      kind: "refused",
      reason:
        "No provider is configured. Open the Providers dialog (settings.providers) and add an OpenCode Go or OpenRouter API key.",
    };
  }

  const goCandidates = ranked.filter((candidate) => candidate.subscription.provider === "opencode-go");
  const openRouterCandidates = ranked.filter(
    (candidate) => candidate.subscription.provider === "openrouter",
  );
  const openRouter = best(openRouterCandidates);
  const go = best(goCandidates);

  if (go !== undefined) {
    const fallback = bestEnabled(openRouterCandidates);
    return {
      kind: "selected",
      subscription: go.subscription,
      usage: go.usage,
      fallback: fallback?.subscription,
      fallbackUsage: fallback?.usage,
    };
  }
  if (openRouter !== undefined) {
    return {
      kind: "selected",
      subscription: openRouter.subscription,
      usage: openRouter.usage,
      fallback: undefined,
      fallbackUsage: undefined,
    };
  }

  return {
    kind: "refused",
    reason: `No provider subscription is eligible: ${providerReason(
      "OpenCode Go",
      goCandidates,
    )}; ${providerReason("OpenRouter", openRouterCandidates)}. Open the Providers dialog (settings.providers) to add or refresh a key.`,
  };
}

/** A path-safe, stable directory name for one selection. */
export function selectionId(provider: ProviderId, subscriptionId: string): string {
  const safe = subscriptionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return `${provider}-${safe}`;
}

export function agentDirectory(stateDir: string, provider: ProviderId, subscriptionId: string): string {
  return join(stateDir, "providers", "agents", selectionId(provider, subscriptionId));
}

/**
 * OMP discovers implicit local model servers on every start: Ollama, LM Studio,
 * llama.cpp, and Apple's on-device provider. A peer can only run the two
 * providers in this catalog, so those probes are pure noise and fail with
 * `ECONNREFUSED` or `HTTP 404` on a host that serves none of them. Pinning them
 * off keeps the peer from logging discovery warnings the watchdog then files.
 */
export const DISABLED_PEER_PROVIDERS = ["ollama", "lm-studio", "llama.cpp", "apple"] as const;

/**
 * The generated config pins every model role and, for a Go selection, walks
 * to the OpenRouter fallback model on any provider error. It also disables the
 * implicit local providers no peer can run.
 */
export function generatedConfig(provider: ProviderId, model: string): string {
  const lines = ["# Generated by devboard for one ACP peer. Do not edit.", "modelRoles:"];
  for (const role of MODEL_ROLES) lines.push(`  ${role}: ${model}`);
  lines.push("disabledProviders:");
  for (const disabled of DISABLED_PEER_PROVIDERS) lines.push(`  - ${disabled}`);
  if (provider === "opencode-go") {
    lines.push(
      "retry:",
      "  modelFallback: true",
      "  fallbackOn: any",
      "  fallbackChains:",
      '    "opencode-go/*":',
      `      - ${OPENROUTER_FALLBACK_MODEL}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** The MCP server name every peer's generated agent directory registers. */
export const DEVBOARD_MCP_SERVER = "devboard";

/** The harness that owns this module, resolved without a checkout-specific path. */
export function devboardHarnessDirectory(): string {
  return resolve(import.meta.dir, "..", "..");
}

/**
 * The generated peer's MCP registration. The entry itself carries no absolute
 * path: `PI_CODING_AGENT_DIR` is already in every peer's environment, and the
 * generated wrapper next to it imports the harness that wrote it.
 */
export const DEVBOARD_MCP_ENTRY = {
  type: "stdio",
  command: "sh",
  args: [
    "-c",
    "exec bun \"$(if [ -n \"$DEVBOARD_HARNESS_DIR\" ]; then printf '%s/mcp/index.ts' " +
      "\"$DEVBOARD_HARNESS_DIR\"; elif [ -n \"$PI_CODING_AGENT_DIR\" ] && " +
      "[ -f \"$PI_CODING_AGENT_DIR/devboard-mcp.ts\" ]; then " +
      "printf '%s/devboard-mcp.ts' \"$PI_CODING_AGENT_DIR\"; elif " +
      "[ -f .devboard/mcp/index.ts ]; then printf '%s' .devboard/mcp/index.ts; else " +
      "printf '%s' .devboard/node_modules/@dsdenes/devboard/mcp/index.ts; fi)\"",
  ],
} as const;

/**
 * One peer role's MCP registration. The default role is the full Devboard
 * server; a role that needs a narrower surface (the watchdog's deduplication
 * peer) supplies its own entry and wrapper body.
 */
export interface AgentMcp {
  /** The `mcpServers` map written to `mcp.json`. */
  servers: Record<string, unknown>;
  /** The wrapper file the entry starts, written next to `mcp.json`. */
  wrapperName: string;
  wrapper: string;
}

function defaultAgentMcp(): AgentMcp {
  return {
    servers: { [DEVBOARD_MCP_SERVER]: DEVBOARD_MCP_ENTRY },
    wrapperName: "devboard-mcp.ts",
    wrapper: [
      "// Generated by devboard for one ACP peer. Do not edit.",
      `import { startStdio } from ${JSON.stringify(join(devboardHarnessDirectory(), "mcp", "index.ts"))};`,
      "",
      "await startStdio();",
      "",
    ].join("\n"),
  };
}

export function generatedMcpConfig(mcp: AgentMcp = defaultAgentMcp()): string {
  return `${JSON.stringify({ mcpServers: mcp.servers }, null, 2)}\n`;
}

function writeFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created or is already gone.
    }
    throw error;
  }
}

/** Writes the generated config and MCP registration; the directory is 0700. */
export function writeAgentDirectory(
  directory: string,
  config: string,
  mcp: AgentMcp = defaultAgentMcp(),
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileAtomic(join(directory, "config.yml"), config);
  writeFileAtomic(join(directory, "mcp.json"), generatedMcpConfig(mcp));
  writeFileAtomic(join(directory, mcp.wrapperName), mcp.wrapper);
}

export interface PeerBinding {
  provider: ProviderId;
  providerName: string;
  subscriptionId: string;
  subscriptionLabel: string;
  model: string;
  /** The selected key's lowest remaining fraction, or null when unknown. */
  remainingFraction: number | null;
  agentDir: string;
  env: Record<string, string | undefined>;
}

/**
 * Builds the peer environment. Both provider variables are removed before the
 * selected values are applied, so the operator's shell cannot leak in.
 */
export function peerEnvironment(
  base: NodeJS.ProcessEnv,
  binding: Omit<PeerBinding, "env">,
  selectedKey: string,
  fallbackKey: string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.OPENCODE_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.PI_CODING_AGENT_DIR;
  if (binding.provider === "opencode-go") {
    env.OPENCODE_API_KEY = selectedKey;
    if (fallbackKey !== undefined) env.OPENROUTER_API_KEY = fallbackKey;
  } else {
    env.OPENROUTER_API_KEY = selectedKey;
  }
  env.PI_CODING_AGENT_DIR = binding.agentDir;
  return env;
}

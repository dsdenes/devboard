import { OPENCODE_GO_MODEL, PROVIDERS } from "./catalog";
import {
  agentDirectory,
  generatedConfig,
  peerEnvironment,
  writeAgentDirectory,
  type AgentMcp,
  type PeerBinding,
} from "./selection";
import { ProviderService } from "./service";

/**
 * The one generated peer binding every ACP role that spends model prose uses.
 * Coach's finalizer and the watchdog's deduplication agent both start
 * `AGENT_COMMAND` with a per-peer directory and an OpenCode Go key.
 *
 * The usage endpoint is deliberately not consulted. It is shared with the
 * dashboard's rotation, can be unreachable or transiently rejecting, and a
 * quota probe must not decide whether a cycle can finish. The peer fails on a
 * bad key and the caller fails closed.
 */

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface OpenCodePeerOptions {
  /** Names the requester in a refusal, e.g. "the finalizer". */
  subject: string;
  /** Distinguishes this role's generated agent directory from other roles'. */
  agentSuffix?: string;
  /** The MCP registration the generated directory carries. */
  mcp?: AgentMcp;
}

/**
 * One binding per enabled OpenCode Go subscription, in the operator's list
 * order, each with its pinned model. An enabled OpenRouter subscription
 * supplies the fallback chain's key when one exists.
 */
export function openCodePeerBindings(
  stateDir: string,
  environment: Record<string, string | undefined>,
  options: OpenCodePeerOptions,
): Resolved<PeerBinding[]> {
  const service = new ProviderService({ stateDir, env: environment });
  const subscriptions = service.list();
  const candidates = subscriptions.filter(
    (entry) => entry.provider === "opencode-go" && entry.enabled,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `${options.subject} needs an enabled OpenCode Go subscription; add one in the ` +
        "Providers dialog (settings.providers)",
    };
  }
  const fallback = subscriptions.find(
    (entry) => entry.provider === "openrouter" && entry.enabled,
  );
  const bindings: PeerBinding[] = [];
  for (const subscription of candidates) {
    const directory = agentDirectory(
      stateDir,
      "opencode-go",
      options.agentSuffix === undefined
        ? subscription.id
        : `${subscription.id}-${options.agentSuffix}`,
    );
    try {
      writeAgentDirectory(
        directory,
        generatedConfig("opencode-go", OPENCODE_GO_MODEL),
        options.mcp,
      );
    } catch (error) {
      return {
        ok: false,
        reason: `${options.subject} agent directory could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const binding: Omit<PeerBinding, "env"> = {
      provider: "opencode-go",
      providerName: PROVIDERS["opencode-go"].name,
      subscriptionId: subscription.id,
      subscriptionLabel: subscription.label,
      model: OPENCODE_GO_MODEL,
      remainingFraction: null,
      agentDir: directory,
    };
    bindings.push({
      ...binding,
      env: peerEnvironment(environment, binding, subscription.key, fallback?.key),
    });
  }
  return { ok: true, value: bindings };
}

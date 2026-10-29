import { OPENCODE_GO_MODEL, PROVIDERS } from "../server/providers/catalog";
import {
  agentDirectory,
  generatedConfig,
  peerEnvironment,
  writeAgentDirectory,
  type PeerBinding,
} from "../server/providers/selection";
import { ProviderService } from "../server/providers/service";
import { readSelectionSnapshot } from "../server/providers/snapshot";

/**
 * The Coach's provider need: one ACP synthesizer peer per selected family. It
 * uses the same generated binding every other agent gets, pinned to OpenCode
 * Go, and never probes the usage endpoint. That endpoint is shared with the
 * dashboard's rotation, can be unreachable or transiently rejecting, and a
 * quota probe must not decide whether a cycle can finish. The peer fails on a
 * bad key and the cycle then fails closed.
 */

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Every registered provider key, for outbound redaction. The Coach files
 * evidence from peer sessions that received these values, so they belong to
 * the secret set even when the worker environment never held them.
 */
export function registeredProviderSecrets(
  stateDir: string,
  environment: Record<string, string | undefined>,
): string[] {
  return new ProviderService({ stateDir, env: environment }).list().map((entry) => entry.key);
}

/**
 * One synthesizer binding per enabled OpenCode Go subscription, led by the
 * dashboard's last selection when it still names an enabled key, then the
 * operator's list order, each with its pinned model. An enabled OpenRouter
 * subscription supplies the fallback chain's key when one exists. Reading the
 * snapshot keeps the synthesizer on the dashboard's selected subscription
 * without probing usage.
 */
export function openCodePeers(
  stateDir: string,
  environment: Record<string, string | undefined>,
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
        "the synthesizer needs an enabled OpenCode Go subscription; add one in the " +
        "Providers dialog (settings.providers)",
    };
  }
  const snapshot = readSelectionSnapshot(stateDir);
  if (snapshot?.provider === "opencode-go") {
    const preferred = candidates.findIndex((entry) => entry.id === snapshot.subscriptionId);
    if (preferred > 0) candidates.unshift(candidates.splice(preferred, 1)[0]!);
  }
  const fallback = subscriptions.find(
    (entry) => entry.provider === "openrouter" && entry.enabled,
  );
  const bindings: PeerBinding[] = [];
  for (const subscription of candidates) {
    const directory = agentDirectory(stateDir, "opencode-go", subscription.id);
    try {
      writeAgentDirectory(directory, generatedConfig("opencode-go", OPENCODE_GO_MODEL));
    } catch (error) {
      return {
        ok: false,
        reason: `the synthesizer agent directory could not be written: ${
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

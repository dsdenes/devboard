import { openCodePeerBindings, type Resolved } from "../server/providers/peers";
import type { PeerBinding } from "../server/providers/selection";
import { ProviderService } from "../server/providers/service";

export type { Resolved };

/**
 * The Coach's two provider needs. The decision gate is a plain HTTPS call, so
 * it needs only an OpenRouter key. The finalizer is an ACP peer, so it needs
 * the same generated binding every other agent gets, pinned to OpenCode Go.
 *
 * The finalizer does not consult the usage endpoint. That endpoint is shared
 * with the dashboard's rotation, can be unreachable or transiently rejecting,
 * and a quota probe must not decide whether a cycle can finish. The peer fails
 * on a bad key and the cycle then fails closed.
 */

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

/** The first enabled OpenRouter subscription, for the decisions transport. */
export function openRouterKey(
  stateDir: string,
  environment: Record<string, string | undefined>,
): Resolved<{ key: string; label: string }> {
  const service = new ProviderService({ stateDir, env: environment });
  const subscription = service
    .list()
    .find((entry) => entry.provider === "openrouter" && entry.enabled);
  if (subscription === undefined) {
    return {
      ok: false,
      reason:
        "the decision gate needs an enabled OpenRouter subscription; add one in the " +
        "Providers dialog (settings.providers)",
    };
  }
  return { ok: true, value: { key: subscription.key, label: subscription.label } };
}

/**
 * One finalizer binding per enabled OpenCode Go subscription, in the operator's
 * list order, each with its pinned model. An enabled OpenRouter subscription
 * supplies the fallback chain's key when one exists.
 */
export function openCodePeers(
  stateDir: string,
  environment: Record<string, string | undefined>,
): Resolved<PeerBinding[]> {
  return openCodePeerBindings(stateDir, environment, { subject: "the finalizer" });
}

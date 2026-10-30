import { openCodePeerBindings, type Resolved } from "../server/providers/peers";
import type { PeerBinding } from "../server/providers/selection";
import { ProviderService } from "../server/providers/service";

export type { Resolved };

/**
 * The Coach's provider need: one ACP synthesizer peer per selected family. It
 * uses the same generated binding every other agent gets, pinned to OpenCode
 * Go, and never probes the usage endpoint. That endpoint is shared with the
 * dashboard's rotation, can be unreachable or transiently rejecting, and a
 * quota probe must not decide whether a cycle can finish. The peer reports a
 * bad key in its own error frame or stderr, the synthesizer rotates to the next
 * subscription, and only a cycle whose calls all fail fails closed.
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
  return openCodePeerBindings(stateDir, environment, { subject: "the synthesizer" });
}

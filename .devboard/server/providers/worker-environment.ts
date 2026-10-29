import { loadSubscriptions } from "./store";
import {
  ProviderService,
  ProviderUnavailableError,
  type ProviderServiceOptions,
} from "./service";

/**
 * A detached worker outlives the credential list it was started with. Every
 * agent it starts resolves the provider again, so a key added, removed, or
 * rotated in the dashboard reaches the next issue run, scan, or audit instead
 * of staying pinned to the worker's original environment.
 */
export type WorkerProviderEnvironment = () => Promise<Record<string, string | undefined>>;

type WorkerProviderOptions = Pick<
  ProviderServiceOptions,
  "fetch" | "usageBaseUrls" | "now" | "timeoutMs" | "log"
>;

/**
 * A worker-scoped resolver: one service keeps usage cached for its TTL, while
 * every call re-reads the credential file so a key added after the worker
 * started is selected by the next agent. A worker that never had credentials
 * (unit tests and hosts without the provider capability) keeps its inherited
 * environment; once a credential existed, an empty store refuses instead of
 * falling back to the pinned key the worker was started with.
 */
export function createWorkerProviderEnvironment(
  stateDir: string,
  environment: Record<string, string | undefined>,
  options: WorkerProviderOptions = {},
): WorkerProviderEnvironment {
  let service: ProviderService | undefined;
  let configured = false;
  return async () => {
    service ??= new ProviderService({ stateDir, env: environment, ...options });
    service.reload();
    if (service.list().length === 0) {
      if (configured) {
        throw new ProviderUnavailableError(
          "No provider is configured. Open the Providers dialog (settings.providers) and add " +
            "an OpenCode Go or OpenRouter API key.",
        );
      }
      return environment;
    }
    configured = true;
    return (await service.select()).env;
  };
}

/**
 * One-shot form for callers that resolve a single agent. A long-lived worker
 * uses `createWorkerProviderEnvironment` so unchanged usage stays cached.
 */
export async function workerPeerEnvironment(
  stateDir: string,
  environment: Record<string, string | undefined>,
  options: WorkerProviderOptions = {},
): Promise<Record<string, string | undefined>> {
  if (loadSubscriptions(stateDir).subscriptions.length === 0) return environment;
  const service = new ProviderService({ stateDir, env: environment, ...options });
  return (await service.select()).env;
}

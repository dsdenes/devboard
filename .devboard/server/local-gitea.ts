import { configuredGiteaUrl } from "../lib/forge";
import {
  discoverLocalGitea,
  type LocalGiteaOptions,
} from "../lib/local-gitea";
import { originForge } from "../issues/repository";
import { isHarnessSourceCheckout } from "./version";

/** Host names that mean this machine. */
const LOCAL_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
  "0.0.0.0": true,
};

export interface SourceCheckoutGiteaOptions extends LocalGiteaOptions {
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /** Overrides the filesystem predicate; tests set it directly. */
  sourceCheckout?: boolean;
}

/**
 * The Gitea HTTP origin a source-checkout dashboard discovers for itself, or
 * undefined. An explicit `DEVBOARD_GITEA_URL`/`GITEA_URL` always wins. An
 * installed host never probes, and neither does a checkout whose Gitea origin
 * is not on this machine or already names an HTTP(S) origin: those either
 * need no discovery or must not be redirected to a local instance.
 */
export async function sourceCheckoutGiteaUrl(
  options: SourceCheckoutGiteaOptions,
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  if (configuredGiteaUrl(environment) !== undefined) return undefined;
  if (!(options.sourceCheckout ?? isHarnessSourceCheckout(options.repoDir))) return undefined;
  const remote = originForge(options.repoDir, environment);
  if (remote?.forge !== "gitea") return undefined;
  if (remote.originUrl !== undefined || LOCAL_HOSTS[remote.host] !== true) return undefined;
  return discoverLocalGitea(options);
}

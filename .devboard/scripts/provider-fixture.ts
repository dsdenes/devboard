import { saveSubscriptions } from "../server/providers";

/**
 * Provider credentials for verification scripts that start real peers but do
 * not exercise the provider dialog themselves. The key never leaves the
 * isolated `.tmp` fixture, and the usage base points at a closed local port so
 * the check fails fast and the subscription is eligible with unknown headroom.
 */

export const VERIFICATION_PROVIDER_KEY = "sk-verify-harness-0000000000abcd";

export function seedVerificationProvider(stateDir: string): void {
  const timestamp = new Date().toISOString();
  saveSubscriptions(stateDir, [
    {
      id: "verify-provider",
      provider: "opencode-go",
      label: "Verification Go",
      key: VERIFICATION_PROVIDER_KEY,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);
}

/** Environment that keeps every usage check local and fast-failing. */
export function verificationProviderUsageEnv(): Record<string, string> {
  return {
    DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: "http://127.0.0.1:9/zen/go",
    DEVBOARD_OPENROUTER_USAGE_BASE_URL: "http://127.0.0.1:9/api",
  };
}

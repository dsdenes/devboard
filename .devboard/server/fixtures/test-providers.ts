import { ProviderService, saveSubscriptions } from "../providers";

/**
 * A deterministic provider service for tests. It seeds one OpenCode Go
 * subscription with plenty of headroom and answers usage locally, so no test
 * touches the network or the operator's credentials.
 */

const TEST_KEY = "test-opencode-go-key-0001";

export function testProviderService(stateDir: string): ProviderService {
  const timestamp = new Date().toISOString();
  saveSubscriptions(stateDir, [
    {
      id: "test-opencode-go",
      provider: "opencode-go",
      label: "Test Go",
      key: TEST_KEY,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);
  const fetchUsage = (async () => {
    const body = {
      usage: {
        rolling: { percent: 12, status: "ok", resetsAt: "2030-01-01T00:00:00.000Z" },
        weekly: { percent: 20, status: "ok", resetsAt: "2030-01-07T00:00:00.000Z" },
        monthly: { percent: 30, status: "ok", resetsAt: "2030-02-01T00:00:00.000Z" },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new ProviderService({ stateDir, fetch: fetchUsage });
}

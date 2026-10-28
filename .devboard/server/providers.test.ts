import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  ELIGIBILITY_THRESHOLD,
  MODEL_ROLES,
  PROVIDERS,
  ProviderService,
  ProviderUnavailableError,
  agentDirectory,
  credentialsPath,
  decideProvider,
  generatedConfig,
  loadSubscriptions,
  maskKey,
  rankSubscriptions,
  saveSubscriptions,
  type StoredSubscription,
} from "./providers";
import { runCleanup } from "../watchdog/cleanup";

const roots: string[] = [];

function temporaryRoot(): string {
  const base = join(import.meta.dir, "..", ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "providers-unit-"));
  roots.push(root);
  return join(root, "state");
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function subscription(
  id: string,
  provider: "opencode-go" | "openrouter",
  overrides: Partial<StoredSubscription> = {},
): StoredSubscription {
  return {
    id,
    provider,
    label: id,
    key: `${provider}-key-${id}-1234`,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface GoWindow {
  rolling: number;
  weekly: number;
  monthly: number;
}

interface FakeResponses {
  go?: Record<string, GoWindow>;
  openrouter?: Record<string, { limit: number | null; remaining: number }>;
  statuses?: Record<string, number>;
  failures?: Set<string>;
  calls?: string[];
}

function fakeFetch(responses: FakeResponses): typeof fetch {
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    responses.calls?.push(`${url} ${token}`);
    if (responses.failures?.has(token)) throw new Error("network down");
    const status = responses.statuses?.[token];
    if (status !== undefined) {
      return new Response(JSON.stringify({ error: { message: "no" } }), { status });
    }
    if (url.endsWith("/v1/usage")) {
      const windows = responses.go?.[token];
      if (windows === undefined) return new Response("unknown", { status: 404 });
      return Response.json({
        usage: {
          rolling: { percent: windows.rolling, status: "ok", resetsAt: "2030-01-01T00:00:00Z" },
          weekly: { percent: windows.weekly, status: "ok", resetsAt: "2030-01-07T00:00:00Z" },
          monthly: { percent: windows.monthly, status: "ok", resetsAt: "2030-02-01T00:00:00Z" },
        },
      });
    }
    if (url.endsWith("/api/v1/key") || url.endsWith("/v1/key")) {
      const key = responses.openrouter?.[token];
      if (key === undefined) return new Response("unknown", { status: 404 });
      return Response.json({ data: { limit: key.limit, limit_remaining: key.remaining } });
    }
    return new Response("not found", { status: 404 });
  };
  return handler as unknown as typeof fetch;
}

function service(stateDir: string, responses: FakeResponses): ProviderService {
  return new ProviderService({
    stateDir,
    fetch: fakeFetch(responses),
    usageBaseUrls: {
      "opencode-go": "http://stub.test/zen/go",
      openrouter: "http://stub.test/api",
    },
    env: {},
  });
}

describe("catalog", () => {
  test("has exactly the two providers and their models", () => {
    expect(Object.keys(PROVIDERS)).toEqual(["opencode-go", "openrouter"]);
    expect(PROVIDERS["opencode-go"].envVar).toBe("OPENCODE_API_KEY");
    expect(PROVIDERS["opencode-go"].model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(PROVIDERS.openrouter.envVar).toBe("OPENROUTER_API_KEY");
    expect(PROVIDERS.openrouter.model).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash-1017",
    );
    expect(Object.values(PROVIDERS).map((provider) => provider.name)).toEqual([
      "OpenCode Go",
      "OpenRouter",
    ]);
  });
});

describe("credential store", () => {
  test("writes 0600 in a 0700 directory, survives a reload, and masks keys", () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("one", "opencode-go", { key: "sk-live-abcd1234" })]);
    expect(statSync(join(stateDir, "providers")).mode & 0o777).toBe(0o700);
    expect(statSync(credentialsPath(stateDir)).mode & 0o777).toBe(0o600);
    const reloaded = loadSubscriptions(stateDir);
    expect(reloaded.subscriptions).toHaveLength(1);
    expect(reloaded.subscriptions[0]?.key).toBe("sk-live-abcd1234");
    expect(maskKey("sk-live-abcd1234")).toBe("••••1234");
    expect(maskKey("short")).toBe("••••");
    expect(readdirSync(join(stateDir, "providers")).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  test("never returns a full key in the masked view", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("one", "opencode-go", { key: "sk-live-abcd1234" })]);
    const providers = service(stateDir, {
      go: { "sk-live-abcd1234": { rolling: 10, weekly: 10, monthly: 10 } },
    });
    await providers.refresh(true);
    const serialized = JSON.stringify(providers.view());
    expect(serialized).not.toContain("sk-live-abcd1234");
    expect(serialized).toContain("••••1234");
  });
});

describe("usage", () => {
  test("turns OpenCode Go percentages into remaining fractions", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("go", "opencode-go")]);
    const providers = service(stateDir, {
      go: { "opencode-go-key-go-1234": { rolling: 50, weekly: 90, monthly: 80 } },
    });
    await providers.refresh(true);
    const row = providers.view().subscriptions[0];
    expect(row?.remainingFraction).toBeCloseTo(0.1, 6);
    expect(row?.windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(row?.status).toBe("near-limit");
  });

  test("reads the OpenRouter limit and treats a null limit as unlimited", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("or", "openrouter")]);
    const providers = service(stateDir, {
      openrouter: { "openrouter-key-or-1234": { limit: 100, remaining: 25 } },
    });
    await providers.refresh(true);
    expect(providers.view().subscriptions[0]?.remainingFraction).toBeCloseTo(0.25, 6);
    expect(providers.view().subscriptions[0]?.status).toBe("ok");
  });

  test("marks a rejected key invalid and a failed check unknown", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("bad", "opencode-go")]);
    const rejected = service(stateDir, {
      statuses: { "opencode-go-key-bad-1234": 401 },
    });
    await rejected.refresh(true);
    expect(rejected.view().subscriptions[0]?.status).toBe("invalid");

    const failing = service(stateDir, {
      failures: new Set(["opencode-go-key-bad-1234"]),
    });
    await failing.refresh(true);
    expect(failing.view().subscriptions[0]?.status).toBe("unknown");
    expect(failing.view().subscriptions[0]?.remainingFraction).toBeNull();
  });

  test("caches usage for 60 seconds unless forced", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("go", "opencode-go")]);
    const calls: string[] = [];
    const providers = service(stateDir, {
      calls,
      go: { "opencode-go-key-go-1234": { rolling: 10, weekly: 10, monthly: 10 } },
    });
    await providers.refresh(false);
    await providers.refresh(false);
    expect(calls).toHaveLength(1);
    await providers.refresh(true);
    expect(calls).toHaveLength(2);
  });
});

describe("selection", () => {
  test("excludes exactly 1% remaining and accepts 1.1%", () => {
    const subs = [subscription("edge", "opencode-go"), subscription("below", "opencode-go")];
    const usage = new Map([
      [
        "edge",
        {
          status: "near-limit" as const,
          checkedAt: "",
          windows: [],
          remainingFraction: 1 - 0.99,
          error: null,
        },
      ],
      [
        "below",
        {
          status: "near-limit" as const,
          checkedAt: "",
          windows: [],
          remainingFraction: 1 - 0.989,
          error: null,
        },
      ],
    ]);
    const ranked = rankSubscriptions(subs, usage);
    expect(ranked[0]?.eligible).toBe(false);
    expect(ranked[0]?.headroom).toBeGreaterThan(ELIGIBILITY_THRESHOLD);
    expect(ranked[1]?.eligible).toBe(true);
    const decision = decideProvider(ranked, true);
    expect(decision.kind).toBe("selected");
    if (decision.kind === "selected") expect(decision.subscription.id).toBe("below");
  });

  test("picks the highest minimum window and keeps list order on a tie", () => {
    const subs = [subscription("a", "opencode-go"), subscription("b", "opencode-go")];
    const usage = new Map([
      [
        "a",
        {
          status: "ok" as const,
          checkedAt: "",
          windows: [],
          remainingFraction: 0.5,
          error: null,
        },
      ],
      [
        "b",
        {
          status: "ok" as const,
          checkedAt: "",
          windows: [],
          remainingFraction: 0.5,
          error: null,
        },
      ],
    ]);
    const tie = decideProvider(rankSubscriptions(subs, usage), true);
    expect(tie.kind === "selected" && tie.subscription.id).toBe("a");

    const better = new Map(usage);
    better.set("b", {
      status: "ok",
      checkedAt: "",
      windows: [],
      remainingFraction: 0.7,
      error: null,
    });
    const winner = decideProvider(rankSubscriptions(subs, better), true);
    expect(winner.kind === "selected" && winner.subscription.id).toBe("b");
  });

  test("ranks unknown headroom below every known one", () => {
    const subs = [subscription("unknown", "opencode-go"), subscription("known", "opencode-go")];
    const usage = new Map([
      [
        "unknown",
        { status: "unknown" as const, checkedAt: "", windows: [], remainingFraction: null, error: "x" },
      ],
      [
        "known",
        { status: "ok" as const, checkedAt: "", windows: [], remainingFraction: 0.2, error: null },
      ],
    ]);
    const decision = decideProvider(rankSubscriptions(subs, usage), true);
    expect(decision.kind === "selected" && decision.subscription.id).toBe("known");

    const onlyUnknown = decideProvider(rankSubscriptions(subs.slice(0, 1), usage), true);
    expect(onlyUnknown.kind === "selected" && onlyUnknown.subscription.id).toBe("unknown");
  });

  test("falls back to OpenRouter when no Go subscription is eligible", () => {
    const go = subscription("go", "opencode-go");
    const or = subscription("or", "openrouter");
    const usage = new Map([
      [
        "go",
        { status: "exhausted" as const, checkedAt: "", windows: [], remainingFraction: 0, error: null },
      ],
      [
        "or",
        { status: "ok" as const, checkedAt: "", windows: [], remainingFraction: 0.4, error: null },
      ],
    ]);
    const decision = decideProvider(rankSubscriptions([go, or], usage), true);
    expect(decision.kind).toBe("selected");
    if (decision.kind === "selected") {
      expect(decision.subscription.provider).toBe("openrouter");
      expect(decision.fallback).toBeUndefined();
    }
  });

  test("refuses with both provider names and reasons", () => {
    const go = subscription("go", "opencode-go");
    const or = subscription("or", "openrouter", { enabled: false });
    const usage = new Map([
      [
        "go",
        { status: "exhausted" as const, checkedAt: "", windows: [], remainingFraction: 0, error: null },
      ],
    ]);
    const decision = decideProvider(rankSubscriptions([go, or], usage), true);
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") {
      expect(decision.reason).toContain("OpenCode Go");
      expect(decision.reason).toContain("OpenRouter");
      expect(decision.reason).toContain("1%");
    }
    const empty = decideProvider([], false);
    expect(empty.kind === "refused" && empty.reason).toContain("Providers dialog");
  });
});

describe("peer binding", () => {
  test("strips inherited keys, exposes only the selected ones, and pins roles", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [
      subscription("go", "opencode-go", { key: "go-selected-0001" }),
      subscription("or", "openrouter", { key: "or-fallback-0002" }),
    ]);
    const providers = new ProviderService({
      stateDir,
      fetch: fakeFetch({
        go: { "go-selected-0001": { rolling: 5, weekly: 5, monthly: 5 } },
        openrouter: { "or-fallback-0002": { limit: 100, remaining: 50 } },
      }),
      usageBaseUrls: {
        "opencode-go": "http://stub.test/zen/go",
        openrouter: "http://stub.test/api",
      },
      env: {
        PATH: "/bin",
        OPENCODE_API_KEY: "inherited-go",
        OPENROUTER_API_KEY: "inherited-or",
        PI_CODING_AGENT_DIR: "/operator/agent",
      },
    });
    const binding = await providers.select();
    expect(binding.provider).toBe("opencode-go");
    expect(binding.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(binding.env.PATH).toBe("/bin");
    expect(binding.env.OPENCODE_API_KEY).toBe("go-selected-0001");
    expect(binding.env.OPENROUTER_API_KEY).toBe("or-fallback-0002");
    expect(binding.env.PI_CODING_AGENT_DIR).toBe(
      agentDirectory(stateDir, "opencode-go", "go"),
    );
    expect(binding.env.PI_CODING_AGENT_DIR?.startsWith(join(stateDir, "providers", "agents"))).toBe(
      true,
    );

    const config = readFileSync(join(binding.agentDir, "config.yml"), "utf8");
    const parsed = Bun.YAML.parse(config) as {
      modelRoles: Record<string, string>;
      disabledProviders: string[];
      retry: { modelFallback: boolean; fallbackOn: string; fallbackChains: Record<string, string[]> };
    };
    for (const role of MODEL_ROLES) {
      expect(parsed.modelRoles[role]).toBe("opencode-go/deepseek-v4.1-flash");
    }
    expect(parsed.disabledProviders).toEqual(["ollama", "lm-studio", "llama.cpp", "apple"]);
    expect(parsed.retry.modelFallback).toBe(true);
    expect(parsed.retry.fallbackOn).toBe("any");
    expect(parsed.retry.fallbackChains["opencode-go/*"]).toEqual([
      "openrouter/deepseek/deepseek-v4.1-flash-1017",
    ]);
    expect(readdirSync(binding.agentDir).filter((name) => name !== "config.yml")).toEqual([]);
  });

  test("an OpenRouter selection omits the Go key and the fallback chain", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("or", "openrouter", { key: "or-only-0003" })]);
    const providers = service(stateDir, {
      openrouter: { "or-only-0003": { limit: null, remaining: 0 } },
    });
    const binding = await providers.select();
    expect(binding.provider).toBe("openrouter");
    expect(binding.env.OPENCODE_API_KEY).toBeUndefined();
    expect(binding.env.OPENROUTER_API_KEY).toBe("or-only-0003");
    const parsed = Bun.YAML.parse(readFileSync(join(binding.agentDir, "config.yml"), "utf8")) as {
      modelRoles: Record<string, string>;
      disabledProviders: string[];
      retry?: unknown;
    };
    expect(parsed.modelRoles.default).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
    expect(parsed.disabledProviders).toEqual(["ollama", "lm-studio", "llama.cpp", "apple"]);
    expect(parsed.retry).toBeUndefined();
  });

  test("refuses before creating any agent directory", async () => {
    const stateDir = temporaryRoot();
    const providers = new ProviderService({ stateDir, env: {} });
    await expect(providers.select()).rejects.toBeInstanceOf(ProviderUnavailableError);
    let names: string[] = [];
    try {
      names = readdirSync(join(stateDir, "providers"));
    } catch {
      names = [];
    }
    expect(names).toEqual([]);
    expect(generatedConfig("openrouter", PROVIDERS.openrouter.model)).not.toContain("retry:");
  });
});

describe("cleanup protection", () => {
  test("a week-old credentials file and agent directory survive the sweep", async () => {
    const stateDir = temporaryRoot();
    saveSubscriptions(stateDir, [subscription("old", "opencode-go")]);
    const directory = agentDirectory(stateDir, "opencode-go", "old");
    mkdirSync(directory, { recursive: true });
    const config = join(directory, "config.yml");
    await Bun.write(config, "modelRoles: {}\n");
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(credentialsPath(stateDir), old, old);
    utimesSync(config, old, old);
    chmodSync(join(stateDir, "providers"), 0o700);

    // Also sweep from a parent root: the store is identified by its contents,
    // not only by the covered state directory's own `providers` prefix.
    const parent = join(stateDir, "..");
    const report = runCleanup({
      root: parent,
      now: new Date("2026-02-01T00:00:00.000Z"),
      dryRun: true,
      covered: [{ stateDir: parent, source: "canonical" }],
    });
    const listed = report.roots.flatMap((entry) => entry.candidates.map((candidate) => candidate.path));
    expect(listed.some((path) => path.startsWith(join(stateDir, "providers")))).toBe(false);
    expect(credentialsPath(stateDir).startsWith(parent)).toBe(true);
  });
});

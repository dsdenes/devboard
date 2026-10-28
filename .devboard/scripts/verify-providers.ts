#!/usr/bin/env bun
/**
 * Provider capability contract: credential store, usage fetch, selection,
 * per-peer environment and generated config, refusal, masking, persistence,
 * and cleanup protection. Everything runs under `.devboard/.tmp` against a
 * local provider stub and the deterministic ACP peer; no request leaves the
 * machine.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Server, Subprocess } from "bun";
import {
  MODEL_ROLES,
  PROVIDERS,
  ProviderService,
  ProviderUnavailableError,
  agentDirectory,
  credentialsPath,
  generatedConfig,
  maskKey,
  saveSubscriptions,
  type ProviderId,
  type StoredSubscription,
} from "../server/providers";
import { stateFile } from "../server/state";
import { runCleanup } from "../watchdog/cleanup";
import { freePort, makeRoot, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubPeer = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
const root = await makeRoot("verify-providers");
const stateDir = join(root, "state");
const repoDir = join(root, "host");
const logPath = join(root, "peer.log");

const GO_A = "sk-go-alpha-000000000000abcd";
const GO_B = "sk-go-bravo-000000000000beef";
const GO_EDGE = "sk-go-edge-000000000000cafe";
const GO_BELOW = "sk-go-below-0000000000f00d";
const GO_UNKNOWN = "sk-go-unknown-0000000000babe";
const OR = "sk-or-fallback-0000000000face";
const INHERITED_GO = "inherited-go-key-SHOULD-NOT-LEAK";
const INHERITED_OR = "inherited-or-key-SHOULD-NOT-LEAK";
const INVALID = "sk-invalid-00000000000dead";

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    throw new Error(
      `verify:providers: ${message}${evidence === undefined ? "" : `: ${JSON.stringify(evidence)}`}`,
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

interface Behavior {
  status?: number;
  go?: { rolling: number; weekly: number; monthly: number };
  openrouter?: { limit: number | null; remaining: number };
}

const behaviors = new Map<string, Behavior>();
const usageCalls: Array<{ token: string; path: string }> = [];

let dashboard: Subprocess<"ignore", "ignore", "pipe"> | undefined;
let dashboardPort = 0;
let socket: TestSocket | undefined;

function behaviorFor(token: string): Behavior {
  return behaviors.get(token) ?? { status: 401 };
}

const usageServer: Server<unknown> = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    usageCalls.push({ token, path: url.pathname });
    const behavior = behaviorFor(token);
    if (behavior.status !== undefined) {
      return new Response(JSON.stringify({ error: { message: "rejected" } }), {
        status: behavior.status,
      });
    }
    if (url.pathname === "/zen/go/v1/usage" && behavior.go !== undefined) {
      return Response.json({
        usage: {
          rolling: { percent: behavior.go.rolling, status: "ok", resetsAt: "2030-01-01T00:00:00Z" },
          weekly: { percent: behavior.go.weekly, status: "ok", resetsAt: "2030-01-07T00:00:00Z" },
          monthly: { percent: behavior.go.monthly, status: "ok", resetsAt: "2030-02-01T00:00:00Z" },
        },
      });
    }
    if (url.pathname === "/api/v1/key" && behavior.openrouter !== undefined) {
      return Response.json({
        data: { limit: behavior.openrouter.limit, limit_remaining: behavior.openrouter.remaining },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const basePort = usageServer.port;
const usageBases = {
  "opencode-go": `http://127.0.0.1:${basePort}/zen/go`,
  openrouter: `http://127.0.0.1:${basePort}/api`,
};

function stubSubscription(
  id: string,
  provider: ProviderId,
  key: string,
  overrides: Partial<StoredSubscription> = {},
): StoredSubscription {
  return {
    id,
    provider,
    label: id,
    key,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function matrix(
  name: string,
  subscriptions: StoredSubscription[],
): Promise<ProviderService> {
  const directory = join(root, "matrix", name);
  saveSubscriptions(directory, subscriptions);
  const service = new ProviderService({
    stateDir: directory,
    env: {},
    usageBaseUrls: usageBases,
  });
  await service.refresh(true);
  return service;
}

/* ------------------------------------------------------------------ */
/* 1. Selection matrix                                                 */
/* ------------------------------------------------------------------ */

const alpha = stubSubscription("alpha", "opencode-go", GO_A);
const bravo = stubSubscription("bravo", "opencode-go", GO_B);
const edge = stubSubscription("edge", "opencode-go", GO_EDGE);
const below = stubSubscription("below", "opencode-go", GO_BELOW);
const unknown = stubSubscription("unknown", "opencode-go", GO_UNKNOWN);
const openrouter = stubSubscription("openrouter", "openrouter", OR);

behaviors.set(GO_A, { go: { rolling: 20, weekly: 90, monthly: 90 } });
behaviors.set(GO_B, { go: { rolling: 20, weekly: 20, monthly: 20 } });
behaviors.set(GO_EDGE, { go: { rolling: 99, weekly: 99, monthly: 99 } });
behaviors.set(GO_BELOW, { go: { rolling: 98.9, weekly: 98.9, monthly: 98.9 } });
behaviors.set(GO_UNKNOWN, { status: 500 });
behaviors.set(OR, { openrouter: { limit: 100, remaining: 40 } });

const ranked = await matrix("headroom", [alpha, bravo]);
const rankedDecision = await ranked.select();
assertEqual(rankedDecision.subscriptionId, "bravo", "the headroom winner");
check(
  rankedDecision.remainingFraction !== null && Math.abs(rankedDecision.remainingFraction - 0.8) < 1e-9,
  "the winner's lowest window is not reported",
  rankedDecision.remainingFraction,
);
check(
  usageCalls.some((call) => call.path === "/zen/go/v1/usage" && call.token === GO_A),
  "the stub usage URL was not used",
  usageCalls,
);

const edgeService = await matrix("edge", [edge, below]);
const edgeView = edgeService.view();
const edgeRow = edgeView.subscriptions.find((row) => row.id === "edge");
const belowRow = edgeView.subscriptions.find((row) => row.id === "below");
check(edgeRow?.status === "near-limit", "99% used is not near limit", edgeRow);
check(
  edgeRow.remainingFraction !== null && edgeRow.remainingFraction > 0.01,
  "the 99% fixture does not sit at the floating-point boundary",
  edgeRow.remainingFraction,
);
check(
  belowRow.remainingFraction !== null && belowRow.remainingFraction > 0.01 + 1e-9,
  "98.9% used is not 1.1% remaining",
  belowRow,
);
const edgeDecision = await edgeService.select();
assertEqual(
  edgeDecision.subscriptionId,
  "below",
  "a key at exactly 1% remaining must be excluded and 1.1% accepted",
);

const unknownService = await matrix("unknown", [unknown, alpha]);
assertEqual((await unknownService.select()).subscriptionId, "alpha", "unknown ranks below known");
const onlyUnknown = await matrix("only-unknown", [unknown]);
assertEqual((await onlyUnknown.select()).subscriptionId, "unknown", "unknown headroom is eligible");

behaviors.set(GO_A, { go: { rolling: 100, weekly: 100, monthly: 100 } });
const fallback = await matrix("fallback", [alpha, openrouter]);
const fallbackDecision = await fallback.select();
assertEqual(fallbackDecision.provider, "openrouter", "OpenRouter fallback provider");
assertEqual(
  fallbackDecision.model,
  "openrouter/deepseek/deepseek-v4.1-flash-1017",
  "OpenRouter fallback model",
);
check(
  fallbackDecision.env.OPENCODE_API_KEY === undefined,
  "an OpenRouter selection carried the Go key",
);
assertEqual(fallbackDecision.env.OPENROUTER_API_KEY, OR, "the OpenRouter key");

behaviors.set(OR, { openrouter: { limit: 100, remaining: 0 } });
const refused = await matrix("refused", [alpha, openrouter]);
let refusal = "";
try {
  await refused.select();
} catch (error) {
  check(error instanceof ProviderUnavailableError, "a refusal is not a provider error", error);
  refusal = error.message;
}
check(refusal.includes("OpenCode Go") && refusal.includes("OpenRouter"), "refusal names both providers", refusal);
check(refusal.includes("1%"), "refusal names the threshold", refusal);

const emptyService = new ProviderService({ stateDir: join(root, "matrix", "empty"), env: {} });
let emptyRefusal = "";
try {
  await emptyService.select();
} catch (error) {
  emptyRefusal = error instanceof Error ? error.message : String(error);
}
check(emptyRefusal.includes("Providers dialog"), "an empty store does not point at the dialog", emptyRefusal);

const goConfig = generatedConfig("opencode-go", PROVIDERS["opencode-go"].model);
const parsedGo = Bun.YAML.parse(goConfig) as {
  modelRoles: Record<string, string>;
  retry: { modelFallback: boolean; fallbackOn: string; fallbackChains: Record<string, string[]> };
};
for (const role of MODEL_ROLES) {
  assertEqual(parsedGo.modelRoles[role], PROVIDERS["opencode-go"].model, `generated role ${role}`);
}
assertEqual(parsedGo.retry.modelFallback, true, "retry.modelFallback");
assertEqual(parsedGo.retry.fallbackOn, "any", "retry.fallbackOn");
assertEqual(
  parsedGo.retry.fallbackChains["opencode-go/*"],
  ["openrouter/deepseek/deepseek-v4.1-flash-1017"],
  "retry.fallbackChains",
);

console.log("selection matrix: headroom winner, 1% exclusion, unknown ranking, fallback, refusal");

/* ------------------------------------------------------------------ */
/* 2. Dashboard: save, mask, spawn, persist                            */
/* ------------------------------------------------------------------ */

interface TestSocket {
  events: Array<Record<string, unknown>>;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    label: string,
    from?: number,
  ): Promise<Record<string, unknown>>;
  send(command: unknown): void;
  close(): void;
}

async function connect(url: string): Promise<TestSocket> {
  const socket = new WebSocket(url);
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    from: number;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  const deliver = (message: Record<string, unknown>): void => {
    events.push(message);
    for (const waiter of [...waiters]) {
      if (events.indexOf(message) < waiter.from || !waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  };
  const opened = Promise.withResolvers<void>();
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("verify:providers: websocket error"));
  await opened.promise;
  socket.onmessage = (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as unknown;
      if (typeof parsed === "object" && parsed !== null) deliver(parsed as Record<string, unknown>);
    } catch {
      // Ignore a malformed frame.
    }
  };
  return {
    events,
    send(command) {
      socket.send(JSON.stringify(command));
    },
    waitFor(predicate, label, from = 0) {
      const hit = events.slice(from).find(predicate);
      if (hit !== undefined) return Promise.resolve(hit);
      const { promise, resolve: settle } = Promise.withResolvers<Record<string, unknown>>();
      waiters.push({ predicate, from, resolve: settle });
      const timeout = Promise.withResolvers<Record<string, unknown>>();
      setTimeout(
        () => timeout.reject(new Error(`verify:providers: timed out waiting for ${label}`)),
        20_000,
      );
      return Promise.race([promise, timeout.promise]);
    },
    close() {
      socket.close();
    },
  };
}

async function startDashboard(): Promise<void> {
  dashboardPort = await freePort();
  dashboard = Bun.spawn([process.execPath, "run", "server/index.ts"], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(dashboardPort),
      ADRS_DIR: join(repoDir, "adrs"),
      REPO_DIR: repoDir,
      GOAL_FILE: join(repoDir, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: `${process.execPath} ${stubPeer} --ask --ask-delay-ms=600 --provider-env=${logPath}`,
      DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: usageBases["opencode-go"],
      DEVBOARD_OPENROUTER_USAGE_BASE_URL: usageBases.openrouter,
      DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
      OPENCODE_API_KEY: INHERITED_GO,
      OPENROUTER_API_KEY: INHERITED_OR,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = dashboard.stderr;
  if (stderr instanceof ReadableStream) {
    void (async () => {
      const reader = stderr.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) process.stderr.write(new TextDecoder().decode(value));
      }
    })();
  }
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the provider dashboard",
    30_000,
  );
  socket = await connect(`ws://127.0.0.1:${dashboardPort}/ws`);
}

async function stopDashboard(): Promise<void> {
  socket?.close();
  socket = undefined;
  const child = dashboard;
  dashboard = undefined;
  if (child === undefined) return;
  child.kill("SIGTERM");
  await child.exited;
}

interface ProvidersViewMessage {
  subscriptions: Array<Record<string, unknown>>;
  selection: Record<string, unknown> | null;
  refusal: string | null;
}

async function providersView(): Promise<ProvidersViewMessage> {
  check(socket !== undefined, "no dashboard socket");
  const current = socket;
  const before = current.events.length;
  current.send({ type: "getProviders" });
  const message = await current.waitFor(
    (event) => event.type === "providersState" && event.selection !== undefined,
    "the provider state",
    before,
  );
  return message as unknown as ProvidersViewMessage;
}

async function saveProvider(input: Record<string, unknown>): Promise<void> {
  check(socket !== undefined, "no dashboard socket");
  const current = socket;
  const before = current.events.length;
  current.send({ type: "saveProvider", ...input });
  await current.waitFor(
    (event) => event.type === "providersState" || event.type === "providerError",
    "the provider save result",
    before,
  );
}

await mkdir(join(repoDir, "adrs"), { recursive: true });
await mkdir(join(repoDir, ".omp"), { recursive: true });
await writeFile(join(repoDir, "GOAL.md"), "# Goal\n\nProvider verification.\n");
await mkdir(stateDir, { recursive: true });

await startDashboard();
await providersView();
check(socket !== undefined, "no dashboard socket");
if (socket === undefined) throw new Error("unreachable");

let state = await providersView();
check(state.subscriptions.length === 0, "a fresh store lists subscriptions", state);
check(state.selection === null && (state.refusal ?? "").includes("Providers dialog"), "empty store refusal", state);

await saveProvider({ provider: "opencode-go", label: "Alpha", key: GO_A });
await saveProvider({ provider: "opencode-go", label: "Bravo", key: GO_B });
await saveProvider({ provider: "openrouter", label: "Fallback", key: OR });
state = await providersView();
assertEqual(state.subscriptions.length, 3, "three saved subscriptions");
assertEqual(
  state.selection?.provider,
  "opencode-go",
  "the Go headroom winner serves the peer",
);
assertEqual(state.selection?.label, "Bravo", "the winner is the higher-headroom key");
check(
  (state.subscriptions.find((row) => row.label === "Bravo")?.maskedKey as string) === maskKey(GO_B),
  "the state does not carry only the mask",
  state.subscriptions,
);
const serializedState = JSON.stringify(state);
for (const key of [GO_A, GO_B, OR, INHERITED_GO, INHERITED_OR, INVALID]) {
  check(!serializedState.includes(key), "a full key reached the provider state", key);
}

const bravoId = state.subscriptions.find((row) => row.label === "Bravo")?.id as string;
const alphaId = state.subscriptions.find((row) => row.label === "Alpha")?.id as string;
const orId = state.subscriptions.find((row) => row.provider === "openrouter")?.id as string;

// A rejected save is refused and changes nothing.
behaviors.set(INVALID, { status: 401 });
const countBeforeReject = usageCalls.length;
await saveProvider({ provider: "opencode-go", label: "Invalid", key: INVALID });
const rejection = socket.events.filter((event) => event.type === "providerError").at(-1);
check(
  typeof rejection?.message === "string" && rejection.message.includes("401"),
  "a 401 does not refuse the save visibly",
  rejection,
);
check(usageCalls.length > countBeforeReject, "the save did not validate against the stub");
state = await providersView();
check(!state.subscriptions.some((row) => row.label === "Invalid"), "an invalid key was stored", state);

// A 5xx saves the subscription with unknown status.
const unknownKey = "sk-unknown-0000000000000abc";
behaviors.set(unknownKey, { status: 503 });
await saveProvider({ provider: "opencode-go", label: "Unverifiable", key: unknownKey });
state = await providersView();
const unverifiable = state.subscriptions.find((row) => row.label === "Unverifiable");
assertEqual(unverifiable?.status, "unknown", "a 5xx save has unknown status");
const unverifiableId = unverifiable?.id as string;
const deleteUnknownFrom = socket.events.length;
socket.send({ type: "deleteProvider", id: unverifiableId });
await socket.waitFor(
  (event) =>
    event.type === "providersState" &&
    Array.isArray(event.subscriptions) &&
    event.subscriptions.length === 3,
  "the unknown subscription delete",
  deleteUnknownFrom,
);

// Editing a label does not revalidate.
const callsBeforeLabel = usageCalls.length;
await saveProvider({ id: alphaId, provider: "opencode-go", label: "Alpha renamed" });
check(
  usageCalls.length === callsBeforeLabel,
  "editing a label revalidated the key",
  usageCalls.slice(callsBeforeLabel),
);
state = await providersView();
check(
  state.subscriptions.some((row) => row.label === "Alpha renamed"),
  "the edited label is not stored",
  state.subscriptions,
);

interface PeerLog {
  pid: number;
  argv: string[];
  cwd: string;
  agentDir: string | null;
  opencode: string | null;
  openrouter: string | null;
}

async function peerLogs(): Promise<PeerLog[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PeerLog);
  } catch {
    return [];
  }
}

async function askPeer(conversationId: string): Promise<Record<string, unknown>> {
  check(socket !== undefined, "no dashboard socket");
  const current = socket;
  const start = (await peerLogs()).length;
  const from = current.events.length;
  current.send({
    type: "ask",
    conversationId,
    question: "Which provider serves this peer?",
    context: {
      route: "/",
      url: "http://127.0.0.1/",
      selector: "#providers",
      viewport: "1440x900",
      captured_at: new Date().toISOString(),
      visible_text: "providers",
      dom_excerpt: "<div id=\"providers\"></div>",
    },
  });
  const outcome = await current.waitFor(
    (event) =>
      (event.type === "askDone" && event.conversationId === conversationId) ||
      (event.type === "askError" && event.conversationId === conversationId),
    `ask ${conversationId}`,
    from,
  );
  if (outcome.type === "askError") return outcome;
  await waitFor(async () => ((await peerLogs()).length > start ? true : undefined), "the peer log", 10_000);
  return outcome;
}

const firstDone = await askPeer("verify-first");
check(firstDone.type === "askDone", "the first peer did not finish", firstDone);
const firstLogs = await peerLogs();
const firstPeer = firstLogs.at(-1);
check(firstPeer !== undefined, "the stub peer logged nothing");
assertEqual(firstPeer.agentDir, agentDirectory(stateDir, "opencode-go", bravoId), "the generated PI_CODING_AGENT_DIR");
assertEqual(firstPeer.opencode, fingerprint(GO_B), "the selected Go key fingerprint");
assertEqual(firstPeer.openrouter, fingerprint(OR), "the fallback OpenRouter key fingerprint");
const argvText = firstPeer.argv.join(" ");
for (const key of [GO_A, GO_B, OR, INHERITED_GO, INHERITED_OR]) {
  check(!argvText.includes(key), "a key reached the peer argv", key);
}
check(!firstPeer.argv.some((arg) => arg.startsWith("OPENCODE_")), "the peer argv names a key", firstPeer.argv);

const firstConfig = await readFile(join(firstPeer.agentDir ?? "", "config.yml"), "utf8");
const firstParsed = Bun.YAML.parse(firstConfig) as { modelRoles: Record<string, string> };
for (const role of MODEL_ROLES) {
  assertEqual(firstParsed.modelRoles[role], PROVIDERS["opencode-go"].model, `peer role ${role}`);
}

// Deleting a subscription while its peer runs leaves that peer alone.
check(socket !== undefined, "no dashboard socket");
const running = socket;
const peersBeforeDelete = (await peerLogs()).length;
const runningFrom = running.events.length;
running.send({
  type: "ask",
  conversationId: "verify-delete-running",
  question: "Keep running while the key is deleted.",
  context: {
    route: "/",
    url: "http://127.0.0.1/",
    selector: "#providers",
    viewport: "1440x900",
    captured_at: new Date().toISOString(),
    visible_text: "providers",
    dom_excerpt: "<div id=\"providers\"></div>",
  },
});
await waitFor(async () => ((await peerLogs()).length > peersBeforeDelete ? true : undefined), "the running peer", 10_000);
const deleteRunningFrom = running.events.length;
running.send({ type: "deleteProvider", id: bravoId });
await running.waitFor(
  (event) => event.type === "providersState" && Array.isArray(event.subscriptions) && event.subscriptions.length === 2,
  "the running peer's subscription delete",
  deleteRunningFrom,
);
const runningDone = await running.waitFor(
  (event) => event.type === "askDone" && event.conversationId === "verify-delete-running",
  "the running peer to finish",
  runningFrom,
);
check(runningDone.type === "askDone", "deleting a subscription interrupted its running peer", runningDone);

// No Go subscription is eligible, so the peer runs on OpenRouter.
behaviors.set(GO_A, { go: { rolling: 100, weekly: 100, monthly: 100 } });
behaviors.set(OR, { openrouter: { limit: 100, remaining: 40 } });
const fallbackRefreshFrom = running.events.length;
running.send({ type: "refreshProviders" });
state = (await running.waitFor(
  (event) =>
    event.type === "providersState" &&
    event.selection !== null &&
    (event.selection as Record<string, unknown>).provider === "openrouter",
  "the OpenRouter selection",
  fallbackRefreshFrom,
)) as unknown as ProvidersViewMessage;
assertEqual(state.selection?.label, "Fallback", "the OpenRouter fallback selection");

const fallbackDone = await askPeer("verify-fallback");
check(fallbackDone.type === "askDone", "the fallback peer did not finish", fallbackDone);
const fallbackPeer = (await peerLogs()).at(-1);
check(fallbackPeer !== undefined, "the fallback peer logged nothing");
assertEqual(
  fallbackPeer.agentDir,
  agentDirectory(stateDir, "openrouter", orId),
  "the OpenRouter agent directory",
);
assertEqual(fallbackPeer.opencode, null, "an OpenRouter peer carried the Go key");
assertEqual(fallbackPeer.openrouter, fingerprint(OR), "the OpenRouter peer key fingerprint");
const fallbackConfig = await readFile(join(fallbackPeer.agentDir ?? "", "config.yml"), "utf8");
const fallbackParsed = Bun.YAML.parse(fallbackConfig) as {
  modelRoles: Record<string, string>;
  retry?: unknown;
};
for (const role of MODEL_ROLES) {
  assertEqual(
    fallbackParsed.modelRoles[role],
    "openrouter/deepseek/deepseek-v4.1-flash-1017",
    `fallback role ${role}`,
  );
}
check(fallbackParsed.retry === undefined, "an OpenRouter selection set a fallback chain", fallbackParsed.retry);

// `omp config list` agrees with the generated roles.
const configList = run("omp", ["config", "list", "--json"], {
  cwd: repoDir,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: String(fallbackPeer.agentDir),
  },
});
check(configList.code === 0, "omp config list failed", configList.stderr);
const listed = JSON.parse(configList.stdout) as Record<string, { value?: Record<string, string> }>;
for (const role of MODEL_ROLES) {
  assertEqual(
    listed.modelRoles?.value?.[role],
    "openrouter/deepseek/deepseek-v4.1-flash-1017",
    `omp config list role ${role}`,
  );
}

// Neither provider is eligible: refuse and spawn nothing.
behaviors.set(OR, { openrouter: { limit: 100, remaining: 0 } });
const refusalRefreshFrom = running.events.length;
running.send({ type: "refreshProviders" });
await running.waitFor(
  (event) => event.type === "providersState" && event.selection === null && event.refusal !== null,
  "the refusal state",
  refusalRefreshFrom,
);
const logsBeforeRefusal = (await peerLogs()).length;
const refusedPeer = await askPeer("verify-refusal");
check(refusedPeer.type === "askError", "a refused peer did not answer with an error", refusedPeer);
const refusalText = String(refusedPeer.message ?? "");
check(
  refusalText.includes("OpenCode Go") && refusalText.includes("OpenRouter"),
  "the refusal does not name both providers",
  refusedPeer,
);
assertEqual((await peerLogs()).length, logsBeforeRefusal, "a refused peer started a process");

// The durable state and journal carry no key material.
const stateText = await readFile(stateFile(stateDir, repoDir), "utf8");
for (const key of [GO_A, GO_B, OR, INHERITED_GO, INHERITED_OR, INVALID]) {
  check(!stateText.includes(key), "a key reached the durable state", key);
}
const credentialText = await readFile(credentialsPath(stateDir), "utf8");
for (const key of [GO_A, GO_B, OR]) {
  check(!JSON.parse(JSON.stringify(stateText)).includes(JSON.stringify(maskKey(key))), "the state carries a mask");
}
check(credentialText.includes(GO_A), "the credentials file lost its key"); // store, not output

// File modes and persistence across a restart.
assertEqual((await stat(join(stateDir, "providers"))).mode & 0o777, 0o700, "providers directory mode");
assertEqual((await stat(credentialsPath(stateDir))).mode & 0o777, 0o600, "credentials file mode");
await stopDashboard();
await startDashboard();
state = await providersView();
assertEqual(state.subscriptions.length, 2, "subscriptions after a dashboard restart");
check(
  state.subscriptions.some((row) => row.label === "Alpha renamed") &&
    state.subscriptions.some((row) => row.provider === "openrouter"),
  "the restart lost a subscription",
  state.subscriptions,
);

// Cleanup never sweeps the credential store or the generated agent directories.
const old = new Date("2026-01-01T00:00:00.000Z");
await utimes(credentialsPath(stateDir), old, old);
const agentDirectories = await readdir(join(stateDir, "providers", "agents"));
for (const name of agentDirectories) {
  await utimes(join(stateDir, "providers", "agents", name, "config.yml"), old, old);
}
const cleanup = runCleanup({
  root: stateDir,
  now: new Date("2026-02-01T00:00:00.000Z"),
  dryRun: false,
  covered: [{ stateDir, source: "canonical" }],
});
const swept = cleanup.roots.flatMap((entry) => entry.removed.map((candidate) => candidate.path));
check(
  !swept.some((path) => path.startsWith(join(stateDir, "providers"))),
  "cleanup removed provider data",
  swept,
);
check((await stat(credentialsPath(stateDir))).size > 0, "cleanup emptied the credentials file");

console.log(`masked value: ${maskKey(GO_B)}`);
console.log(`generated agent dir: ${firstPeer.agentDir}`);
console.log(`generated roles: ${MODEL_ROLES.join(", ")} = ${PROVIDERS["opencode-go"].model}`);
console.log(`stripped inherited keys: ${fingerprint(INHERITED_GO)} / ${fingerprint(INHERITED_OR)} absent`);
usageServer.stop(true);
await stopDashboard();
console.log("provider verification passed");

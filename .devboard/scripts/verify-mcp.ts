#!/usr/bin/env bun
/**
 * The Devboard MCP gate. It starts a source dashboard against a throwaway host
 * with a stub forge, stub ACP command, and seeded evidence, then speaks
 * JSON-RPC over the server's stdio exactly as `.omp/mcp.json` declares.
 *
 * It also starts the server from an installed-package layout and inspects the
 * generated agent directory of a started Discover peer. No test contacts a
 * real forge, spawns a real agent, writes outside `.devboard/.tmp`, or reads
 * `$HOME`.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { journalFile } from "../server/journal";
import { agentRegistry } from "../server/agents/registry";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import { pickEntryPoint } from "../lib/entry-point";
import { stageHarness } from "./harness-package";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";
import {
  assertTrue,
  freePort,
  harnessRoot,
  httpStatus,
  run,
  websocketCommand,
  waitFor,
} from "./verification";

const repoRoot = resolve(harnessRoot, "..");
const root = await mkdtemp(join(harnessRoot, ".tmp", "verify-mcp-"));
const host = join(root, "host");
const stateDir = join(host, ".devboard", ".tmp", "state");
const binDir = join(root, "bin");
const store = join(root, "gh-store.json");
const secret = "gitea-secret-value-1234567890";
const dashboards: Array<{ pid: number; port: number }> = [];

function expand(value: string, environment: Record<string, string | undefined>): string {
  return value.replace(
    /\$\{([^}:]+)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) => {
      const found = environment[name];
      if (found !== undefined && found.length > 0) return found;
      return fallback ?? "";
    },
  );
}

function mcpDeclaration(): { command: string; args: string[] } {
  const config = JSON.parse(readFileSync(join(harnessRoot, "omp", "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const server = config.mcpServers?.devboard;
  assertTrue(server !== undefined, "verify:mcp: omp/mcp.json declares no devboard server");
  assertTrue(
    typeof server?.command === "string" && server.command.length > 0,
    "verify:mcp: devboard command is empty",
  );
  for (const argument of server?.args ?? []) {
    assertTrue(!argument.startsWith("/"), `verify:mcp: an absolute path is declared: ${argument}`);
  }
  return {
    command: server?.command ?? "sh",
    args: server?.args ?? [],
  };
}

interface RpcReply {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

class McpClient {
  readonly process: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: RpcReply) => void>();
  private buffer = "";

  constructor(command: string, args: string[], environment: Record<string, string | undefined>, cwd: string) {
    this.process = Bun.spawn({
      cmd: [command, ...args],
      cwd,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.process.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const reply = JSON.parse(line) as RpcReply;
        const id = reply.id;
        if (typeof id === "number") {
          this.pending.get(id)?.(reply);
          this.pending.delete(id);
        }
      }
    }
  }

  send(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    void this.process.stdin.flush();
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<RpcReply> {
    const id = this.nextId;
    this.nextId += 1;
    const { promise, resolve: settle, reject } = Promise.withResolvers<RpcReply>();
    this.pending.set(id, settle);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`verify:mcp: no reply to ${method} in ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const result = reply.result as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const text = result.content?.[0]?.text ?? "";
    if (result.isError === true) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; text: string }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const result = reply.result as { content?: Array<{ text?: string }>; isError?: boolean };
    return { error: result.isError === true, text: result.content?.[0]?.text ?? "" };
  }

  async close(): Promise<void> {
    try {
      this.process.kill();
    } catch {
      // Already gone.
    }
    await this.process.exited;
    for (const settle of this.pending.values()) settle({ id: -1, error: { message: "closed" } });
    this.pending.clear();
  }
}

const STUB_GH = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const storePath = process.env.STUB_GH_STORE;
if (!storePath) { process.stderr.write("no store\\n"); process.exit(1); }
const fs = require("node:fs");
function load() { try { return JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { return { issues: [], next: 1, comments: [] }; } }
function save(value) { fs.writeFileSync(storePath, JSON.stringify(value, null, 2)); }
const joined = args.join(" ");
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ hosts: { "github.com": [{ login: "fixture", active: true, state: "success" }] } }) + "\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") { process.stdout.write("stub-token\\n"); process.exit(0); }
if (args[0] === "api") {
  const jq = args[args.indexOf("--jq") + 1] ?? "";
  if (jq === ".login") { process.stdout.write("fixture\\n"); process.exit(0); }
  if (jq.endsWith(".permissions.push")) { process.stdout.write("true\\n"); process.exit(0); }
  if (jq.endsWith(".permissions")) { process.stdout.write(JSON.stringify({ admin: false, maintain: false, push: true, triage: true, pull: true }) + "\\n"); process.exit(0); }
  process.stdout.write("{}\\n"); process.exit(0);
}
if (args[0] === "label") { process.exit(0); }
const state = load();
if (args[0] === "issue" && args[1] === "create") {
  const title = args[args.indexOf("--title") + 1] ?? "";
  const labels = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === "--label") labels.push(args[index + 1]);
  const body = await Bun.stdin.text();
  const number = state.next++;
  const issue = { number, title, body, state: "OPEN", labels, url: "https://github.com/acme/fixture/issues/" + number, createdAt: "2026-01-01T00:00:00Z" };
  state.issues.push(issue); save(state);
  process.stdout.write(issue.url + "\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  const issue = state.issues.find((entry) => entry.number === number);
  if (!issue) { process.stderr.write("no issue\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(issue) + "\\n"); process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  const stateName = (args[args.indexOf("--state") + 1] ?? "open").toLowerCase();
  const rows = state.issues.filter((issue) => stateName === "all" || issue.state.toLowerCase() === stateName);
  process.stdout.write(JSON.stringify(rows) + "\\n"); process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  const number = Number(args[2]);
  const issue = state.issues.find((entry) => entry.number === number);
  if (issue) { issue.state = "CLOSED"; save(state); }
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "comment") {
  const body = await Bun.stdin.text();
  state.comments.push({ url: args[2], body }); save(state);
  process.exit(0);
}
process.stderr.write("unexpected gh arguments: " + joined + "\\n");
process.exit(1);
`;

const STUB_AGENT = `#!/bin/sh
sleep 0.2
exit 0
`;

function dashboardEnv(
  port: number,
  environment: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...verificationProviderUsageEnv(),
    ...environment,
    HOME: host,
    HOST: "127.0.0.1",
    PORT: String(port),
    REPO_DIR: host,
    ADRS_DIR: join(host, "adrs"),
    GOAL_FILE: join(host, "GOAL.md"),
    STATIC_DIR: join(harnessRoot, "dist"),
    STATE_DIR: stateDir,
    AGENT_COMMAND: join(binDir, "stub-agent"),
    DEVBOARD_WATCHDOG_FIXTURE: "1",
    STUB_GH_STORE: store,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    GITEA_TOKEN: secret,
  };
}

async function startDashboard(
  port: number,
  environment: Record<string, string | undefined> = {},
): Promise<{ pid: number; port: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(harnessRoot, "server", "index.ts")],
    cwd: host,
    env: dashboardEnv(port, environment),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  dashboards.push({ pid: child.pid, port });
  await waitFor(
    async () => (httpStatus(port) === 200 ? true : undefined),
    `verify:mcp: the dashboard on ${port}`,
    30_000,
  );
  return { pid: child.pid, port };
}

function mcpEnvironment(): Record<string, string | undefined> {
  return {
    ...process.env,
    REPO_DIR: host,
    STATE_DIR: stateDir,
    DEVBOARD_HARNESS_DIR: harnessRoot,
    GOAL_FILE: join(host, "GOAL.md"),
    STUB_GH_STORE: store,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    GITEA_TOKEN: secret,
    HOME: host,
  };
}

async function startClient(): Promise<McpClient> {
  const declaration = mcpDeclaration();
  const environment = mcpEnvironment();
  const args = declaration.args.map((argument) => expand(argument, environment));
  const client = new McpClient(declaration.command, args, environment, repoRoot);
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify-mcp", version: "1" },
  });
  const result = initialized.result ?? {};
  assertTrue(
    typeof result.protocolVersion === "string",
    "verify:mcp: initialize returned no protocol version",
  );
  assertTrue(
    (result.serverInfo as Record<string, unknown> | undefined)?.name === "devboard",
    "verify:mcp: initialize named no devboard server",
  );
  assertTrue(
    (result.capabilities as Record<string, unknown> | undefined)?.tools !== undefined,
    "verify:mcp: initialize carried no tools capability",
  );
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return client;
}

function seedSession(id: string, startedAt: string): string {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: startedAt, cwd: host }),
    JSON.stringify({
      type: "message",
      timestamp: startedAt,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo fixture" } },
        ],
        usage: { input: 40, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 65, cost: { total: 0.4 } },
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: startedAt,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ERROR: fixture needle " + secret }],
        isError: true,
      },
    }),
  ].join("\n");
}

try {
  if (!existsSync(join(harnessRoot, "dist", "index.html"))) {
    const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
    assertTrue(build.code === 0, `verify:mcp: bun run build failed: ${build.stderr}`);
  }

  await mkdir(join(host, ".devboard"), { recursive: true });
  await mkdir(join(host, "adrs"), { recursive: true });
  await mkdir(join(host, ".omp"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stateDir, "providers", "agents", "fixture", "sessions", "bucket"), {
    recursive: true,
  });
  await mkdir(join(host, ".devboard", "goal-proposals"), { recursive: true });
  await writeFile(join(host, "GOAL.md"), "# Goal\n");
  await writeFile(join(host, ".devboard", "goal-proposals", "draft.md"), "# Draft\n");
  await writeFile(
    join(stateDir, "providers", "agents", "fixture", "sessions", "bucket", "session-one.jsonl"),
    seedSession("session-one", "2026-01-01T10:00:00.000Z") + "\n",
  );
  await mkdir(join(stateDir, "journal"), { recursive: true });
  await writeFile(
    journalFile(stateDir, host),
    [
      {
        ts: "2026-01-01T10:00:00.000Z",
        repo: host,
        port: 1,
        pid: 1,
        kind: "question",
        text: "Should the parser be rewritten?",
        scope: "run-a",
      },
      {
        ts: "2026-01-01T10:05:00.000Z",
        repo: host,
        port: 1,
        pid: 1,
        kind: "acp-stderr",
        text: `fatal: provider exploded ${secret}`,
        scope: "run-a",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  await writeFile(
    store,
    JSON.stringify({
      issues: [
        {
          number: 1,
          title: "Seeded issue",
          body: "Seeded body\n",
          state: "OPEN",
          labels: [],
          url: "https://github.com/acme/fixture/issues/1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      next: 2,
      comments: [],
    }),
  );
  await writeFile(join(binDir, "stub-gh.ts"), STUB_GH);
  await writeFile(join(binDir, "gh"), `#!/bin/sh\nexec ${process.execPath} ${join(binDir, "stub-gh.ts")} "$@"\n`);
  chmodSync(join(binDir, "gh"), 0o755);
  await writeFile(join(binDir, "stub-agent"), STUB_AGENT);
  chmodSync(join(binDir, "stub-agent"), 0o755);
  seedVerificationProvider(stateDir);
  const install = run("bash", [join(harnessRoot, "install.sh"), host]);
  assertTrue(install.code === 0, `verify:mcp: install.sh failed: ${install.stderr}`);
  Bun.spawnSync({
    cmd: ["git", "init", "-q", host],
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync({
    cmd: ["git", "-C", host, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
    stdout: "ignore",
    stderr: "ignore",
  });

  const port = await freePort();
  await startDashboard(port);
  const client = await startClient();

  /* 1. Transport and the stable catalog. */
  const listed = await client.request("tools/list", {});
  const tools = (listed.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
  assertTrue(
    JSON.stringify(tools.map((tool) => tool.name)) === JSON.stringify([...MCP_TOOL_NAMES]),
    "verify:mcp: tools/list is not the sorted catalog",
  );
  const unknownMethod = await client.request("nope", {});
  assertTrue(unknownMethod.error?.code === -32601, "verify:mcp: unknown method is not -32601");
  const unknownTool = await client.callRaw("nope", {});
  assertTrue(unknownTool.error, "verify:mcp: an unknown tool was not an error result");
  console.log("PASS mcp-transport");

  /* 2. Every read tool. */
  const status = await client.call("devboard_status");
  assertTrue(status.repositoryRoot === host, `verify:mcp: status repo is ${String(status.repositoryRoot)}`);
  assertTrue(
    (status.dashboard as Record<string, unknown>).port === port,
    "verify:mcp: status did not name the live dashboard",
  );
  const sessions = await client.call("agent_sessions_list");
  const sessionRows = sessions.sessions as Array<Record<string, unknown>>;
  assertTrue(sessionRows.length === 1, "verify:mcp: session list is empty");
  assertTrue(sessionRows[0]?.relativeCwd === ".", "verify:mcp: session cwd is not relative");
  assertTrue(sessionRows[0]?.toolErrorCount === 1, "verify:mcp: tool errors were not counted");
  const read = await client.call("agent_session_read", { id: "session-one", limit: 1 });
  assertTrue((read.messages as unknown[]).length === 1, "verify:mcp: session read ignored the limit");
  assertTrue(read.truncated === true, "verify:mcp: session read did not truncate");
  const searched = await client.call("agent_session_search", { query: "needle" });
  assertTrue((searched.matches as unknown[]).length > 0, "verify:mcp: session search found nothing");
  const journal = await client.call("journal_search", { kind: "question" });
  assertTrue((journal.records as unknown[]).length === 1, "verify:mcp: journal search found no record");
  const goal = await client.call("goal_get");
  assertTrue(goal.goal === "# Goal\n", "verify:mcp: goal_get did not read GOAL.md");
  const drafts = await client.call("goal_drafts_list");
  assertTrue((drafts.drafts as unknown[]).length === 1, "verify:mcp: draft list is empty");
  const draft = await client.call("goal_draft_read", { path: ".devboard/goal-proposals/draft.md" });
  assertTrue(draft.text === "# Draft\n", "verify:mcp: draft read is wrong");
  const agents = await client.call("background_agents_list");
  assertTrue(
    JSON.stringify((agents.agents as Array<{ id: string }>).map((agent) => agent.id)) ===
      JSON.stringify([
        "scout",
        "watchdog",
        "design",
        "dead-code",
        "mcp-optimizer",
        "api-standards",
        "single-responsibility",
        "consistent-naming",
        "release-train",
      ]),
    "verify:mcp: the live agents snapshot is wrong",
  );
  const releaseTrain = (agents.agents as Array<Record<string, unknown>>).find(
    (agent) => agent.id === "release-train",
  );
  assertTrue(
    releaseTrain !== undefined &&
      (releaseTrain.cadence as Record<string, unknown> | undefined)?.defaultMinutes === 10,
    "verify:mcp: Release Train cadence is not the 10-minute default",
  );
  const releaseTrainDescriptor = agentRegistry.require("release-train");
  assertTrue(
    releaseTrainDescriptor.commands.start === "startAgent" &&
      releaseTrainDescriptor.commands.stop === "stopAgent" &&
      releaseTrainDescriptor.commands.setSettings === "setAgentSettings",
    "verify:mcp: Release Train does not declare the shared commands",
  );
  const mcpOptimizer = await client.call("background_agent_get", { id: "mcp-optimizer" });
  assertTrue(mcpOptimizer.id === "mcp-optimizer", "verify:mcp: background_agent_get returned another agent");
  const issues = await client.call("issues_list", { state: "all" });
  assertTrue(
    (issues.issues as Array<{ number: number }>).some((issue) => issue.number === 1),
    "verify:mcp: seeded issue missing from issues_list",
  );
  /* 2b. The one seeded entry-point tool. */
  const entryPointTool = tools.find((tool) => tool.name === "entry_point");
  assertTrue(entryPointTool !== undefined, "verify:mcp: entry_point is not in the catalog");
  const entrySchema = (entryPointTool as { inputSchema?: Record<string, unknown> }).inputSchema ?? {};
  const entryProperties = entrySchema.properties as Record<string, Record<string, unknown>>;
  assertTrue(
    JSON.stringify(entryProperties.surface?.enum) ===
      JSON.stringify([
        "scout",
        "design",
        "dead-code",
        "single-responsibility",
        "consistent-naming",
      ]) &&
      entryProperties.seed?.type === "string",
    `verify:mcp: entry_point schema is ${JSON.stringify(entrySchema)}`,
  );
  const seedA = "verify-mcp-entry-seed-a";
  const firstPick = await client.call("entry_point", { surface: "dead-code", seed: seedA });
  const secondPick = await client.call("entry_point", { surface: "dead-code", seed: seedA });
  assertTrue(
    firstPick.path === secondPick.path &&
      firstPick.line === secondPick.line &&
      firstPick.surface === "dead-code" &&
      firstPick.seed === seedA,
    `verify:mcp: a repeated seed moved the entry point: ${JSON.stringify([firstPick, secondPick])}`,
  );
  let otherSeed: string | null = null;
  for (let index = 0; index < 10 && otherSeed === null; index += 1) {
    const seed = `verify-mcp-entry-seed-${index}`;
    const candidate = await client.call("entry_point", { surface: "dead-code", seed });
    if (candidate.path !== firstPick.path) otherSeed = seed;
  }
  assertTrue(
    otherSeed !== null,
    "verify:mcp: ten fresh seeds never produced a second entry point",
  );
  const fresh = await client.call("entry_point", { surface: "scout" });
  const replay = await client.call("entry_point", { surface: "scout", seed: fresh.seed });
  assertTrue(
    typeof fresh.seed === "string" &&
      (fresh.seed as string).length > 0 &&
      fresh.path === replay.path &&
      fresh.line === replay.line,
    `verify:mcp: an omitted seed did not replay: ${JSON.stringify([fresh, replay])}`,
  );
  const twoFilePool = join(root, "two-file-pool");
  await mkdir(twoFilePool, { recursive: true });
  await writeFile(join(twoFilePool, "first.ts"), "export const first = 1;\n");
  await writeFile(join(twoFilePool, "second.ts"), "export const second = 2;\n");
  const twoFilePicks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) =>
    pickEntryPoint({
      repoDir: twoFilePool,
      surface: "dead-code",
      seed: `two-file-${index}`,
    }),
  );
  const twoFilePaths = new Set(twoFilePicks.map((pick) => pick.path));
  assertTrue(
    twoFilePaths.size >= 2,
    `verify:mcp: ten seeds did not reach two paths on a two-file pool: ${JSON.stringify(twoFilePicks)}`,
  );
  const refusedEntry = await client.callRaw("entry_point", { surface: "unknown" });
  assertTrue(refusedEntry.error, "verify:mcp: an unknown surface was not refused");
  console.log(
    `PASS mcp-entry-point entry_point schema surfaces=${JSON.stringify(
      entryProperties.surface?.enum,
    )} seed=${seedA} path=${String(firstPick.path)}:${String(firstPick.line)} ` +
      `differentSeed=${String(otherSeed)} twoFilePoolPaths=${twoFilePaths.size} ` +
      "refusedSurface=unknown",
  );
  const issue = await client.call("issue_get", { number: 1 });
  assertTrue(issue.title === "Seeded issue", "verify:mcp: issue_get returned another issue");
  console.log("PASS mcp-read-tools");

  /* 3. Deterministic work tools. */
  const spec = await client.call("goal_spec_write", {
    objective: "Verify the MCP server",
    successCriteria: "Every tool answers",
    verification: "Run verify:mcp",
    boundaries: "Harness only",
    stopConditions: "None",
  });
  assertTrue(spec.path === ".devboard/goals/verify-the-mcp-server.md", `verify:mcp: spec path ${String(spec.path)}`);
  const specAgain = await client.call("goal_spec_write", {
    objective: "Verify the MCP server",
    successCriteria: "Every tool answers",
    verification: "Run verify:mcp",
    boundaries: "Harness only",
    stopConditions: "None",
  });
  assertTrue(specAgain.slug === "verify-the-mcp-server-2", "verify:mcp: goal spec overwrote its slug");
  const specText = await readFile(join(host, String(spec.path)), "utf8");
  const filed = await client.call("goal_draft_file", {
    specPath: spec.path,
    title: "Filed goal",
    draftPath: ".devboard/goal-proposals/draft.md",
  });
  assertTrue(filed.ok === true, `verify:mcp: goal_draft_file failed: ${JSON.stringify(filed)}`);
  assertTrue(filed.draftRemoved === true, "verify:mcp: the draft was not removed");
  assertTrue(
    !existsSync(join(host, ".devboard", "goal-proposals", "draft.md")),
    "verify:mcp: the draft still exists",
  );
  const stored = JSON.parse(readFileSync(store, "utf8")) as {
    issues: Array<{ number: number; body: string; labels: string[] }>;
  };
  const created = stored.issues.find((entry) => entry.number === Number(filed.number));
  assertTrue(created !== undefined, "verify:mcp: the filed issue is not in the forge");
  assertTrue(created?.body === specText, "verify:mcp: the filed body differs from the spec bytes");
  assertTrue(created?.labels.includes("goal") === true, "verify:mcp: the goal label is missing");
  const closed = await client.call("issue_close", { number: 1, reason: "completed" });
  assertTrue(closed.state === "closed", "verify:mcp: issue_close did not close the issue");
  console.log("PASS mcp-work-tools");

  /* 3b. Every write tool writes the path the server reads. */
  const flowSession = join(stateDir, "flow", "verify-session");
  await mkdir(flowSession, { recursive: true });
  await writeFile(join(flowSession, "session.json"), "{}\n");
  const widgets = await client.call("flow_widgets_register", {
    sessionDir: flowSession,
    widgets: [
      {
        category: "contract",
        concept: "One route",
        summary: "One route was added.",
        rationale: "The diff adds one route.",
        files: ["src/route.ts"],
      },
    ],
  });
  assertTrue(widgets.widgets === 1, "verify:mcp: flow widgets were not registered");
  assertTrue(
    existsSync(join(flowSession, "widgets.json")),
    "verify:mcp: flow widgets.json was not written",
  );
  const ack = await client.call("flow_steering_ack", {
    sessionDir: flowSession,
    ids: ["steer-one"],
  });
  assertTrue(
    Array.isArray(ack.acknowledged) && (ack.acknowledged as unknown[]).length === 1,
    "verify:mcp: flow steering was not acknowledged",
  );
  const checkpoint = await client.call("flow_checkpoint_record", {
    sessionDir: flowSession,
    commit: "abcdef123456",
    summary: "One unit",
    files: 2,
    verification: "passed",
  });
  assertTrue(checkpoint.id === "checkpoint-abcdef1", "verify:mcp: checkpoint id is wrong");
  const verificationRecord = await client.call("flow_verification_record", {
    sessionDir: flowSession,
    command: "bun test",
    status: "passed",
    output: "ok",
  });
  assertTrue(verificationRecord.status === "passed", "verify:mcp: flow verification is wrong");
  const refusedSession = await client.callRaw("flow_widgets_register", {
    sessionDir: join(host, "outside-session"),
    widgets: [],
  });
  assertTrue(refusedSession.error, "verify:mcp: a Flow session outside the state root was accepted");

  const staging = join(host, ".omp", "discover", "staging", "run-verify");
  await mkdir(staging, { recursive: true });
  const stagedSheet = await client.call("discover_sheet_stage", {
    stagingDir: staging,
    sheet: { schemaVersion: 1 },
  });
  assertTrue(
    existsSync(join(staging, "sheet.json")),
    `verify:mcp: discover sheet was not staged: ${JSON.stringify(stagedSheet)}`,
  );
  const stagedGlossary = await client.call("discover_glossary_stage", {
    stagingDir: staging,
    context: "verify",
    yaml: "boundedContext: verify\nconcepts: []\n",
  });
  assertTrue(
    existsSync(join(staging, "glossary", "verify.glossary.yaml")),
    `verify:mcp: glossary was not staged: ${JSON.stringify(stagedGlossary)}`,
  );
  const stagedSignificance = await client.call("discover_significance_stage", {
    stagingDir: staging,
    significance: { schemaVersion: 1, contexts: {} },
  });
  assertTrue(
    existsSync(join(staging, "glossary", "significance.json")),
    `verify:mcp: significance was not staged: ${JSON.stringify(stagedSignificance)}`,
  );
  const stagedSkill = await client.call("discover_skill_stage", {
    stagingDir: staging,
    name: "discover-glossary",
    description: "Use the project glossary for domain terms.",
    body: "# Glossary\n\n- Use the project glossary.",
  });
  assertTrue(
    existsSync(join(staging, "skills", "discover-glossary", "SKILL.md")),
    `verify:mcp: skill was not staged: ${JSON.stringify(stagedSkill)}`,
  );
  const refusedStaging = await client.callRaw("discover_sheet_stage", {
    stagingDir: join(host, "outside-staging"),
    sheet: {},
  });
  assertTrue(refusedStaging.error, "verify:mcp: a staging directory outside the root was accepted");

  const cycle = join(host, ".devboard", ".tmp", "design", "cycles", "cycle-verify");
  await mkdir(cycle, { recursive: true });
  const release = await client.call("design_release_request", {
    cycleDir: cycle,
    summary: "Document the accent rule",
    rationale: "Two surfaces already follow it.",
  });
  assertTrue(
    existsSync(join(cycle, "release-request.json")),
    `verify:mcp: design release request was not written: ${JSON.stringify(release)}`,
  );

  const labelBefore = JSON.parse(readFileSync(store, "utf8")).issues.length as number;
  const createdIssue = await client.call("issue_create", {
    title: "An MCP-created issue",
    body: "## Summary\n\nCreated through the tool.\n",
    labels: ["scout"],
  });
  assertTrue(
    typeof createdIssue.number === "number" && String(createdIssue.url).includes("/issues/"),
    "verify:mcp: issue_create returned no identity",
  );
  assertTrue(
    (createdIssue.labels as string[]).includes("scout"),
    "verify:mcp: issue_create lost its label",
  );
  const storedAfterCreate = JSON.parse(readFileSync(store, "utf8")) as {
    issues: Array<{ number: number; title: string; labels: string[] }>;
  };
  assertTrue(
    storedAfterCreate.issues.length === labelBefore + 1,
    "verify:mcp: issue_create did not reach the forge",
  );
  await client.call("issue_comment", { number: Number(createdIssue.number), body: "A comment." });
  const storedAfterComment = JSON.parse(readFileSync(store, "utf8")) as {
    comments: Array<{ url: string; body: string }>;
  };
  assertTrue(
    storedAfterComment.comments.some((entry) => entry.body === "A comment."),
    "verify:mcp: issue_comment did not reach the forge",
  );
  const beforeInvalid = JSON.parse(readFileSync(store, "utf8")).issues.length as number;
  const invalidCreate = await client.callRaw("issue_create", { title: "No body" });
  assertTrue(invalidCreate.error, "verify:mcp: issue_create accepted a missing body");
  const afterInvalid = JSON.parse(readFileSync(store, "utf8")).issues.length as number;
  assertTrue(
    afterInvalid === beforeInvalid,
    "verify:mcp: an invalid issue_create had a side effect",
  );
  const duplicate = await client.callRaw("watchdog_duplicate_record", {
    fingerprint: "abc",
    issue: "https://github.com/acme/fixture/issues/1",
  });
  assertTrue(duplicate.error, "verify:mcp: a duplicate record without a run directory was accepted");
  const skip = await client.callRaw("mcp_optimizer_proposal_skip", { family: "docs:build" });
  assertTrue(skip.error, "verify:mcp: an MCP optimizer skip without a reason was accepted");
  console.log("PASS mcp-write-tools");

  /* 4. verification_run allowlisting and the output cap. */
  const spam = join(harnessRoot, ".tmp", "verify-mcp-spam.test.ts");
  await writeFile(
    spam,
    'import { test } from "bun:test";\ntest("spam", () => { console.log("x".repeat(40000)); });\n',
  );
  const verification = await client.call("verification_run", {
    check: "test",
    paths: [".tmp/verify-mcp-spam.test.ts"],
  });
  assertTrue(verification.truncated === true, "verify:mcp: verification output was not truncated");
  assertTrue(
    Buffer.byteLength(String(verification.output), "utf8") <= 16 * 1024 + 64,
    "verify:mcp: verification output exceeds 16 KiB",
  );
  const refused = await client.callRaw("verification_run", { check: "rm -rf /" });
  assertTrue(refused.error, "verify:mcp: an arbitrary command was accepted");
  const escaped = await client.callRaw("verification_run", { check: "test", paths: ["../outside"] });
  assertTrue(escaped.error, "verify:mcp: a path outside .devboard was accepted");
  await rm(spam, { force: true });
  console.log("PASS mcp-verification");

  /* 5. Every control tool delegates to the live dashboard. */
  const agent = await client.call("background_agent_control", {
    id: "mcp-optimizer",
    action: "set_settings",
    minutes: 30,
    maxPerHour: 2,
    maxPending: null,
  });
  assertTrue(agent.id === "mcp-optimizer", "verify:mcp: agent control returned another agent");
  assertTrue(
    (agent.agent as Record<string, unknown>).cadence !== undefined,
    "verify:mcp: agent control returned no snapshot",
  );
  const startedIssues = await client.call("issues_control", { action: "start" });
  assertTrue(
    (startedIssues.issues as Record<string, unknown>).root === host,
    "verify:mcp: issues_control start returned no snapshot",
  );
  const checked = await client.call("issues_control", { action: "check_now" });
  assertTrue(
    typeof (checked.issues as Record<string, unknown>).lifecycle === "string",
    "verify:mcp: issues_control returned no issues state",
  );
  const stoppedIssues = await client.call("issues_control", { action: "stop" });
  assertTrue(
    typeof (stoppedIssues.issues as Record<string, unknown>).lifecycle === "string",
    "verify:mcp: issues stop returned no snapshot",
  );
  const issuesLock = join(host, ".devboard", ".tmp", "issues", "lock");
  await waitFor(
    async () => (existsSync(issuesLock) ? undefined : true),
    "verify:mcp: the issues worker to stop",
    20_000,
  );
  const lifecycle = await client.callRaw("lifecycle_control", { action: "pause" });
  assertTrue(
    lifecycle.error && lifecycle.text.includes("No lifecycle run"),
    `verify:mcp: lifecycle refusal is ${lifecycle.text}`,
  );
  const releaseTrainControl = await client.call("background_agent_control", {
    id: "release-train",
    action: "set_settings",
    minutes: 10,
    maxPerHour: null,
    maxPending: null,
  });
  assertTrue(
    releaseTrainControl.id === "release-train" &&
      typeof (releaseTrainControl.agent as Record<string, unknown>).cadence === "object",
    "verify:mcp: Release Train control returned no snapshot",
  );
  const singleResponsibilityControl = await client.call("background_agent_control", {
    id: "single-responsibility",
    action: "set_settings",
    minutes: 60,
    maxPerHour: 10,
    maxPending: 5,
  });
  const singleResponsibilityAgent = singleResponsibilityControl.agent;
  const savedCadence =
    "cadence" in singleResponsibilityAgent ? singleResponsibilityAgent.cadence : undefined;
  const savedLimits =
    "limits" in singleResponsibilityAgent ? singleResponsibilityAgent.limits : undefined;
  assertTrue(
    singleResponsibilityControl.id === "single-responsibility" &&
      savedCadence !== null &&
      typeof savedCadence === "object" &&
      "minutes" in savedCadence &&
      savedCadence.minutes === 60 &&
      savedLimits !== null &&
      typeof savedLimits === "object" &&
      "maxPerHour" in savedLimits &&
      savedLimits.maxPerHour === 10,
    "verify:mcp: Single Responsibility control returned no saved snapshot",
  );
  const consistentNamingControl = await client.call("background_agent_control", {
    id: "consistent-naming",
    action: "set_settings",
    minutes: 60,
    maxPerHour: 10,
    maxPending: 5,
  });
  const consistentNamingAgent = consistentNamingControl.agent;
  const namingCadence =
    "cadence" in consistentNamingAgent ? consistentNamingAgent.cadence : undefined;
  const namingLimits =
    "limits" in consistentNamingAgent ? consistentNamingAgent.limits : undefined;
  assertTrue(
    consistentNamingControl.id === "consistent-naming" &&
      namingCadence !== null &&
      typeof namingCadence === "object" &&
      "minutes" in namingCadence &&
      namingCadence.minutes === 60 &&
      namingLimits !== null &&
      typeof namingLimits === "object" &&
      "maxPending" in namingLimits &&
      namingLimits.maxPending === 5,
    "verify:mcp: Consistent Naming control returned no saved snapshot",
  );
  const flow = await client.call("flow_control", { action: "create_goal" });
  assertTrue(
    typeof (flow.flow as Record<string, unknown>).status === "string",
    "verify:mcp: flow_control returned no snapshot",
  );
  console.log("PASS mcp-control-tools");

  /* 6. Refusals, path escapes, and secret redaction. */
  const escape = await client.callRaw("goal_draft_read", { path: "../secret.md" });
  assertTrue(escape.error, "verify:mcp: a path escape was accepted");
  const absolute = await client.callRaw("goal_draft_read", { path: "/etc/passwd" });
  assertTrue(absolute.error, "verify:mcp: an absolute path was accepted");
  const journalWithSecret = await client.call("journal_search", { kind: "acp-stderr" });
  const secretText = JSON.stringify(journalWithSecret);
  assertTrue(!secretText.includes(secret), "verify:mcp: a secret reached a tool response");
  assertTrue(secretText.includes("<redacted>"), "verify:mcp: the secret was not redacted");
  console.log("PASS mcp-refusals");

  /* 7. A started peer's generated agent directory declares the same server. */
  const agentDirectory = await waitFor(
    async () => {
      const directory = join(stateDir, "providers", "agents");
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(directory, entry.name);
        if (!existsSync(join(candidate, "mcp.json"))) continue;
        return candidate;
      }
      return undefined;
    },
    "verify:mcp: the generated agent directory",
    20_000,
  );
  const generated = JSON.parse(readFileSync(join(agentDirectory, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }>;
  };
  assertTrue(
    generated.mcpServers?.devboard?.type === "stdio",
    "verify:mcp: the peer did not register the devboard server",
  );
  assertTrue(
    generated.mcpServers?.devboard?.args?.join(" ")?.includes("PI_CODING_AGENT_DIR") === true,
    "verify:mcp: the peer registration does not resolve from PI_CODING_AGENT_DIR",
  );
  assertTrue(
    existsSync(join(agentDirectory, "devboard-mcp.ts")),
    "verify:mcp: the generated peer wrapper is missing",
  );
  console.log("PASS mcp-peer-registration");

  /* 8. Zero and many dashboards are refused, naming the ports. */
  const secondPort = await freePort();
  await startDashboard(secondPort);
  const many = await client.callRaw("issues_control", { action: "start" });
  assertTrue(many.error, "verify:mcp: two dashboards were not refused");
  assertTrue(
    many.text.includes(String(port)) && many.text.includes(String(secondPort)),
    `verify:mcp: the many-dashboard refusal names ${many.text}`,
  );
  for (const entry of dashboards.splice(0)) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await waitFor(
    async () => (httpStatus(port) === 200 || httpStatus(secondPort) === 200 ? undefined : true),
    "verify:mcp: the dashboards to stop",
    20_000,
  );
  const none = await client.callRaw("issues_control", { action: "start" });
  assertTrue(none.error, "verify:mcp: a control call without a dashboard succeeded");
  assertTrue(none.text.includes("No live dashboard"), `verify:mcp: no-dashboard refusal is ${none.text}`);
  await client.close();
  console.log("PASS mcp-dashboard-discovery");

  /* 9. The installed package's MCP entry answers initialize and tools/list. */
  const installedHost = join(root, "installed");
  const installedPrefix = join(installedHost, ".devboard");
  const installed = join(installedPrefix, "node_modules", "@dsdenes", "devboard");
  await mkdir(join(installedHost, ".devboard"), { recursive: true });
  await stageHarness(installed, "0.1.0");
  const installedState = join(root, "installed-state");
  await mkdir(installedState, { recursive: true });
  const installedClient = new McpClient(
    "bun",
    [join(installed, "mcp", "index.ts")],
    {
      ...process.env,
      REPO_DIR: installedHost,
      STATE_DIR: installedState,
      DEVBOARD_HARNESS_DIR: installed,
      HOME: installedHost,
    },
    installedHost,
  );
  const installedInit = await installedClient.request("initialize", { protocolVersion: "2025-06-18" });
  assertTrue(
    (installedInit.result as Record<string, unknown>).protocolVersion === "2025-06-18",
    "verify:mcp: the installed server did not initialize",
  );
  const installedTools = await installedClient.request("tools/list", {});
  assertTrue(
    ((installedTools.result as { tools?: unknown[] }).tools ?? []).length === MCP_TOOL_NAMES.length,
    "verify:mcp: the installed server listed the wrong catalog",
  );
  await installedClient.close();
  console.log("PASS mcp-installed-host");

  console.log("verify:mcp: OK");
} finally {
  for (const entry of dashboards) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}

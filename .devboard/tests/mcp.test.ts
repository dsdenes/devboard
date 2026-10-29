import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "../mcp/catalog";
import { callTool } from "../mcp/tools";
import { startStdio } from "../mcp/index";
import type { McpContext } from "../mcp/context";
import type { LiveDashboard } from "../mcp/dashboard";
import type { ForgeIssueDocument, ForgeIssues } from "../lib/forge-issues";
import { journalFile } from "../server/journal";
import { coachDirectory } from "../coach/paths";
import { writeCoachSettings } from "../coach/settings";

const harnessRoot = resolve(import.meta.dir, "..");
const directories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterAll(async () => {
  for (const server of servers) server.stop(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; repoDir: string; stateDir: string; context: McpContext }> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", "mcp-"));
  directories.push(root);
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  await mkdir(join(repoDir, ".devboard", "goals"), { recursive: true });
  await mkdir(join(repoDir, ".devboard", "goal-proposals"), { recursive: true });
  await mkdir(join(repoDir, "adrs"), { recursive: true });
  await mkdir(join(stateDir, "providers", "agents", "fixture", "sessions", "bucket"), {
    recursive: true,
  });
  await writeFile(join(repoDir, "GOAL.md"), "# Goal\n");
  return {
    root,
    repoDir,
    stateDir,
    context: { repoDir, harnessDir: harnessRoot, stateDir, environment: {} },
  };
}

async function seedSession(
  stateDir: string,
  repoDir: string,
  id: string,
  startedAt: string,
): Promise<void> {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: startedAt, cwd: repoDir }),
    JSON.stringify({
      type: "message",
      timestamp: startedAt,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo needle" } },
        ],
        usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { total: 0.25 } },
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: startedAt,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ERROR: needle failed" }],
        isError: true,
      },
    }),
  ];
  await writeFile(
    join(stateDir, "providers", "agents", "fixture", "sessions", "bucket", `${id}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

function valueOf(result: Awaited<ReturnType<typeof callTool>>): unknown {
  if (result.error !== undefined) throw new Error(result.error);
  return result.value;
}

function fakeForge(): ForgeIssues & { labels: Set<string> } {
  const issues: ForgeIssueDocument[] = [];
  const labels = new Set<string>();
  const forge = {
    forge: "github" as const,
    repository: "acme/fixture",
    labels,
    async list(state: "open" | "closed" | "all", limit = 200) {
      return issues
        .filter((issue) => state === "all" || issue.state === state)
        .slice(0, limit)
        .map((issue) => ({ ...issue }));
    },
    async get(number: number) {
      const issue = issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new Error(`no issue ${number}`);
      return { ...issue };
    },
    async ensureLabel(name: string) {
      labels.add(name);
    },
    async create(input: { title: string; body: string; labels?: string[] }) {
      const number = issues.length + 1;
      const issue: ForgeIssueDocument = {
        number,
        title: input.title,
        body: input.body,
        state: "open",
        labels: input.labels ?? [],
        url: `https://forge.test/acme/fixture/issues/${number}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      issues.push(issue);
      return { ...issue };
    },
    async comment() {},
    async close(number: number) {
      const issue = issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new Error(`no issue ${number}`);
      issue.state = "closed";
      return { ...issue };
    },
  };
  return forge;
}

function messages(...lines: string[]): Uint8Array[] {
  return lines.map((line) => new TextEncoder().encode(`${line}\n`));
}

async function stdio(context: McpContext, lines: string[]): Promise<Array<Record<string, unknown>>> {
  const chunks = messages(...lines);
  async function* input(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  let output = "";
  await startStdio({
    context,
    input: input(),
    output: {
      write(text: string) {
        output += text;
        return true;
      },
    },
  });
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface StubDashboard {
  dashboard: LiveDashboard;
  seen: unknown[];
}

function stubDashboard(repoDir: string, stateDir: string): StubDashboard {
  const seen: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "agentsState", agents: [] }));
      },
      message(ws, raw) {
        const command = JSON.parse(String(raw)) as Record<string, unknown>;
        seen.push(command);
        switch (command.type) {
          case "getAgents":
            ws.send(
              JSON.stringify({
                type: "agentsState",
                agents: [{ id: "coach", label: "Coach", lifecycle: "running" }],
              }),
            );
            return;
          case "getAgent":
            ws.send(
              JSON.stringify({
                type: "agentState",
                agent: { id: command.id, label: "Coach", lifecycle: "running" },
              }),
            );
            return;
          case "getIssues":
          case "startIssues":
          case "pauseIssues":
          case "resumeIssues":
          case "stopIssues":
          case "checkIssues":
            ws.send(JSON.stringify({ type: "issuesState", lifecycle: "idle", enabled: true }));
            return;
          case "startLifecycle":
          case "pauseLifecycle":
          case "resumeLifecycle":
          case "stopLifecycle":
          case "startRun":
            ws.send(JSON.stringify({ type: "lifecycleState", stage: "paused", pass: 2, paused: true }));
            return;
          case "saveGoal":
            ws.send(JSON.stringify({ type: "goal", text: String(command.text) }));
            return;
          case "createGoal":
            ws.send(JSON.stringify({ type: "goalCreationStarted" }));
            return;
          case "reviseGoal":
            ws.send(JSON.stringify({ type: "goalRevisionStarted" }));
            return;
          case "prepareSkills":
            ws.send(JSON.stringify({ type: "skillsPreparationStarted" }));
            return;
          case "resetImplementation":
            ws.send(JSON.stringify({ type: "implementationResetStarted" }));
            return;
          case "createFlowGoal":
          case "saveFlowGoal":
          case "startFlowImplementation":
          case "stopFlowImplementation":
            ws.send(JSON.stringify({ type: "flowSnapshot", status: "idle", goal: "" }));
            return;
          default:
            ws.send(
              JSON.stringify({ type: "agentState", agent: { id: command.id, lifecycle: "running" } }),
            );
        }
      },
    },
  });
  servers.push(server);
  return {
    dashboard: {
      pid: process.pid,
      port: server.port ?? 0,
      repoDir,
      harness: harnessRoot,
      stateDir,
    },
    seen,
  };
}

describe("MCP transport and catalog", () => {
  test("initialize, the sorted catalog, and unknown methods", async () => {
    const { context } = await workspace();
    const replies = await stdio(context, [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope" }),
    ]);
    const initialized = replies[0]?.result as Record<string, unknown>;
    expect(initialized.protocolVersion).toBe("2025-06-18");
    expect((initialized.serverInfo as Record<string, unknown>).name).toBe("devboard");
    expect(initialized.capabilities).toEqual({ tools: { listChanged: false } });
    const tools = (replies[1]?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(21);
    expect(MCP_TOOLS.every((tool) => MCP_TOOL_NAMES.includes(tool.name))).toBe(true);
    const error = replies[2]?.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
  });

  test("an unknown tool is an error result and a final line without a newline is answered", async () => {
    const { context } = await workspace();
    const chunks = messages(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }),
    );
    async function* input(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    }
    let output = "";
    await startStdio({
      context,
      input: input(),
      output: { write: (text) => ((output += text), true) },
    });
    const reply = JSON.parse(output.trim()) as Record<string, unknown>;
    const result = reply.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("Unknown tool");
  });

  test("secret values never reach a tool response", async () => {
    const { repoDir, stateDir } = await workspace();
    const environment = { GITEA_TOKEN: "secret-token-value-123456" };
    await mkdir(join(stateDir, "journal"), { recursive: true });
    await writeFile(
      journalFile(stateDir, repoDir),
      `${JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        repo: repoDir,
        port: 1,
        pid: 1,
        kind: "acp-stderr",
        text: "auth failed with secret-token-value-123456",
      })}\n`,
    );
    const replies = await stdio(
      { repoDir, harnessDir: harnessRoot, stateDir, environment },
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "journal_search", arguments: {} },
        }),
      ],
    );
    const text = (replies[0]?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).not.toContain("secret-token-value-123456");
    expect(text).toContain("<redacted>");
  });
});

describe("MCP context tools", () => {
  test("devboard_status returns roots and version state without a secret", async () => {
    const { context } = await workspace();
    const status = valueOf(
      await callTool(context, "devboard_status", {}),
    ) as Record<string, unknown>;
    expect(status.repositoryRoot).toBe(context.repoDir);
    expect(status.harnessDirectory).toBe(harnessRoot);
    expect(status.stateDirectory).toBe(context.stateDir);
    expect(status.dashboard).toBe(null);
    expect(typeof status.versionState).toBe("string");
    expect(JSON.stringify(status)).not.toContain("TOKEN");
  });

  test("session list, read, and search share the session reader", async () => {
    const { context } = await workspace();
    await seedSession(context.stateDir, context.repoDir, "one", "2026-01-01T10:00:00.000Z");
    await seedSession(context.stateDir, context.repoDir, "two", "2026-01-02T10:00:00.000Z");
    const listed = valueOf(
      await callTool(context, "agent_sessions_list", { limit: 1 }),
    ) as { sessions: Array<Record<string, unknown>>; truncated: boolean; nextOffset: number | null };
    expect(listed.sessions.map((session) => session.id)).toEqual(["two"]);
    expect(listed.truncated).toBe(true);
    expect(listed.nextOffset).toBe(1);
    const session = listed.sessions[0]!;
    expect(session.relativeCwd).toBe(".");
    expect(session.messageCount).toBe(2);
    expect(session.toolErrorCount).toBe(1);
    expect(session.tokens).toEqual({ input: 4, output: 2, cacheRead: 1, cacheWrite: 0, total: 7 });
    expect(session.cost).toBeCloseTo(0.25);

    const read = valueOf(
      await callTool(context, "agent_session_read", { id: "two", limit: 1 }),
    ) as { messages: Array<Record<string, unknown>>; truncated: boolean; nextOffset: number };
    expect(read.messages).toHaveLength(1);
    expect(read.truncated).toBe(true);
    expect(read.nextOffset).toBe(1);
    expect(read.messages[0]?.toolName).toBe("bash");

    const search = valueOf(
      await callTool(context, "agent_session_search", { query: "NEEDLE" }),
    ) as { matches: Array<Record<string, unknown>> };
    expect(search.matches.length).toBeGreaterThan(0);
    expect(search.matches[0]?.sessionId).toBe("two");
  });

  test("journal_search filters this repository's records newest first", async () => {
    const { context } = await workspace();
    await mkdir(join(context.stateDir, "journal"), { recursive: true });
    await writeFile(
      journalFile(context.stateDir, context.repoDir),
      [
        {
          ts: "2026-01-01T10:00:00.000Z",
          repo: context.repoDir,
          port: 1,
          pid: 1,
          kind: "question",
          text: "first question",
          scope: "run-a",
        },
        {
          ts: "2026-01-01T11:00:00.000Z",
          repo: context.repoDir,
          port: 1,
          pid: 1,
          kind: "question",
          text: "second question",
          scope: "run-a",
        },
        {
          ts: "2026-01-01T12:00:00.000Z",
          repo: context.repoDir,
          port: 1,
          pid: 1,
          kind: "acp-stderr",
          text: "noise",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const page = valueOf(
      await callTool(context, "journal_search", { kind: "question", scope: "run-a" }),
    ) as { records: Array<Record<string, unknown>> };
    expect(page.records.map((record) => record.text)).toEqual([
      "second question",
      "first question",
    ]);
    const bounded = valueOf(
      await callTool(context, "journal_search", { query: "question" }),
    ) as { records: unknown[]; truncated: boolean };
    expect(bounded.records).toHaveLength(2);
    expect(bounded.truncated).toBe(false);
  });

  test("goal, drafts, and path escapes", async () => {
    const { context } = await workspace();
    await writeFile(join(context.repoDir, ".devboard", "goal-proposals", "one.md"), "# One\n\nText\n");
    const goal = valueOf(await callTool(context, "goal_get", {})) as { goal: string };
    expect(goal.goal).toBe("# Goal\n");
    const drafts = valueOf(await callTool(context, "goal_drafts_list", {})) as {
      drafts: Array<{ path: string; heading: string }>;
    };
    expect(drafts.drafts).toHaveLength(1);
    expect(drafts.drafts[0]?.path).toBe(".devboard/goal-proposals/one.md");
    const draft = valueOf(
      await callTool(context, "goal_draft_read", { path: ".devboard/goal-proposals/one.md" }),
    ) as { text: string };
    expect(draft.text).toBe("# One\n\nText\n");
    const escaped = await callTool(context, "goal_draft_read", { path: "../secret.md" });
    expect(escaped.error).toContain("goal-proposals");
  });

  test("background agents are persisted when no dashboard is live", async () => {
    const { context } = await workspace();
    await writeCoachSettings(coachDirectory(context.stateDir), {
      intervalMinutes: 45,
      maxPerHour: 2,
      maxPending: null,
    });
    const listed = valueOf(await callTool(context, "background_agents_list", {})) as {
      agents: Array<{ id: string; cadence: { minutes: number } }>;
    };
    expect(listed.agents.map((agent) => agent.id)).toEqual(["scout", "watchdog", "coach"]);
    const coach = valueOf(await callTool(context, "background_agent_get", { id: "coach" })) as {
      id: string;
      cadence: { minutes: number };
      lifecycle: string;
    };
    expect(coach.id).toBe("coach");
    expect(coach.cadence.minutes).toBe(45);
    expect(coach.lifecycle).toBe("stopped");
    const unknown = await callTool(context, "background_agent_get", { id: "nope" });
    expect(unknown.error).toContain("Unknown");
  });
});

describe("MCP work and control tools", () => {
  test("goal_spec_write writes five sections once and never overwrites", async () => {
    const { context } = await workspace();
    const sections = {
      objective: "Improve the parser",
      successCriteria: "It parses",
      verification: "Run the tests",
      boundaries: "Nothing else",
      stopConditions: "None",
    };
    const first = valueOf(
      await callTool(context, "goal_spec_write", sections),
    ) as { path: string; slug: string };
    expect(first.path).toBe(".devboard/goals/improve-the-parser.md");
    expect(first.slug).toBe("improve-the-parser");
    const text = await Bun.file(join(context.repoDir, first.path)).text();
    expect(text.indexOf("## Objective")).toBeLessThan(text.indexOf("## Success criteria"));
    expect(text.split("## Objective").length - 1).toBe(1);
    const second = valueOf(
      await callTool(context, "goal_spec_write", sections),
    ) as { slug: string };
    expect(second.slug).toBe("improve-the-parser-2");
    const empty = await callTool(context, "goal_spec_write", { ...sections, verification: " " });
    expect(empty.error).toContain("must not be empty");
  });

  test("goal_draft_file ensures the label, verifies the bytes, and removes the draft", async () => {
    const { context } = await workspace();
    const forge = fakeForge();
    const injected = { ...context, forgeIssues: forge };
    const spec = ".devboard/goals/spec.md";
    const body = "## Objective\n\nA body with a $dollar and `ticks`.\n";
    await writeFile(join(context.repoDir, spec), body);
    await writeFile(join(context.repoDir, ".devboard", "goal-proposals", "draft.md"), "# Draft\n");
    const filed = valueOf(
      await callTool(injected, "goal_draft_file", {
        specPath: spec,
        title: "A goal title",
        draftPath: ".devboard/goal-proposals/draft.md",
      }),
    ) as { ok: boolean; number: number; draftRemoved: boolean; url: string };
    expect(filed.ok).toBe(true);
    expect(filed.draftRemoved).toBe(true);
    expect(forge.labels.has("goal")).toBe(true);
    const issue = await forge.get(filed.number);
    expect(issue.body).toBe(body);
    expect(issue.labels).toEqual(["goal"]);
    expect(await Bun.file(join(context.repoDir, ".devboard", "goal-proposals", "draft.md")).exists()).toBe(false);

    const spec2 = ".devboard/goals/spec2.md";
    await writeFile(join(context.repoDir, spec2), "## Objective\n");
    const bad = await callTool(injected, "goal_draft_file", {
      specPath: spec2,
      title: "# headed",
    });
    expect(bad.error).toContain("heading marker");
  });

  test("issue_close and issue_get go through the injected forge", async () => {
    const { context } = await workspace();
    const forge = fakeForge();
    const injected = { ...context, forgeIssues: forge };
    const created = await forge.create({ title: "one", body: "body", labels: ["goal"] });
    const read = valueOf(await callTool(injected, "issue_get", { number: created.number })) as {
      number: number;
      title: string;
      labels: string[];
    };
    expect(read.title).toBe("one");
    expect(read.labels).toEqual(["goal"]);
    const closed = valueOf(
      await callTool(injected, "issue_close", { number: created.number, reason: "not planned" }),
    ) as { state: string };
    expect(closed.state).toBe("closed");
    const listed = valueOf(await callTool(injected, "issues_list", {})) as {
      issues: Array<{ number: number }>;
    };
    expect(listed.issues.map((issue) => issue.number)).toEqual([created.number]);
  });

  test("verification_run refuses anything outside the allowlist without spawning", async () => {
    const { context } = await workspace();
    const refused = await callTool(context, "verification_run", { check: "rm -rf /" });
    expect(refused.error).toContain("Unknown check");
    const unknown = await callTool(context, "verification_run", { check: "verify:nope" });
    expect(unknown.error).toContain("has no");
    const escaped = await callTool(context, "verification_run", {
      check: "test",
      paths: ["../outside.test.ts"],
    });
    expect(escaped.error?.length).toBeGreaterThan(0);
  });

  test("every control tool delegates to the one live dashboard", async () => {
    const { context } = await workspace();
    const stub = stubDashboard(context.repoDir, context.stateDir);
    const live = { ...context, dashboards: [stub.dashboard] };
    await writeFile(join(context.repoDir, "adrs", "one.md"), "# ADR\n");
    const agent = valueOf(
      await callTool(live, "background_agent_control", {
        id: "coach",
        action: "set_settings",
        minutes: 30,
        maxPerHour: 1,
        maxPending: null,
      }),
    ) as { id: string; agent: Record<string, unknown> };
    expect(agent.id).toBe("coach");
    expect((agent.agent as Record<string, unknown>).lifecycle).toBe("running");

    const agents = valueOf(await callTool(live, "background_agents_list", {})) as {
      agents: Array<{ id: string }>;
    };
    expect(agents.agents.map((entry) => entry.id)).toEqual(["coach"]);

    const issues = valueOf(
      await callTool(live, "issues_control", { action: "check_now" }),
    ) as { action: string; issues: Record<string, unknown> };
    expect(issues.issues.lifecycle).toBe("idle");

    const lifecycle = valueOf(
      await callTool(live, "lifecycle_control", { action: "start_run", file: "adrs/one.md" }),
    ) as { event: Record<string, unknown>; goal: string };
    expect(lifecycle.event.stage).toBe("paused");
    expect(lifecycle.goal).toBe("# Goal\n");

    const goal = valueOf(
      await callTool(live, "goal_control", { action: "save", text: "# New goal\n" }),
    ) as { goal: string };
    expect(goal.goal).toBe("# Goal\n");

    const flow = valueOf(
      await callTool(live, "flow_control", { action: "save_goal", text: "flow goal" }),
    ) as { flow: Record<string, unknown> };
    expect(flow.flow.status).toBe("idle");

    const invalid = await callTool(live, "background_agent_control", {
      id: "coach",
      action: "set_settings",
      minutes: 0,
      maxPerHour: null,
      maxPending: null,
    });
    expect(invalid.error).toContain("1 through 1440");
    const unknownAgent = await callTool(live, "background_agent_control", {
      id: "nope",
      action: "start",
    });
    expect(unknownAgent.error).toContain("Unknown background agent");
  });

  test("control refuses zero and more than one dashboard, naming the ports", async () => {
    const { context } = await workspace();
    const none = await callTool({ ...context, dashboards: [] }, "issues_control", {
      action: "start",
    });
    expect(none.error).toContain("No live dashboard");
    const stub = stubDashboard(context.repoDir, context.stateDir);
    const many = await callTool(
      { ...context, dashboards: [stub.dashboard, { ...stub.dashboard, port: stub.dashboard.port + 1 }] },
      "issues_control",
      { action: "start" },
    );
    expect(many.error).toContain("2 live dashboards");
    expect(many.error).toContain(String(stub.dashboard.port));
  });

  test("a directory path argument with an absolute path is refused", async () => {
    const { context } = await workspace();
    const absolute = await callTool(context, "goal_draft_read", { path: "/etc/passwd" });
    expect(absolute.error).toContain("relative");
    const bounded = await callTool(context, "agent_session_read", { id: "none" });
    expect(bounded.error).toContain("No session");
  });
});

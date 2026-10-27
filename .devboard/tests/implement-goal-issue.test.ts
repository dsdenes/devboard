import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGoalIssuePrompt,
  goalIssueTitle,
  fetchGoalIssue,
  runImplementGoalIssue,
} from "../extensions/implement-goal-issue.ts";
import type { Exec } from "../lib/forge-auth.ts";

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
}

const BODY = `## Objective

Ship the export command.

## Success criteria

- The export command writes one CSV file.

## Verification

- Run \`bun run export\` in \`/repo\` and read the CSV.

## Boundaries

- Only \`src/export.ts\` changes.

## Stop conditions

- Halt only on a missing prerequisite.
`;

const AUTH_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "GITLAB_HOST",
  "GH_PROMPT_DISABLED",
  "NO_COLOR",
  "GIT_TERMINAL_PROMPT",
] as const;

const savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnvironment.clear();
  for (const key of AUTH_ENV_KEYS) savedEnvironment.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Resolves one authenticated GitHub account with push access. */
const authExec: Exec = async (command, args) => {
  if (command === "gh" && args[0] === "auth" && args[1] === "status") {
    return {
      code: 0,
      stdout: JSON.stringify({
        hosts: { "github.com": [{ login: "dsdenes", active: true, state: "success" }] },
      }),
      stderr: "",
      killed: false,
    };
  }
  if (command === "gh" && args[0] === "auth" && args[1] === "token") {
    return { code: 0, stdout: "gho_token\n", stderr: "", killed: false };
  }
  if (command === "gh" && args[0] === "api") {
    if (args.includes("user")) {
      return { code: 0, stdout: "dsdenes\n", stderr: "", killed: false };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ admin: true, maintain: true, push: true, triage: true, pull: true }),
      stderr: "",
      killed: false,
    };
  }
  if (command === "glab") {
    return { code: 1, stdout: "", stderr: "no glab account", killed: false };
  }
  return { code: 1, stdout: "", stderr: `unexpected auth probe: ${command} ${args.join(" ")}`, killed: false };
};

function makeHarness(
  table: (command: string, args: string[]) => Reply | undefined,
  options: { goalMode?: "active" | "paused" | "none"; goalEnabled?: boolean } = {},
) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const sent: string[] = [];
  const calls: string[] = [];
  const activeTools = ["read", "write"];
  const branch =
    options.goalMode === "active" || options.goalMode === "paused"
      ? [
          {
            type: "mode_change",
            mode: options.goalMode === "paused" ? "goal_paused" : "goal",
            data: { goal: { id: "goal-1", objective: "Existing goal" } },
          },
        ]
      : [];

  const pi = {
    async exec(command: string, args: string[]) {
      calls.push([command, ...args].join(" "));
      const reply =
        table(command, args) ?? { code: 1, stderr: `unexpected: ${command} ${args.join(" ")}` };
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: reply.code ?? 0,
        killed: false,
      };
    },
    registerCommand() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [
      { name: "read" },
      ...(activeTools.includes("goal") && options.goalEnabled !== false ? [{ name: "goal" }] : []),
    ],
    async setActiveTools(names: string[]) {
      activeTools.splice(0, activeTools.length, ...names);
    },
    sendUserMessage(content: string) {
      sent.push(content);
    },
  };

  const ctx = {
    cwd: "/repo",
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    sessionManager: { getBranch: () => branch },
    async waitForIdle() {},
  };

  return { pi, ctx, notifications, sent, activeTools, calls };
}

function baseTable(overrides: Record<string, Reply> = {}) {
  const replies: Record<string, Reply> = {
    "git rev-parse --show-toplevel": { stdout: "/repo\n" },
    "git remote get-url origin": { stdout: "git@github.com:owner/repo.git\n" },
    "gh issue view 42 --json number,title,body,url,labels": {
      stdout: JSON.stringify({
        number: 42,
        title: "Add export command",
        url: "https://github.com/owner/repo/issues/42",
        body: BODY,
        labels: [{ name: "goal" }, { name: "enhancement" }],
      }),
    },
    "git worktree list --porcelain": { stdout: "worktree /repo\n" },
    "git show-ref --verify --quiet refs/heads/devboard/goal-42-add-export-command": { code: 1 },
    "git rev-parse --verify main": { code: 0 },
    "git worktree add /repo/.worktree/goal-42-add-export-command -b devboard/goal-42-add-export-command main": {
      code: 0,
    },
    ...overrides,
  };
  return (command: string, args: string[]): Reply | undefined => replies[[command, ...args].join(" ")];
}

describe("runImplementGoalIssue", () => {
  test("refuses a missing number", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("needs exactly one goal issue number");
    expect(harness.sent).toHaveLength(0);
  });

  test("refuses a non-numeric argument", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42 extra", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("must be one issue number");
  });

  test("refuses an existing goal before fetching the issue", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "active" });
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("a goal is already active");
    expect(harness.calls.some((call) => call.startsWith("gh issue view"))).toBe(false);
  });

  test("refuses an issue without the exact goal label before any worktree", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue view 42 --json number,title,body,url,labels": {
          stdout: JSON.stringify({
            number: 42,
            title: "Add export command",
            url: "https://github.com/owner/repo/issues/42",
            body: BODY,
            labels: [{ name: "bug" }, { name: "Goal" }],
          }),
        },
      }),
    );
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`exact "goal" label`);
    expect(harness.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(harness.activeTools).not.toContain("goal");
    expect(harness.sent).toHaveLength(0);
  });

  test("refuses a missing issue", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue view 42 --json number,title,body,url,labels": {
          code: 1,
          stderr: "gh: Not Found (HTTP 404)",
        },
      }),
    );
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("gh issue view 42 failed");
    expect(harness.sent).toHaveLength(0);
  });

  test("queues the issue body verbatim as the goal objective", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42", authExec);

    expect(result.ok).toBe(true);
    expect(harness.activeTools).toContain("goal");
    expect(harness.sent).toHaveLength(1);
    const prompt = harness.sent[0] ?? "";
    const start = prompt.indexOf("<<<OBJECTIVE\n");
    const end = prompt.indexOf("\nOBJECTIVE>>>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const objective = prompt.slice(start + "<<<OBJECTIVE\n".length, end);
    expect(objective).toBe(BODY);
    expect(objective).toBe(result.objective);
    expect(prompt).toContain("/repo/.worktree/goal-42-add-export-command");
    expect(prompt).toContain("devboard/goal-42-add-export-command");
    expect(prompt).toContain(".devboard/scripts/forge-auth.ts exec");
    expect(prompt).toContain("--required write");
    expect(prompt).toContain("gh issue close 42");
    expect(prompt).toContain("Never force-push");
    expect(prompt).toContain("push main to origin");
    expect(prompt).toContain("fetch the latest main");
    expect(prompt).toContain("DEVBOARD-BLOCKED:");
    expect(prompt).not.toContain("distill");
    expect(harness.notifications.at(-1)?.type).toBe("info");
  });

  test("refuses when the goal tool cannot be activated", async () => {
    const harness = makeHarness(baseTable(), { goalEnabled: false });
    const result = await runImplementGoalIssue(harness.pi, harness.ctx, "42", authExec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("goal mode is unavailable");
    expect(harness.sent).toHaveLength(0);
  });
});

describe("prompt and title", () => {
  test("the objective block is the issue body byte for byte", () => {
    const issue = {
      number: 7,
      title: "A goal",
      url: "https://github.com/owner/repo/issues/7",
      body: BODY,
      labels: ["goal"],
    };
    const prompt = buildGoalIssuePrompt(issue, "/repo", "/repo/.worktree/g", "devboard/g", "auth");
    const start = prompt.indexOf("<<<OBJECTIVE\n") + "<<<OBJECTIVE\n".length;
    const end = prompt.indexOf("\nOBJECTIVE>>>");
    expect(prompt.slice(start, end)).toBe(BODY);
  });

  test("bounds the title to 200 characters", () => {
    const title = "x".repeat(400);
    expect(goalIssueTitle(title).length).toBe(200);
    expect(goalIssueTitle("  Add   export  ")).toBe("Add export");
  });

  test("fetchGoalIssue normalizes string and object labels", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue view 42 --json number,title,body,url,labels": {
          stdout: JSON.stringify({
            number: 42,
            title: "Add export command",
            url: "https://github.com/owner/repo/issues/42",
            body: BODY,
            labels: ["goal", { name: "enhancement" }],
          }),
        },
      }),
    );
    const issue = await fetchGoalIssue(
      harness.pi,
      { host: "github.com", project: "owner/repo", forge: "github", login: "dsdenes" },
      42,
      "/repo",
    );
    expect("error" in issue).toBe(false);
    if ("error" in issue) return;
    expect(issue.labels).toEqual(["goal", "enhancement"]);
    expect(issue.body).toBe(BODY);
  });
});

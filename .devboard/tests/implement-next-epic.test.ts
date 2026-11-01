import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGoalPrompt,
  distillObjective,
  fetchEpic,
  forgeAuthCommand,
  listOpenEpics,
  runImplementNextEpic,
  slugify,
} from "../extensions/implement-next-epic.ts";

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
}

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
  "GITEA_TOKEN",
  "DEVBOARD_GITEA_TOKEN",
  "DEVBOARD_GITEA_URL",
  "DEVBOARD_FORGE",
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

interface AuthReply {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

type AuthExec = (
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => Promise<AuthReply>;

interface AuthOptions {
  accounts?: Array<{ login: string; active?: boolean; state?: string; error?: string }>;
  tokens?: Record<string, string>;
  permissions?: Record<string, Record<string, boolean>>;
  users?: Record<string, string>;
  gitlabStatus?: string;
  gitlabAccess?: number;
}

function makeAuthExec(options: AuthOptions = {}): AuthExec {
  const accounts = options.accounts ?? [{ login: "dsdenes", active: true, state: "success" }];
  const tokens = options.tokens ?? { dsdenes: "gho_dsdenes" };
  const permissions = options.permissions ?? {
    gho_dsdenes: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
  const users = options.users ?? {};

  return async (command, args, execOptions) => {
    const key = [command, ...args].join(" ");
    if (command === "gh" && key === "gh auth status --hostname github.com --json hosts") {
      return {
        code: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": accounts.map((account) => ({
              login: account.login,
              active: account.active ?? false,
              state: account.state ?? "success",
              error: account.error ?? "",
            })),
          },
        }),
        stderr: "",
        killed: false,
      };
    }
    if (command === "gh" && args[0] === "auth" && args[1] === "token") {
      const userIndex = args.indexOf("--user");
      const login = userIndex >= 0 ? args[userIndex + 1] : undefined;
      const token = login === undefined ? undefined : tokens[login];
      return token === undefined
        ? { code: 1, stdout: "", stderr: "no token", killed: false }
        : { code: 0, stdout: `${token}\n`, stderr: "", killed: false };
    }
    if (command === "gh" && args[0] === "api") {
      const token = execOptions.env?.GH_TOKEN ?? "";
      if (args.includes("user")) {
        const login =
          users[token] ??
          Object.entries(tokens).find(([, candidate]) => candidate === token)?.[0];
        return login === undefined
          ? { code: 1, stdout: "", stderr: "Bad credentials (HTTP 401)", killed: false }
          : { code: 0, stdout: `${login}\n`, stderr: "", killed: false };
      }
      const permission = permissions[token];
      return permission === undefined
        ? { code: 1, stdout: "", stderr: "Not Found (HTTP 404)", killed: false }
        : { code: 0, stdout: JSON.stringify(permission), stderr: "", killed: false };
    }
    if (
      command === "glab" &&
      key === "glab auth status --hostname gitlab.com --show-token"
    ) {
      return {
        code: 0,
        stdout: options.gitlabStatus ?? "  ✓ Token: glpat-test\n",
        stderr: "",
        killed: false,
      };
    }
    if (command === "glab" && args[0] === "api") {
      if (args.includes("user")) {
        return {
          code: 0,
          stdout: JSON.stringify({ username: "gitlab-user" }),
          stderr: "",
          killed: false,
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          visibility: "private",
          permissions: { project_access: { access_level: options.gitlabAccess ?? 40 } },
        }),
        stderr: "",
        killed: false,
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected auth command: ${key}`, killed: false };
  };
}

const BODY = `## Objective
Ship the export command.

## Success criteria
- \`app export\` exits 0.
- The output file contains the rows.

## Verification
Run \`app export --out out.json\` and inspect the JSON.

## Boundaries
Touch only src/export.ts and tests/export.test.ts.

## Non-goals
No import support.

## Assumptions
None.

## Stop conditions
No budget.

<!-- devboard-epic -->`;

const EPIC_GITHUB = {
  number: 42,
  title: "Add export command",
  url: "https://github.com/owner/repo/issues/42",
  body: BODY,
};

function makeHarness(
  table: (command: string, args: string[]) => Reply | undefined,
  options: {
    goalEnabled?: boolean;
    activeTools?: string[];
    goalMode?: "active" | "paused" | "none";
    authExec?: AuthExec;
  } = {},
) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const sent: string[] = [];
  const activeTools = [...(options.activeTools ?? ["read", "write"])];
  const branch =
    options.goalMode === "active" || options.goalMode === "paused"
      ? [
          {
            type: "mode_change",
            mode: options.goalMode === "paused" ? "goal_paused" : "goal",
            data: { goal: { id: "goal-1", objective: "Existing goal" } },
          },
        ]
      : options.goalMode === "none"
        ? [
            {
              type: "mode_change",
              mode: "goal",
              data: { goal: { id: "goal-1", objective: "Previous goal" } },
            },
            { type: "mode_change", mode: "none" },
          ]
        : [];

  const pi = {
    async exec(command: string, args: string[]) {
      const reply = table(command, args) ?? { code: 1, stderr: `unexpected: ${command} ${args.join(" ")}` };
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
    sessionManager: {
      getBranch: () => branch,
    },
    async waitForIdle() {},
  };

  return {
    pi,
    ctx,
    notifications,
    sent,
    activeTools,
    authExec: options.authExec ?? makeAuthExec(),
  };
}

function baseTable(overrides: Record<string, Reply> = {}) {
  const replies: Record<string, Reply> = {
    "git rev-parse --show-toplevel": { stdout: "/repo\n" },
    "git remote get-url origin": { stdout: "git@github.com:owner/repo.git\n" },
    "gh label list --search epic --limit 100 --json name": { stdout: '[{"name":"epic"}]' },
    "gh issue list --label epic --state open --json number,title,url --limit 100": {
      stdout: JSON.stringify([{ number: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url }]),
    },
    "gh issue view 42 --json number,title,body,url": { stdout: JSON.stringify(EPIC_GITHUB) },
    "git worktree list --porcelain": { stdout: "worktree /repo\n" },
    "git show-ref --verify --quiet refs/heads/devboard/add-export-command": { code: 1 },
    "git rev-parse --verify main": { code: 0 },
    "git worktree add /repo/.worktree/add-export-command -b devboard/add-export-command main": { code: 0 },
    ...overrides,
  };
  return (command: string, args: string[]): Reply | undefined => replies[[command, ...args].join(" ")];
}

const GITEA_REMOTE = "ssh://git@localhost:2223/owner/repo.git";
const GITEA_EPIC = {
  number: 42,
  title: "Add export command",
  html_url: "http://localhost:3001/owner/repo/issues/42",
  state: "open",
  body: BODY,
  labels: [{ id: 1, name: "epic" }],
};

function jsonReply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function giteaFetch() {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname;
    calls.push(`${path}?${url.searchParams.toString()}`);
    if (path === "/api/v1/repos/owner/repo") {
      return jsonReply({ permissions: { admin: true, push: true } });
    }
    if (path === "/api/v1/user") return jsonReply({ login: "ds" });
    if (path === "/api/v1/repos/owner/repo/labels") return jsonReply([{ id: 1, name: "epic" }]);
    if (path === "/api/v1/repos/owner/repo/issues") {
      return jsonReply(url.searchParams.get("page") === "1" ? [GITEA_EPIC] : []);
    }
    if (path === "/api/v1/repos/owner/repo/issues/42") return jsonReply(GITEA_EPIC);
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

describe("distillObjective", () => {
  test("keeps the executable sections and drops the marker and non-goals", () => {
    const objective = distillObjective(EPIC_GITHUB.title, BODY);
    expect(objective).toContain(EPIC_GITHUB.title);
    expect(objective).toContain("## Objective\nShip the export command.");
    expect(objective).toContain("## Success criteria");
    expect(objective).toContain("## Verification");
    expect(objective).toContain("## Boundaries");
    expect(objective).not.toContain("No import support");
    expect(objective).not.toContain("devboard-epic");
  });

  test("falls back to the whole body when no expected section exists", () => {
    expect(distillObjective("Title", "Plain body\n")).toBe("Title\n\nPlain body");
  });
});

describe("slugify", () => {
  test("produces a short kebab slug", () => {
    expect(slugify("Add export command")).toBe("add-export-command");
    expect(slugify("!!!")).toBe("epic");
  });
});

describe("close command", () => {
  const epic = {
    ref: 42,
    title: "Add export command",
    url: "http://localhost:3001/owner/repo/issues/42",
    body: BODY,
  };

  function render(forge: "github" | "gitea", host: string): string {
    const info = { host, project: "owner/repo", forge };
    return buildGoalPrompt(
      epic,
      "## Objective\nShip the export command.",
      "/repo",
      "/repo/.worktree/add-export-command",
      "devboard/add-export-command",
      forge,
      "owner/repo",
      forgeAuthCommand("/repo", info),
    );
  }

  test("a Gitea close checks the identity, then calls the API", () => {
    const prompt = render("gitea", "localhost:3001");
    const close = prompt.match(/^ {2}`(.+)`$/m)?.[1] ?? "";

    expect(close).toContain(".devboard/scripts/forge-auth.ts check");
    expect(close).not.toContain("forge-auth.ts exec");
    expect(close).toContain("--forge gitea --required write");
    expect(close).toContain("&& curl -sS -X PATCH");
    expect(close).toContain('"$DEVBOARD_GITEA_URL/api/v1/repos/owner/repo/issues/42"');
  });

  test("a GitHub close still runs gh under exec", () => {
    const prompt = render("github", "github.com");
    const close = prompt.match(/^ {2}`(.+)`$/m)?.[1] ?? "";

    expect(close).toContain(".devboard/scripts/forge-auth.ts exec");
    expect(close).toContain("gh issue close 42");
  });
});

describe("runImplementNextEpic", () => {
  test("activates the goal tool and sends the distilled epic objective", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.activeTools).toContain("goal");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain(EPIC_GITHUB.url);
    expect(harness.sent[0]).toContain("## Success criteria");
    expect(harness.sent[0]).toContain("/repo/.worktree/add-export-command");
    expect(harness.sent[0]).toContain("devboard/add-export-command");
    expect(harness.sent[0]).toContain("This run is fully autonomous");
    expect(harness.sent[0]).toContain("Do not ask the user anything");
    expect(harness.sent[0]).toContain("Never call the `ask` tool");
    expect(harness.sent[0]).toContain("Do not wait for confirmation");
    expect(harness.sent[0]).toContain("Never offer the user options");
    expect(harness.sent[0]).not.toContain("If blocked by genuine ambiguity");
    expect(harness.sent[0]).toContain("gh issue close 42");
    expect(harness.sent[0]).toContain(".devboard/scripts/forge-auth.ts exec");
    expect(harness.sent[0]).toContain("--required write");
    expect(harness.sent[0]).toContain("fetch the latest main");
    expect(harness.sent[0]).toContain("retry");
    expect(harness.sent[0]).toContain("Never force-push");
    expect(harness.sent[0]).toContain("push main to origin");
    expect(harness.sent[0]).toContain("DEVBOARD-BLOCKED:");
    expect(harness.notifications.at(-1)?.type).toBe("info");
  });

  test("implements the referenced epic while several are open", async () => {
    const other = {
      number: 43,
      title: "Other epic",
      url: "https://github.com/owner/repo/issues/43",
      body: BODY,
    };
    const harness = makeHarness(
      baseTable({
        "gh issue list --label epic --state open --json number,title,url --limit 100": {
          stdout: JSON.stringify([
            { number: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url },
            { number: 43, title: other.title, url: other.url },
          ]),
        },
        "gh issue view 43 --json number,title,body,url": { stdout: JSON.stringify(other) },
        "git show-ref --verify --quiet refs/heads/devboard/other-epic": { code: 1 },
        "git worktree add /repo/.worktree/other-epic -b devboard/other-epic main": { code: 0 },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "43", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain(other.url);
    expect(harness.sent[0]).toContain("gh issue close 43");
    expect(harness.sent[0]).not.toContain(EPIC_GITHUB.url);
  });

  test("refuses a reference that is not open", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "99", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("epic 99 is not open");
    expect(harness.sent).toHaveLength(0);
  });

  test("halts when no open epic exists", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue list --label epic --state open --json number,title,url --limit 100": {
          stdout: "[]",
        },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no open epic");
    expect(harness.sent).toHaveLength(0);
    expect(harness.activeTools).not.toContain("goal");
  });

  test("halts when more than one open epic exists", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue list --label epic --state open --json number,title,url --limit 100": {
          stdout: JSON.stringify([
            { number: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url },
            { number: 43, title: "Other epic", url: "https://github.com/owner/repo/issues/43" },
          ]),
        },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("found 2");
    expect(result.message).toContain("issues/43");
    expect(harness.sent).toHaveLength(0);
  });

  test("uses the marker search and confirms the body marker", async () => {
    const harness = makeHarness(
      baseTable({
        "gh label list --search epic --limit 100 --json name": { stdout: "[]" },
        "gh search issues --repo owner/repo --match body --state open devboard-epic --json number,title,url --limit 100": {
          stdout: JSON.stringify([{ number: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url }]),
        },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  test("rejects a marker search hit whose body has no marker", async () => {
    const harness = makeHarness(
      baseTable({
        "gh label list --search epic --limit 100 --json name": { stdout: "[]" },
        "gh search issues --repo owner/repo --match body --state open devboard-epic --json number,title,url --limit 100": {
          stdout: JSON.stringify([{ number: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url }]),
        },
        "gh issue view 42 --json number,title,body,url": {
          stdout: JSON.stringify({ ...EPIC_GITHUB, body: "## Objective\nNo marker." }),
        },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no open epic");
    expect(harness.sent).toHaveLength(0);
  });

  test("halts when the goal tool cannot be activated", async () => {
    const harness = makeHarness(baseTable(), { goalEnabled: false });
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("goal mode is unavailable");
    expect(harness.sent).toHaveLength(0);
  });

  test("does not treat an active goal tool as an existing goal", async () => {
    const harness = makeHarness(baseTable(), { activeTools: ["read", "goal"] });
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  test("halts when the session branch has an active goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "active" });
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already active");
    expect(harness.sent).toHaveLength(0);
  });

  test("halts when the session branch has a paused goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "paused" });
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already paused");
    expect(harness.sent).toHaveLength(0);
  });

  test("starts a new epic after the latest mode change cleared the goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "none", activeTools: ["read", "goal"] });
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  test("halts without an origin remote", async () => {
    const harness = makeHarness(
      baseTable({ "git remote get-url origin": { code: 1, stderr: "No such remote" } }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("origin remote is not configured");
  });

  test("supports Gitea epics", async () => {
    process.env.GITEA_TOKEN = "test-token";
    process.env.DEVBOARD_GITEA_URL = "http://localhost:3001";
    const gitea = giteaFetch();
    const harness = makeHarness(
      baseTable({ "git remote get-url origin": { stdout: `${GITEA_REMOTE}\n` } }),
    );

    const result = await runImplementNextEpic(
      harness.pi,
      harness.ctx,
      "",
      harness.authExec,
      gitea.fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain(GITEA_EPIC.html_url);
    expect(harness.sent[0]).toContain(
      '"$DEVBOARD_GITEA_URL/api/v1/repos/owner/repo/issues/42"',
    );
    expect(harness.sent[0]).toContain(".devboard/scripts/forge-auth.ts check");
    expect(harness.sent[0]).not.toContain("forge-auth.ts exec");
    expect(harness.sent[0]).not.toContain("gh issue close 42");
    expect(gitea.calls.some((call) => call.startsWith("/api/v1/repos/owner/repo/issues?"))).toBe(
      true,
    );
  });

  test("supports GitLab issues", async () => {
    const gitlabBody = {
      iid: 7,
      title: "Add export command",
      web_url: "https://gitlab.com/group/sub/project/-/issues/7",
      description: BODY,
    };
    const harness = makeHarness(
      baseTable({
        "git remote get-url origin": { stdout: "git@gitlab.com:group/sub/project.git\n" },
        "glab label list --output json": { stdout: '[{"name":"epic"}]' },
        "glab issue list --label epic --output json": { stdout: JSON.stringify([gitlabBody]) },
        "glab issue view 7 --output json": { stdout: JSON.stringify(gitlabBody) },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx, "", harness.authExec);

    expect(result.ok).toBe(true);
    expect(harness.sent[0]).toContain(gitlabBody.web_url);
    expect(harness.sent[0]).toContain("glab issue close 7");
  });
});

describe("listOpenEpics and fetchEpic", () => {
  test("lists every open epic rather than the first", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      number: 100 + index,
      title: `Epic ${index + 1}`,
      url: `https://github.com/owner/repo/issues/${100 + index}`,
    }));
    const harness = makeHarness(
      baseTable({
        "gh issue list --label epic --state open --json number,title,url --limit 100": {
          stdout: JSON.stringify(rows),
        },
      }),
    );
    const listed = await listOpenEpics(
      harness.pi,
      { host: "github.com", project: "owner/repo", forge: "github" },
      "/repo",
    );
    expect("error" in listed).toBe(false);
    if ("error" in listed) return;
    expect(listed.epics).toHaveLength(5);
    expect(listed.epics.map((epic) => epic.ref)).toEqual([100, 101, 102, 103, 104]);
  });

  test("normalizes GitHub listing and fetch results", async () => {
    const harness = makeHarness(baseTable());
    const listed = await listOpenEpics(
      harness.pi,
      { host: "github.com", project: "owner/repo", forge: "github" },
      "/repo",
    );
    expect("error" in listed).toBe(false);
    if ("error" in listed) return;
    expect(listed.epics).toEqual([
      { ref: 42, title: EPIC_GITHUB.title, url: EPIC_GITHUB.url },
    ]);

    const fetched = await fetchEpic(
      harness.pi,
      { host: "github.com", project: "owner/repo", forge: "github" },
      42,
      "/repo",
    );
    expect("error" in fetched).toBe(false);
    if ("error" in fetched) return;
    expect(fetched.body).toContain("Ship the export command");
  });
});

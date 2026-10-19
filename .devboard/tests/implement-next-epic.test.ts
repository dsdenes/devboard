import { describe, expect, test } from "bun:test";
import {
  distillObjective,
  fetchEpic,
  listOpenEpics,
  parseRemote,
  runImplementNextEpic,
  slugify,
} from "../extensions/implement-next-epic.ts";

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
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

  return { pi, ctx, notifications, sent, activeTools };
}

function baseTable(overrides: Record<string, Reply> = {}) {
  const replies: Record<string, Reply> = {
    "git rev-parse --show-toplevel": { stdout: "/repo\n" },
    "git remote get-url origin": { stdout: "git@github.com:owner/repo.git\n" },
    "gh auth status --hostname github.com": { code: 0 },
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

describe("parseRemote", () => {
  test("parses the three supported remote shapes", () => {
    expect(parseRemote("https://github.com/owner/repo.git")).toEqual({
      host: "github.com",
      project: "owner/repo",
    });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/group/sub/project.git")).toEqual({
      host: "gitlab.example.com",
      project: "group/sub/project",
    });
    expect(parseRemote("git@github.com:owner/repo.git")).toEqual({
      host: "github.com",
      project: "owner/repo",
    });
  });

  test("rejects empty and unparseable remotes", () => {
    expect(parseRemote("")).toBeNull();
    expect(parseRemote("not-a-remote")).toBeNull();
  });
});

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

describe("runImplementNextEpic", () => {
  test("activates the goal tool and sends the distilled epic objective", async () => {
    const harness = makeHarness(baseTable());
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

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
    expect(harness.notifications.at(-1)?.type).toBe("info");
  });

  test("halts when no open epic exists", async () => {
    const harness = makeHarness(
      baseTable({
        "gh issue list --label epic --state open --json number,title,url --limit 100": {
          stdout: "[]",
        },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

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
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

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
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

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
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no open epic");
    expect(harness.sent).toHaveLength(0);
  });

  test("halts when the goal tool cannot be activated", async () => {
    const harness = makeHarness(baseTable(), { goalEnabled: false });
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("goal mode is unavailable");
    expect(harness.sent).toHaveLength(0);
  });

  test("does not treat an active goal tool as an existing goal", async () => {
    const harness = makeHarness(baseTable(), { activeTools: ["read", "goal"] });
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  test("halts when the session branch has an active goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "active" });
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already active");
    expect(harness.sent).toHaveLength(0);
  });

  test("halts when the session branch has a paused goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "paused" });
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already paused");
    expect(harness.sent).toHaveLength(0);
  });

  test("starts a new epic after the latest mode change cleared the goal", async () => {
    const harness = makeHarness(baseTable(), { goalMode: "none", activeTools: ["read", "goal"] });
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  test("halts without an origin remote", async () => {
    const harness = makeHarness(
      baseTable({ "git remote get-url origin": { code: 1, stderr: "No such remote" } }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("origin remote is not configured");
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
        "gh auth status --hostname gitlab.com": { code: 1 },
        "glab auth status --hostname gitlab.com": { code: 0 },
        "glab label list --output json": { stdout: '[{"name":"epic"}]' },
        "glab issue list --label epic --output json": { stdout: JSON.stringify([gitlabBody]) },
        "glab issue view 7 --output json": { stdout: JSON.stringify(gitlabBody) },
      }),
    );
    const result = await runImplementNextEpic(harness.pi, harness.ctx);

    expect(result.ok).toBe(true);
    expect(harness.sent[0]).toContain(gitlabBody.web_url);
    expect(harness.sent[0]).toContain("glab issue close 7");
  });
});

describe("listOpenEpics and fetchEpic", () => {
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

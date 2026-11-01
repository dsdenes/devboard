/**
 * `/implement-goal-issue <number>` — take one open issue carrying the exact
 * `goal` label and implement its body as an omp goal in this session.
 *
 * The Issues worker gives every goal-labeled issue its own concurrent ACP peer
 * and prompts it with exactly this command, so the command must be
 * self-contained: it fetches the issue, checks the label, prepares a worktree,
 * activates the `goal` tool, and hands the issue body to the model verbatim.
 *
 * Harness rules: this file lives under `.devboard/`; the only host-side file is
 * the thin wrapper at `.omp/extensions/implement-goal-issue.ts`, copied by
 * `install.sh`.
 */

import {
  createWorktree,
  detectForge,
  execWithEnvironment,
  forgeAuthCommand,
  goalModeFromBranch,
  planWorktree,
  slugify,
  type RemoteInfo,
} from "./implement-next-epic.ts";
import type { Exec } from "../lib/forge-auth.ts";
import { parseForgeRemote, type Forge } from "../lib/forge.ts";
import { giteaIssue, giteaTarget, type FetchLike } from "../lib/gitea.ts";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): Promise<void>;
  sendUserMessage(content: string): void;
}

interface ModeChangeEntry {
  type: string;
  mode?: string;
  data?: Record<string, unknown> | null;
}

interface ExtensionCommandContext {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager: {
    getBranch(): ModeChangeEntry[];
  };
  waitForIdle?(): Promise<void>;
}

export interface GoalIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
}

export interface RunResult {
  ok: boolean;
  message: string;
  issue?: GoalIssue;
  objective?: string;
  worktree?: string;
  branch?: string;
  prompt?: string;
}

interface Failure {
  error: string;
}

type Outcome<T> = T | Failure;

function isFailure<T>(value: Outcome<T>): value is Failure {
  return typeof value === "object" && value !== null && "error" in value;
}

const GOAL_LABEL = "goal";
const TITLE_MAX = 200;

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

async function run(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  try {
    return await pi.exec(command, args, { cwd, timeout: 120_000 });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizedLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") labels.push(entry);
    else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const name = (entry as Record<string, unknown>).name;
      if (typeof name === "string") labels.push(name);
    }
  }
  return labels;
}

/**
 * Fetches one issue from the origin forge; any unusable answer is a failure.
 * GitHub uses `gh`; Gitea uses the API the same identity resolves against.
 */
export async function fetchGoalIssue(
  pi: ExtensionAPI,
  info: RemoteInfo,
  number: number,
  cwd: string,
  giteaFetch?: FetchLike,
): Promise<Outcome<GoalIssue>> {
  if (info.forge === "gitea") {
    try {
      const target = giteaTarget({
        project: info.project,
        ...(info.baseUrl === undefined ? {} : { baseUrl: info.baseUrl }),
      });
      if (target === undefined) {
        return { error: "the Gitea address is not configured; set DEVBOARD_GITEA_URL" };
      }
      const issue = await giteaIssue(target, number, giteaFetch);
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body,
        labels: issue.labels,
      };
    } catch (error) {
      return {
        error: `gitea issue view ${number} failed: ${
          error instanceof Error ? firstLine(error.message) : String(error)
        }`,
      };
    }
  }
  if (info.forge !== "github") {
    return { error: "goal issues are filed with gh or the Gitea API; this origin supports neither" };
  }
  const result = await run(
    pi,
    "gh",
    ["issue", "view", String(number), "--json", "number,title,body,url,labels"],
    cwd,
  );
  if (result.code !== 0) {
    return {
      error: `gh issue view ${number} failed: ${firstLine(result.stderr) || "unknown error"}`,
    };
  }
  const raw = parseJsonObject(result.stdout);
  if (raw === null) return { error: `gh issue view ${number} returned invalid JSON` };
  if (
    typeof raw.number !== "number" ||
    typeof raw.title !== "string" ||
    typeof raw.url !== "string" ||
    typeof raw.body !== "string"
  ) {
    return { error: `gh issue view ${number} returned an unexpected shape` };
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    body: raw.body,
    labels: normalizedLabels(raw.labels),
  };
}

/** The command's one-line title, bounded without splitting a surrogate pair. */
export function goalIssueTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * The goal prompt. The issue body between the markers is the objective the
 * model must pass to `goal create` byte for byte: not distilled, not filtered
 * to sections, and not appended to.
 */
export function buildGoalIssuePrompt(
  issue: GoalIssue,
  repo: string,
  worktree: string,
  branch: string,
  forge: Forge,
  project: string,
  authCommand: string,
): string {
  const closeCommand =
    forge === "github"
      ? `${authCommand} gh issue close ${issue.number}`
      : forge === "gitlab"
        ? `${authCommand} glab issue close ${issue.number}`
        : `${authCommand} && curl -sS -X PATCH -H "Authorization: token $GITEA_TOKEN" ` +
          `-H "Content-Type: application/json" -d '{"state":"closed"}' ` +
          `"$DEVBOARD_GITEA_URL/api/v1/repos/${project}/issues/${issue.number}"`;
  return `Implement the goal filed as issue ${issue.number}. This run is fully autonomous.

Autonomy contract:
- Do not ask the user anything. Never call the \`ask\` tool.
- Do not wait for confirmation, approval, sign-off, or review. Never request permission to proceed.
- Do not stop for a plan, a choice, or a progress check. Never offer the user options.
- Decide from the issue, the repository, its tests, its documentation, and its ADRs. Where those are silent, choose the smallest reversible option, record the assumption in the final report, and continue.
- Continue until every success criterion is verified, the branch is merged, the worktree is removed, and the issue is closed.

Goal issue: ${goalIssueTitle(issue.title)}
URL: ${issue.url}
Repository: ${repo}
Worktree: ${worktree}
Branch: ${branch}

Before doing any work:
1. Call the \`goal\` tool with {"op":"get"}.
2. If it returns any goal (active, paused, budget-limited, complete, or dropped), end the run immediately with that conflict as the result. Do not drop, resume, or replace it, and do not ask the user what to do.
3. Otherwise call the \`goal\` tool with {"op":"create","objective": <the objective below>}. Pass the objective exactly as written below, byte for byte.

Objective:
<<<OBJECTIVE
${issue.body}
OBJECTIVE>>>

After the goal tool succeeds, implement the issue end to end:
- Work only inside the worktree path above. Never edit, write, or run mutating commands in ${repo}; that checkout is for the final merge only.
- Use absolute paths under the worktree for every tool, and pass the worktree as \`cwd\` to \`bash\`.
- Read the issue URL for the full context, including any detail omitted from the objective.
- Follow every success criterion and verification scenario in the body. Perform each check through the product's user-visible surface in the worktree, observe the actual result, and use the repository's documented build and test commands only as supporting evidence.
- Never end a turn while a background job you started is still running: when a \`wait\` returns a still-running snapshot, call \`wait\` again. Leave the turn only once the work is finished or the exact blocker is known.
- Keep the goal active until every criterion is verified. Call the \`goal\` tool with {"op":"complete"} only then.
- When complete, merge ${branch} into main from ${repo}. First fetch the latest main and integrate it into ${branch}; then merge. If the merge fails, fetch the latest main again, integrate it, and retry. Never force-push. After the merge succeeds, push main to origin and remove the worktree and branch, per AGENTS.md. If the push is rejected, fetch and integrate the new main and push again.
- Never call a tracker CLI or the Gitea API directly. Route every tracker command through the harness auth wrapper, which selects the authenticated account with write access to this repository and overrides any stale ambient token; on Gitea, resolve the identity with \`check\` and call the API with \`GITEA_TOKEN\`:
  \`${closeCommand}\`
- When complete, close issue ${issue.number} in ${repo} with \`${closeCommand}\`. Close it only after the merge succeeded, main was pushed, and the worktree was removed. If closing fails, report that failure once as the run's blocker.
- If a hard blocker makes completion impossible (a missing prerequisite that cannot be created, an unavailable external dependency, or an operation that would destroy uncommitted user work), end the run and report the exact blocker once on a line beginning \`DEVBOARD-BLOCKED:\`. Do not ask for permission or guidance.`;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(`implement-goal-issue: ${message}`, type);
  } catch {
    // Notification is best-effort; the command still returns its result.
  }
}

function fail(ctx: ExtensionCommandContext, message: string): RunResult {
  notify(ctx, message, "error");
  try {
    process.stderr.write(`implement-goal-issue: ${message}\n`);
  } catch {
    // A closed stderr must not change the command's outcome.
  }
  return { ok: false, message };
}

export async function runImplementGoalIssue(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args = "",
  authExec: Exec = execWithEnvironment,
  giteaFetch?: FetchLike,
): Promise<RunResult> {
  const requested = args.trim();
  if (requested.length === 0) {
    return fail(ctx, "needs exactly one goal issue number: /implement-goal-issue <number>");
  }
  if (!/^\d+$/.test(requested)) {
    return fail(ctx, `refuses "${requested}": the argument must be one issue number`);
  }
  const number = Number(requested);

  const top = await run(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
  if (top.code !== 0) {
    return fail(ctx, `not a git repository: ${firstLine(top.stderr) || "git rev-parse failed"}`);
  }
  const repo = top.stdout.trim();

  const goalMode = goalModeFromBranch(ctx.sessionManager.getBranch());
  if (goalMode) {
    return fail(ctx, `a goal is already ${goalMode}; finish or drop it before implementing another goal`);
  }

  const origin = await run(pi, "git", ["remote", "get-url", "origin"], repo);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    return fail(ctx, "origin remote is not configured; a goal issue cannot be implemented");
  }
  const remote = parseForgeRemote(origin.stdout, process.env);
  if (remote === undefined) {
    return fail(ctx, `cannot parse origin remote: ${origin.stdout.trim()}`);
  }

  const info = await detectForge(remote, repo, authExec, giteaFetch);
  if (isFailure(info)) return fail(ctx, info.error);

  const fetched = await fetchGoalIssue(pi, info, number, repo, giteaFetch);
  if (isFailure(fetched)) return fail(ctx, fetched.error);
  const issue = fetched;
  if (!issue.labels.includes(GOAL_LABEL)) {
    return fail(
      ctx,
      `issue ${number} does not carry the exact "${GOAL_LABEL}" label; refusing before creating a worktree`,
    );
  }
  if (issue.body.trim().length === 0) {
    return fail(ctx, `issue ${number} has no body to use as the goal objective`);
  }

  const slug = `goal-${number}-${slugify(issue.title)}`;
  const planned = await planWorktree(pi, repo, slug);
  if (isFailure(planned)) return fail(ctx, planned.error);
  const worktree = await createWorktree(pi, repo, planned.path, planned.branch);
  if (isFailure(worktree)) return fail(ctx, worktree.error);

  const active = pi.getActiveTools();
  try {
    await pi.setActiveTools([...active, "goal"]);
  } catch (error) {
    return fail(
      ctx,
      `could not activate the goal tool: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const goalAvailable =
    pi.getActiveTools().includes("goal") && pi.getAllTools().some((tool) => tool.name === "goal");
  if (!goalAvailable) return fail(ctx, "goal mode is unavailable; enable goal.enabled in omp settings");

  await ctx.waitForIdle?.();

  const prompt = buildGoalIssuePrompt(
    issue,
    repo,
    worktree.path,
    worktree.branch,
    info.forge,
    info.project,
    forgeAuthCommand(repo, info),
  );
  try {
    pi.sendUserMessage(prompt);
  } catch (error) {
    return fail(
      ctx,
      `could not send the goal prompt: ${error instanceof Error ? error.message : String(error)}. ` +
        `Worktree ${worktree.path} was created.`,
    );
  }

  notify(ctx, `queued goal for ${issue.url}; worktree ${worktree.path} on ${worktree.branch}`, "info");
  return {
    ok: true,
    message: `queued goal for ${issue.url}`,
    issue,
    objective: issue.body,
    worktree: worktree.path,
    branch: worktree.branch,
    prompt,
  };
}

export default function implementGoalIssueExtension(pi: ExtensionAPI): void {
  pi.registerCommand("implement-goal-issue", {
    description: "Implement one open issue carrying the exact goal label",
    handler: async (args, ctx) => {
      try {
        await runImplementGoalIssue(pi, ctx, args);
      } catch (error) {
        const message = `unexpected failure: ${
          error instanceof Error ? error.message : String(error)
        }`;
        notify(ctx, message, "error");
        try {
          process.stderr.write(`implement-goal-issue: ${message}\n`);
        } catch {
          // A closed stderr must not change the command's outcome.
        }
      }
    },
  });
}

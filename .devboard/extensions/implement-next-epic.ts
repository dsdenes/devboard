/**
 * `/implement-next-epic [ref]` — read one open epic created by `/epic-next`
 * and start it as an omp goal in the current session.
 *
 * The server gives every implementation lane exactly one epic reference, so a
 * lane never selects a different epic. With no reference the command accepts
 * the single open epic and refuses (listing the URLs) when several are open.
 *
 * Goal mode's `goal` tool is not part of the default tool set. A file-based
 * slash command cannot add it, so this command is registered by a small
 * project-local extension instead: it selects the epic, prepares the
 * worktree, activates the `goal` tool, and hands the objective to the model
 * with an instruction to create the goal before implementing.
 *
 * Harness rules: this file lives under `.devboard/`; the only host-side file
 * is the thin wrapper at `.omp/extensions/implement-next-epic.ts`.
 */

import { resolve } from "node:path";

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

export interface RemoteInfo {
  host: string;
  project: string;
  forge: "github" | "gitlab";
}

export interface EpicSummary {
  ref: number;
  title: string;
  url: string;
}

export interface Epic extends EpicSummary {
  body: string;
}

export interface RunResult {
  ok: boolean;
  message: string;
  epic?: Epic;
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

/**
 * Detect an existing goal from the session's persisted mode changes.
 *
 * Active tools are not goal state: `goal` is an ordinary active tool whenever
 * goal mode is enabled, even when no goal exists. The newest `mode_change` on
 * the active branch is authoritative — `goal`/`goal_paused` with a goal record
 * means a goal exists; `none` (or no mode change) means none.
 */
export function goalModeFromBranch(
  entries: readonly ModeChangeEntry[],
): "active" | "paused" | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "mode_change") continue;
    if (entry.mode !== "goal" && entry.mode !== "goal_paused") return null;
    if (!entry.data?.goal) return null;
    return entry.mode === "goal_paused" ? "paused" : "active";
  }
  return null;
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

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

function parseJsonArray(stdout: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
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

/**
 * Parse the three remote shapes accepted by `/epic-next`:
 * `https://host/path`, `ssh://user@host[:port]/path`, `user@host:path`.
 */
export function parseRemote(url: string): { host: string; project: string } | null {
  const value = url.trim();
  if (!value) return null;

  let host = "";
  let project = "";

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      project = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (!scp) return null;
    host = scp[1];
    project = scp[2];
  }

  project = project
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  if (!host || !project) return null;
  return { host, project };
}

export async function detectForge(
  pi: ExtensionAPI,
  remote: { host: string; project: string },
  cwd: string,
): Promise<Outcome<RemoteInfo>> {
  const host = remote.host;
  const lower = host.toLowerCase();

  if (host === "github.com") {
    const result = await run(pi, "gh", ["auth", "status", "--hostname", host], cwd);
    if (result.code !== 0) {
      return {
        error: `gh is unavailable or unauthenticated for ${host}: ${firstLine(result.stderr) || "no authenticated account"}`,
      };
    }
    return { ...remote, forge: "github" };
  }

  if (lower === "gitlab.com" || lower.includes("gitlab")) {
    const result = await run(pi, "glab", ["auth", "status", "--hostname", host], cwd);
    if (result.code !== 0) {
      return {
        error: `glab is unavailable or unauthenticated for ${host}: ${firstLine(result.stderr) || "no authenticated account"}`,
      };
    }
    return { ...remote, forge: "gitlab" };
  }

  // Self-hosted: use whichever forge CLI is configured for this exact host.
  // Both configured means the forge cannot be told apart → halt.
  const gh = await run(pi, "gh", ["auth", "status", "--hostname", host], cwd);
  const glab = await run(pi, "glab", ["auth", "status", "--hostname", host], cwd);
  if (gh.code === 0 && glab.code !== 0) return { ...remote, forge: "github" };
  if (glab.code === 0 && gh.code !== 0) return { ...remote, forge: "gitlab" };
  return {
    error:
      gh.code === 0
        ? `both gh and glab are configured for ${host}; cannot tell which forge serves the remote`
        : `no authenticated gh or glab account for ${host}`,
  };
}

function normalizeSummary(forge: "github" | "gitlab", raw: unknown): EpicSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const ref = forge === "github" ? record.number : (record.iid ?? record.number);
  const url = forge === "github" ? record.url : (record.web_url ?? record.url);
  const title = record.title;
  if (typeof ref !== "number" || typeof title !== "string" || typeof url !== "string") {
    return null;
  }
  return { ref, title, url };
}

export async function listOpenEpics(
  pi: ExtensionAPI,
  info: RemoteInfo,
  cwd: string,
): Promise<Outcome<{ epics: EpicSummary[]; matchedByLabel: boolean }>> {
  if (info.forge === "github") {
    const labelsResult = await run(
      pi,
      "gh",
      ["label", "list", "--search", "epic", "--limit", "100", "--json", "name"],
      cwd,
    );
    if (labelsResult.code !== 0) {
      return { error: `gh label list failed: ${firstLine(labelsResult.stderr) || "unknown error"}` };
    }
    const labels = parseJsonArray(labelsResult.stdout);
    if (!labels) return { error: "gh label list returned invalid JSON" };
    const label = labels.find((raw) => {
      if (typeof raw !== "object" || raw === null) return false;
      const name = (raw as Record<string, unknown>).name;
      return typeof name === "string" && name.toLowerCase() === "epic";
    }) as { name: string } | undefined;

    const result = label
      ? await run(
          pi,
          "gh",
          [
            "issue",
            "list",
            "--label",
            label.name,
            "--state",
            "open",
            "--json",
            "number,title,url",
            "--limit",
            "100",
          ],
          cwd,
        )
      : await run(
          pi,
          "gh",
          [
            "search",
            "issues",
            "--repo",
            info.project,
            "--match",
            "body",
            "--state",
            "open",
            "devboard-epic",
            "--json",
            "number,title,url",
            "--limit",
            "100",
          ],
          cwd,
        );
    if (result.code !== 0) {
      return { error: `gh issue listing failed: ${firstLine(result.stderr) || "unknown error"}` };
    }
    const rows = parseJsonArray(result.stdout);
    if (!rows) return { error: "gh issue listing returned invalid JSON" };
    return {
      epics: rows.map((row) => normalizeSummary("github", row)).filter((row): row is EpicSummary => row !== null),
      matchedByLabel: Boolean(label),
    };
  }

  const labelsResult = await run(pi, "glab", ["label", "list", "--output", "json"], cwd);
  if (labelsResult.code !== 0) {
    return { error: `glab label list failed: ${firstLine(labelsResult.stderr) || "unknown error"}` };
  }
  const labels = parseJsonArray(labelsResult.stdout);
  if (!labels) return { error: "glab label list returned invalid JSON" };
  const label = labels.find((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const name = (raw as Record<string, unknown>).name;
    return typeof name === "string" && name.toLowerCase() === "epic";
  }) as { name: string } | undefined;

  const result = label
    ? await run(pi, "glab", ["issue", "list", "--label", label.name, "--output", "json"], cwd)
    : await run(
        pi,
        "glab",
        [
          "issue",
          "list",
          "--search",
          "devboard-epic",
          "--in",
          "description",
          "--output",
          "json",
        ],
        cwd,
      );
  if (result.code !== 0) {
    return { error: `glab issue listing failed: ${firstLine(result.stderr) || "unknown error"}` };
  }
  const rows = parseJsonArray(result.stdout);
  if (!rows) return { error: "glab issue listing returned invalid JSON" };
  return {
    epics: rows.map((row) => normalizeSummary("gitlab", row)).filter((row): row is EpicSummary => row !== null),
    matchedByLabel: Boolean(label),
  };
}

export async function fetchEpic(
  pi: ExtensionAPI,
  info: RemoteInfo,
  ref: number,
  cwd: string,
): Promise<Outcome<Epic>> {
  const result =
    info.forge === "github"
      ? await run(
          pi,
          "gh",
          ["issue", "view", String(ref), "--json", "number,title,body,url"],
          cwd,
        )
      : await run(pi, "glab", ["issue", "view", String(ref), "--output", "json"], cwd);

  if (result.code !== 0) {
    return {
      error: `${info.forge} issue view failed: ${firstLine(result.stderr) || "unknown error"}`,
    };
  }

  const raw = parseJsonObject(result.stdout);
  if (!raw) return { error: `${info.forge} issue view returned invalid JSON` };

  const summary = normalizeSummary(info.forge, raw);
  const body = info.forge === "github" ? raw.body : (raw.description ?? raw.body);
  if (!summary || typeof body !== "string") {
    return { error: `${info.forge} issue view returned an unexpected shape` };
  }
  return { ...summary, body };
}

const REQUIRED_SECTIONS = [
  "Objective",
  "Success criteria",
  "Verification",
  "Boundaries",
] as const;

/**
 * Keep the epic's title and the sections a goal needs to execute and verify.
 * The tracker marker and other HTML comments are dropped. When the body has
 * none of the expected sections, keep the whole (comment-stripped) body.
 */
export function distillObjective(title: string, body: string): string {
  const clean = body.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = clean.split("\n");
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1].trim();
      current =
        REQUIRED_SECTIONS.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? null;
      if (current) sections[current] = [];
      continue;
    }
    if (current) sections[current]?.push(line);
  }

  const parts: string[] = [title.trim()];
  for (const section of REQUIRED_SECTIONS) {
    const content = sections[section]?.join("\n").trim();
    if (content) parts.push(`## ${section}\n${content}`);
  }

  if (parts.length === 1) {
    const fallback = clean.trim();
    if (fallback) parts.push(fallback);
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

export function slugify(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const slug = words.join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "epic";
}

export async function planWorktree(
  pi: ExtensionAPI,
  repo: string,
  slug: string,
): Promise<Outcome<{ path: string; branch: string }>> {
  const worktrees = await run(pi, "git", ["worktree", "list", "--porcelain"], repo);
  if (worktrees.code !== 0) {
    return { error: `git worktree list failed: ${firstLine(worktrees.stderr) || "unknown error"}` };
  }
  const existingPaths = new Set(
    worktrees.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim()),
  );

  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? slug : `${slug}-${index}`;
    const path = resolve(repo, ".worktree", candidate);
    const branch = `devboard/${candidate}`;
    if (existingPaths.has(path)) continue;
    const branchExists = await run(
      pi,
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
    );
    if (branchExists.code === 0) continue;
    return { path, branch };
  }

  return { error: `no free worktree name for slug "${slug}"` };
}

export async function createWorktree(
  pi: ExtensionAPI,
  repo: string,
  path: string,
  branch: string,
): Promise<Outcome<{ path: string; branch: string }>> {
  const main = await run(pi, "git", ["rev-parse", "--verify", "main"], repo);
  if (main.code !== 0) {
    return { error: "main branch not found; cannot create the epic worktree" };
  }
  const result = await run(
    pi,
    "git",
    ["worktree", "add", path, "-b", branch, "main"],
    repo,
  );
  if (result.code !== 0) {
    return {
      error: `git worktree add failed: ${firstLine(result.stderr) || firstLine(result.stdout) || "unknown error"}`,
    };
  }
  return { path, branch };
}

export function buildGoalPrompt(
  epic: Epic,
  objective: string,
  repo: string,
  worktree: string,
  branch: string,
  forge: RemoteInfo["forge"],
): string {
  return `Implement the next epic from the tracker. This run is fully autonomous.

Autonomy contract:
- Do not ask the user anything. Never call the \`ask\` tool.
- Do not wait for confirmation, approval, sign-off, or review. Never request permission to proceed.
- Do not stop for a plan, a choice, or a progress check. Never offer the user options.
- Decide from the epic, the repository, its tests, its documentation, and its ADRs. Where those are silent, choose the smallest reversible option, record the assumption in the final report, and continue.
- Continue until every success criterion is verified, the branch is merged, the worktree is removed, and the epic is closed.

Epic: ${epic.title}
URL: ${epic.url}
Repository: ${repo}
Worktree: ${worktree}
Branch: ${branch}

Before doing any work:
1. Call the \`goal\` tool with {"op":"get"}.
2. If it returns any goal (active, paused, budget-limited, complete, or dropped), end the run immediately with that conflict as the result. Do not drop, resume, or replace it, and do not ask the user what to do.
3. Otherwise call the \`goal\` tool with {"op":"create","objective": <the objective below>}. Pass the objective exactly as written.

Objective:
<<<OBJECTIVE
${objective}
OBJECTIVE>>>

After the goal tool succeeds, implement the epic end to end:
- Work only inside the worktree path above. Never edit, write, or run mutating commands in ${repo}; that checkout is for the final merge only.
- Use absolute paths under the worktree for every tool, and pass the worktree as \`cwd\` to \`bash\`.
- Read the epic URL for the full body, including any detail omitted from the objective.
- Follow every success criterion and verification scenario. Perform each check through the product's user-visible surface in the worktree, observe the actual result, and use the repository's documented build and test commands only as supporting evidence.
- Never end a turn while a background job you started is still running: when a \`wait\` returns a
  still-running snapshot, call \`wait\` again. Leave the turn only once the work is finished or
  the exact blocker is known.
- Keep the goal active until every criterion is verified. Call the \`goal\` tool with {"op":"complete"} only then.
- When complete, merge ${branch} into main from ${repo}. First fetch the latest main and integrate
  it into ${branch}; then merge. If the merge fails, fetch the latest main again, integrate it,
  and retry. Never force-push. After the merge succeeds, push main to origin and remove the
  worktree and branch, per AGENTS.md. If the push is rejected, fetch and integrate the new main
  and push again.
- When complete, close the epic issue ${epic.ref} in ${repo}: ${forge === "github" ? `\`gh issue close ${epic.ref}\`` : `\`glab issue close ${epic.ref}\``}. Close it only after the merge succeeded, main was pushed, and the worktree was removed. If closing fails, report that failure once as the run's blocker.
- If a hard blocker makes completion impossible (a missing prerequisite that cannot be created, an unavailable external dependency, or an operation that would destroy uncommitted user work), end the run and report the exact blocker once on a line beginning \`DEVBOARD-BLOCKED:\`. Do not ask for permission or guidance.`;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(`implement-next-epic: ${message}`, type);
  } catch {
    // Notification is best-effort; the command still returns its result.
  }
}

async function fail(
  ctx: ExtensionCommandContext,
  message: string,
): Promise<RunResult> {
  notify(ctx, message, "error");
  return { ok: false, message };
}

export async function runImplementNextEpic(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args = "",
): Promise<RunResult> {
  const requested = args.trim();
  if (requested.length > 0 && !/^\d+$/.test(requested)) {
    return fail(
      ctx,
      "takes an optional epic reference; with no reference it implements the single open epic",
    );
  }
  const reference = requested.length > 0 ? Number(requested) : undefined;

  const top = await run(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
  if (top.code !== 0) {
    return fail(ctx, `not a git repository: ${firstLine(top.stderr) || "git rev-parse failed"}`);
  }
  const repo = top.stdout.trim();

  const goalMode = goalModeFromBranch(ctx.sessionManager.getBranch());
  if (goalMode) {
    return fail(
      ctx,
      `a goal is already ${goalMode}; finish or drop it before starting another epic`,
    );
  }

  const origin = await run(pi, "git", ["remote", "get-url", "origin"], repo);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    return fail(ctx, "origin remote is not configured; /epic-next cannot have filed an epic");
  }

  const remote = parseRemote(origin.stdout);
  if (!remote) {
    return fail(ctx, `cannot parse origin remote: ${origin.stdout.trim()}`);
  }

  const info = await detectForge(pi, remote, repo);
  if (isFailure(info)) return fail(ctx, info.error);

  const listed = await listOpenEpics(pi, info, repo);
  if (isFailure(listed)) return fail(ctx, listed.error);

  let epics = listed.epics;
  if (!listed.matchedByLabel) {
    // The marker search is a candidate fetch; confirm the marker in the body.
    const confirmed: EpicSummary[] = [];
    for (const candidate of epics) {
      const full = await fetchEpic(pi, info, candidate.ref, repo);
      if (isFailure(full)) return fail(ctx, full.error);
      if (full.body.includes("<!-- devboard-epic -->")) confirmed.push(candidate);
    }
    epics = confirmed;
  }

  if (epics.length === 0) {
    return fail(ctx, "no open epic found; run /epic-next first");
  }

  let selected: EpicSummary | undefined;
  if (reference !== undefined) {
    selected = epics.find((epic) => epic.ref === reference);
    if (selected === undefined) {
      return fail(
        ctx,
        `epic ${reference} is not open, found ${epics.length}:\n${epics
          .map((epic) => `${epic.url}`)
          .join("\n")}`,
      );
    }
  } else {
    if (epics.length > 1) {
      return fail(
        ctx,
        `expected exactly one open epic, found ${epics.length}:\n${epics
          .map((epic) => `${epic.url}`)
          .join("\n")}`,
      );
    }
    selected = epics[0];
  }
  if (selected === undefined) {
    return fail(ctx, "no open epic found; run /epic-next first");
  }

  const fetched = await fetchEpic(pi, info, selected.ref, repo);
  if (isFailure(fetched)) return fail(ctx, fetched.error);
  const epic = fetched;

  const objective = distillObjective(epic.title, epic.body);
  if (!objective) {
    return fail(ctx, `epic ${epic.url} has no objective text`);
  }

  const slug = slugify(epic.title);
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
  if (!goalAvailable) {
    return fail(ctx, "goal mode is unavailable; enable goal.enabled in omp settings");
  }

  await ctx.waitForIdle?.();

  const prompt = buildGoalPrompt(epic, objective, repo, worktree.path, worktree.branch, info.forge);
  try {
    pi.sendUserMessage(prompt);
  } catch (error) {
    return fail(
      ctx,
      `could not send the goal prompt: ${error instanceof Error ? error.message : String(error)}. Worktree ${worktree.path} was created.`,
    );
  }

  notify(
    ctx,
    `queued goal for ${epic.url}; worktree ${worktree.path} on ${worktree.branch}`,
    "info",
  );
  return {
    ok: true,
    message: `queued goal for ${epic.url}`,
    epic,
    objective,
    worktree: worktree.path,
    branch: worktree.branch,
    prompt,
  };
}

export default function implementNextEpicExtension(pi: ExtensionAPI): void {
  pi.registerCommand("implement-next-epic", {
    description:
      "Implement the open epic given by reference, or the single open epic created by /epic-next",
    handler: async (args, ctx) => {
      try {
        await runImplementNextEpic(pi, ctx, args);
      } catch (error) {
        notify(
          ctx,
          `unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

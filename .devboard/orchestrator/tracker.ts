import type { OrchestratorIssue } from "./state";

/**
 * The tracker read. Plain CLI polling of the paginated GitHub issues endpoint:
 * no model, no agent, and no dashboard process is involved. Only open issues
 * are read, and pull requests are excluded because GitHub's issue endpoint
 * returns them alongside issues.
 */

export type IssueTracker = () => Promise<OrchestratorIssue[]>;

export interface GhOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TrackerOptions {
  repository: string;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => GhOutcome | Promise<GhOutcome>;
}

const QUERY =
  ".[] | select(.pull_request == null) | " +
  "{number, title, url: .html_url, createdAt: .created_at}";

async function gh(argv: string[]): Promise<GhOutcome> {
  try {
    const child = Bun.spawn({
      cmd: ["gh", ...argv],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    });
    // `gh` is polled while an agent may be streaming; draining both pipes
    // before awaiting the exit keeps a large answer from stalling the poll.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function isIssue(value: unknown): value is OrchestratorIssue {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.number === "number" &&
    Number.isInteger(issue.number) &&
    typeof issue.title === "string" &&
    typeof issue.url === "string" &&
    typeof issue.createdAt === "string"
  );
}

/**
 * `gh api --jq` prints one compact JSON value per line, page by page, so the
 * whole backlog streams in without buffering every page as one document.
 */
export function parseIssueLines(stdout: string): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`the tracker printed a line that is not JSON: ${trimmed.slice(0, 200)}`);
    }
    if (!isIssue(parsed)) throw new Error("the tracker printed an issue of an unexpected shape");
    issues.push(parsed);
  }
  const seen = new Set<number>();
  return issues
    .filter((issue) => {
      if (seen.has(issue.number)) return false;
      seen.add(issue.number);
      return true;
    })
    .sort((left, right) => left.number - right.number);
}

/** Lists every open non-pull-request issue, oldest number first. */
export async function listOpenIssues(options: TrackerOptions): Promise<OrchestratorIssue[]> {
  const execute = options.run ?? gh;
  const outcome = await execute([
    "api",
    "--paginate",
    `repos/${options.repository}/issues?state=open&per_page=100`,
    "--jq",
    QUERY,
  ]);
  if (outcome.code !== 0) {
    const detail =
      outcome.stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? `gh exited with code ${outcome.code}`;
    throw new Error(`could not list open issues: ${detail}`);
  }
  return parseIssueLines(outcome.stdout);
}

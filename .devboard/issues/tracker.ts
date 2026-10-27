import type { IssuesIssue } from "./state";

/**
 * The tracker read: the origin's open issues through the operator's `gh`
 * credential, every poll conditional on the ETag the previous response named.
 * Pull requests are excluded because GitHub's issue endpoint returns them
 * alongside issues. No model, agent, or webhook is involved.
 */

export interface GhOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TrackerOptions {
  repository: string;
  etag?: string | null;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => GhOutcome | Promise<GhOutcome>;
  environment?: Record<string, string | undefined>;
}

export type PollResult =
  | { kind: "issues"; issues: IssuesIssue[]; etag: string | null }
  | { kind: "not-modified"; etag: string | null }
  | { kind: "rate-limited"; until: string; detail: string }
  | { kind: "error"; detail: string };

const QUERY =
  ".[] | select(.pull_request == null) | " +
  "{number, title, url: .html_url, createdAt: .created_at, labels: [.labels[].name]}";

async function gh(argv: string[], environment?: Record<string, string | undefined>): Promise<GhOutcome> {
  try {
    const child = Bun.spawn({
      cmd: ["gh", ...argv],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(environment ?? process.env),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    });
    // Drain both pipes before the exit: a large answer must not stall the poll.
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

function isIssue(value: unknown): value is IssuesIssue {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.number === "number" &&
    Number.isInteger(issue.number) &&
    typeof issue.title === "string" &&
    typeof issue.url === "string" &&
    typeof issue.createdAt === "string" &&
    (issue.labels === undefined ||
      (Array.isArray(issue.labels) && issue.labels.every((label) => typeof label === "string")))
  );
}

function withLabels(issue: IssuesIssue): IssuesIssue {
  return { ...issue, labels: Array.isArray(issue.labels) ? [...issue.labels] : [] };
}

function parseLines(lines: string[]): IssuesIssue[] {
  const issues: IssuesIssue[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`the tracker printed a line that is not JSON: ${trimmed.slice(0, 200)}`);
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!isIssue(entry)) throw new Error("the tracker printed an issue of an unexpected shape");
      issues.push(withLabels(entry));
    }
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

interface ParsedResponse {
  blocks: Array<{ status: number; headers: Map<string, string>; body: string[] }>;
}

/**
 * Splits `gh api --include` output into status blocks. With `--paginate` one
 * block precedes each page; every page contributes issue lines.
 */
export function parseResponse(text: string): ParsedResponse {
  const blocks: ParsedResponse["blocks"] = [];
  let current: { status: number; headers: Map<string, string>; body: string[] } | undefined;
  let inHeaders = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const status = /^HTTP\/\S+\s+(\d{3})/.exec(line);
    if (status !== null) {
      current = { status: Number(status[1]), headers: new Map(), body: [] };
      blocks.push(current);
      inHeaders = true;
      continue;
    }
    if (current === undefined) continue;
    if (inHeaders) {
      if (line.trim().length === 0) {
        inHeaders = false;
        continue;
      }
      const split = line.indexOf(":");
      if (split > 0) {
        current.headers.set(line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim());
      }
      continue;
    }
    current.body.push(line);
  }
  return { blocks };
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function rateLimitUntil(headers: Map<string, string>, now: Date): string {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(now.getTime() + seconds * 1000).toISOString();
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== undefined) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  }
  return new Date(now.getTime() + 60_000).toISOString();
}

/** One conditional poll of the origin's open, non-pull-request issues. */
export async function pollOpenIssues(options: TrackerOptions): Promise<PollResult> {
  const execute = options.run ?? ((argv: string[]) => gh(argv, options.environment));
  const argv = [
    "api",
    "--include",
    "--paginate",
    ...(options.etag === null || options.etag === undefined
      ? []
      : ["-H", `If-None-Match: ${options.etag}`]),
    `repos/${options.repository}/issues?state=open&per_page=100`,
    "--jq",
    QUERY,
  ];
  const outcome = await execute(argv);
  const parsed = parseResponse(outcome.stdout);
  // If-None-Match applies to the first page, so its ETag is the one to reuse.
  const etag =
    parsed.blocks[0]?.headers.get("etag") ?? options.etag ?? null;

  const notModified = parsed.blocks.some((block) => block.status === 304);
  if (notModified) return { kind: "not-modified", etag };

  const limited = parsed.blocks.find((block) => block.status === 403 || block.status === 429);
  if (limited !== undefined) {
    const detail =
      firstLine(outcome.stderr) ??
      firstLine(limited.body.join("\n")) ??
      `gh exited with code ${outcome.code}`;
    return { kind: "rate-limited", until: rateLimitUntil(limited.headers, new Date()), detail };
  }

  if (outcome.code !== 0) {
    return {
      kind: "error",
      detail:
        firstLine(outcome.stderr) ??
        firstLine(parsed.blocks.flatMap((block) => block.body).join("\n")) ??
        `gh exited with code ${outcome.code}`,
    };
  }

  const body = parsed.blocks.flatMap((block) => block.body);
  try {
    return { kind: "issues", issues: parseLines(body), etag };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

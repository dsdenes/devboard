import type { Subprocess } from "bun";
import type { IssuesIssue } from "./state";
import { configuredGiteaToken, type Forge } from "../lib/forge";
import {
  GiteaError,
  giteaIssue,
  giteaListIssues,
  type FetchLike,
} from "../lib/gitea";

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
  /** Whole-read deadline in milliseconds; defaults to `TRACKER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Aborting kills the in-flight `gh` child and reports an error result. */
  signal?: AbortSignal;
  /** The origin forge; defaults to GitHub for backward compatibility. */
  forge?: Forge;
  /** Gitea HTTP origin. */
  baseUrl?: string;
  /** Injected transport for the Gitea API. */
  giteaFetch?: FetchLike;
}

export type PollResult =
  | { kind: "issues"; issues: IssuesIssue[]; etag: string | null }
  | { kind: "not-modified"; etag: string | null }
  | { kind: "rate-limited"; until: string; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "unsupported"; detail: string };

/**
 * The named answer for a forge the tracker never reads. The Open issues view
 * has a GitHub and a Gitea branch only, so a GitLab origin must not fall
 * through to a `gh` read of the same-named GitHub repository.
 */
export const GITLAB_TRACKER_UNSUPPORTED =
  "the issues tracker reads GitHub and Gitea origins; a GitLab origin is not supported";

const QUERY =
  ".[] | select(.pull_request == null) | " +
  "{number, title, url: .html_url, createdAt: .created_at, labels: [.labels[].name]}";

/** Default wall-clock bound for one tracker read, including the `gh` child. */
export const TRACKER_TIMEOUT_MS = 20_000;

/**
 * A tracker read that ran past its deadline. The read left its state untouched,
 * so the next poll may run it again.
 */
export class TrackerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the tracker did not answer within ${timeoutMs} ms`);
    this.name = "TrackerTimeoutError";
  }
}

/** The error an aborted read should surface; the controller carries the cause. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("the tracker read was aborted");
}

/** Rejects with the read's abort reason as soon as its controller aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  const aborted = Promise.withResolvers<never>();
  if (signal.aborted) {
    aborted.reject(abortReason(signal));
  } else {
    signal.addEventListener("abort", () => aborted.reject(abortReason(signal)), { once: true });
  }
  return aborted.promise;
}

/** Kills a tracker child; a child that already exited is not an error. */
function terminate(child: Pick<Subprocess, "kill">): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // It exited between the abort and the signal.
  }
}

interface Deadline {
  signal: AbortSignal;
  /** Races one read against the deadline; an abandoned read cannot reject unhandled. */
  read<T>(work: () => Promise<T>): Promise<T>;
  dispose(): void;
}

/**
 * One read's deadline. The timer aborts the controller, `gh` kills its child on
 * that signal, and an injected runner that ignores it still loses the race.
 */
function deadline(timeoutMs: number, signal?: AbortSignal): Deadline {
  const bound = Math.max(1, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TrackerTimeoutError(bound)), bound);
  const forward = () => {
    if (signal !== undefined) controller.abort(abortReason(signal));
  };
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    read<T>(work: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(abortReason(controller.signal));
      const started = work();
      void started.catch(() => undefined);
      const aborted = whenAborted(controller.signal);
      void aborted.catch(() => undefined);
      return Promise.race([started, aborted]);
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

async function gh(
  argv: string[],
  environment?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<GhOutcome> {
  if (signal?.aborted) return { code: 1, stdout: "", stderr: abortReason(signal).message };
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
    const kill = () => terminate(child);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      const aborted = signal === undefined ? undefined : whenAborted(signal);
      if (aborted !== undefined) void aborted.catch(() => undefined);
      // Drain both pipes before the exit: a large answer must not stall the poll.
      const [stdout, stderr, code] = await Promise.race([
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
        ...(aborted === undefined ? [] : [aborted]),
      ]);
      return { code, stdout, stderr };
    } finally {
      signal?.removeEventListener("abort", kill);
    }
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

async function pollGiteaIssues(options: TrackerOptions): Promise<PollResult> {
  const environment = options.environment ?? process.env;
  if (options.baseUrl === undefined || options.baseUrl.length === 0) {
    return {
      kind: "error",
      detail: "the Gitea address is not configured; set DEVBOARD_GITEA_URL",
    };
  }
  const token = configuredGiteaToken(environment);
  try {
    const issues = await giteaListIssues(
      {
        baseUrl: options.baseUrl,
        project: options.repository,
        ...(token === undefined ? {} : { token }),
      },
      "open",
      options.giteaFetch,
    );
    return {
      kind: "issues",
      issues: issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        labels: issue.labels,
      })),
      etag: options.etag ?? null,
    };
  } catch (error) {
    if (error instanceof GiteaError && (error.status === 403 || error.status === 429)) {
      return {
        kind: "rate-limited",
        until: new Date(Date.now() + 60_000).toISOString(),
        detail: error.message,
      };
    }
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type IssueStateResult =
  | { kind: "state"; state: "open" | "closed" }
  | { kind: "error"; detail: string };

/**
 * The tracker's current state for one issue. An unreadable answer is an
 * error, never a success: a 404 can mean lost access as easily as a missing
 * issue, and only a proven `closed` may mark a run handled.
 */
export async function fetchIssueState(
  options: TrackerOptions,
  number: number,
): Promise<IssueStateResult> {
  const forge = options.forge ?? "github";
  if (forge === "gitea") return await giteaIssueState(options, number);
  if (forge !== "github") return { kind: "error", detail: GITLAB_TRACKER_UNSUPPORTED };
  const bound = deadline(options.timeoutMs ?? TRACKER_TIMEOUT_MS, options.signal);
  const execute = options.run ?? ((argv: string[]) => gh(argv, options.environment, bound.signal));
  try {
    const outcome = await bound.read(() =>
      Promise.resolve(
        execute(["api", `repos/${options.repository}/issues/${number}`, "--jq", ".state"]),
      ),
    );
    if (outcome.code !== 0) {
      return {
        kind: "error",
        detail: firstLine(outcome.stderr) ?? `gh exited with code ${outcome.code}`,
      };
    }
    const state = outcome.stdout.trim();
    if (state === "open" || state === "closed") return { kind: "state", state };
    return {
      kind: "error",
      detail: `the tracker returned an unexpected issue state: ${state.slice(0, 100)}`,
    };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    bound.dispose();
  }
}

async function giteaIssueState(
  options: TrackerOptions,
  number: number,
): Promise<IssueStateResult> {
  const environment = options.environment ?? process.env;
  if (options.baseUrl === undefined || options.baseUrl.length === 0) {
    return {
      kind: "error",
      detail: "the Gitea address is not configured; set DEVBOARD_GITEA_URL",
    };
  }
  const token = configuredGiteaToken(environment);
  try {
    const issue = await giteaIssue(
      {
        baseUrl: options.baseUrl,
        project: options.repository,
        ...(token === undefined ? {} : { token }),
      },
      number,
      options.giteaFetch,
    );
    return { kind: "state", state: issue.state };
  } catch (error) {
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One conditional poll of the origin's open, non-pull-request issues. */
export async function pollOpenIssues(options: TrackerOptions): Promise<PollResult> {
  const forge = options.forge ?? "github";
  if (forge === "gitea") return await pollGiteaIssues(options);
  if (forge !== "github") return { kind: "unsupported", detail: GITLAB_TRACKER_UNSUPPORTED };
  const bound = deadline(options.timeoutMs ?? TRACKER_TIMEOUT_MS, options.signal);
  const execute = options.run ?? ((argv: string[]) => gh(argv, options.environment, bound.signal));
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
  try {
    const outcome = await bound.read(() => Promise.resolve(execute(argv)));
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
    return { kind: "issues", issues: parseLines(body), etag };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    bound.dispose();
  }
}

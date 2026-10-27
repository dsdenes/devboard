import { git } from "../repository";
import type { GhRunner } from "./actions";
import { ghCommand } from "./preflight";

/**
 * The GitHub facts Auto Scout reads: every `scout` issue in any state, every
 * published release, and the commit that closed an issue. Reads go through the
 * operator's `gh` credential; commit resolution also uses the checkout, and
 * release containment prefers the checkout's tags before asking GitHub.
 */

export interface ScoutGitHubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
}

export interface ScoutRelease {
  tag: string;
  /** ISO publication time; only published releases are listed. */
  publishedAt: string;
}

export interface ScoutGitHubClient {
  /** Every issue carrying the `scout` label, open or closed. */
  listIssues(): Promise<ScoutGitHubIssue[]>;
  /** Every open issue title in the repository, scout or not. */
  listOpenIssueTitles(): Promise<string[]>;
  /** Every published release, drafts excluded. */
  listReleases(): Promise<ScoutRelease[]>;
  /** The commit that closed an issue, from its timeline or newest comment. */
  closingCommit(issueNumber: number): Promise<string | null>;
  /** One unambiguous full commit, through the checkout or GitHub, or null. */
  resolveCommit(short: string): Promise<string | null>;
  /** The published release tags whose history contains `commit`. */
  containingReleaseTags(commit: string, releases: ScoutRelease[]): Promise<string[]>;
}

const SHA = /^[0-9a-fA-F]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_TOKEN = /\b[0-9a-fA-F]{7,40}\b/g;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

/** Every 7–40 character hex token in a comment, in the order it appears. */
export function shaTokens(text: string): string[] {
  return [...text.matchAll(SHA_TOKEN)].map((match) => match[0]);
}

/** The newest comment that carries a SHA yields its last SHA; else null. */
export function closingCommitFromComments(comments: string[]): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const tokens = shaTokens(comments[index] ?? "");
    if (tokens.length > 0) return tokens[tokens.length - 1]!;
  }
  return null;
}

/**
 * The timeline's closing commit when GitHub reports one. The newest closing
 * event wins, because a reopened and re-closed issue has several.
 */
export function closingCommitFromTimeline(
  events: Array<{ event?: unknown; commit_id?: unknown }>,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.event !== "closed") continue;
    if (isSha(event.commit_id)) return event.commit_id;
  }
  return null;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/** Parses a JSON array `gh` printed, refusing a shape it does not know. */
export function parseJsonArray(text: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parses one JSON object per line, as `gh api --jq` emits it. */
export function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // A line that is not JSON is not part of the contract.
    }
  }
  return values;
}

/**
 * The earliest published release whose tag is in `tags`, ordered by
 * publication time and breaking a tie by tag name.
 */
export function earliestRelease(releases: ScoutRelease[], tags: string[]): string | null {
  const contained = new Set(tags);
  const candidates = releases.filter((release) => contained.has(release.tag));
  candidates.sort((left, right) => {
    const leftAt = Date.parse(left.publishedAt);
    const rightAt = Date.parse(right.publishedAt);
    const leftValid = Number.isFinite(leftAt);
    const rightValid = Number.isFinite(rightAt);
    if (leftValid && rightValid && leftAt !== rightAt) return leftAt - rightAt;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0;
  });
  return candidates[0]?.tag ?? null;
}

/**
 * The release that shipped the issue's closing commit: the timeline's commit
 * when present, otherwise the newest comment's SHA, resolved to one full
 * commit, then matched against the earliest published release containing it.
 */
export async function shippedVersion(
  issue: ScoutGitHubIssue,
  client: ScoutGitHubClient,
  releases: ScoutRelease[],
): Promise<string | null> {
  if (issue.state !== "closed") return null;
  try {
    const candidate = await client.closingCommit(issue.number);
    if (candidate === null) return null;
    const commit = await client.resolveCommit(candidate);
    if (commit === null) return null;
    const tags = await client.containingReleaseTags(commit, releases);
    return earliestRelease(releases, tags);
  } catch {
    // Resolution is retried on the next periodic read.
    return null;
  }
}

export interface ScoutGitHubOptions {
  /** The host origin's `owner/name`. */
  repository: string;
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /** Injectable forge command; defaults to the operator's `gh`. */
  run?: GhRunner;
}

export function createScoutGitHub(options: ScoutGitHubOptions): ScoutGitHubClient {
  const repository = options.repository;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.environment ?? process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  const run = options.run ?? ((argv, env) => ghCommand(argv, env));

  async function read(argv: string[]): Promise<string> {
    const result = await run(argv, environment);
    if (result.code !== 0) throw new Error(firstLine(result.stderr));
    return result.stdout;
  }

  async function api(endpoint: string, jq: string): Promise<string> {
    return await read(["api", `repos/${repository}/${endpoint}`, "--paginate", "--jq", jq]);
  }

  return {
    async listIssues(): Promise<ScoutGitHubIssue[]> {
      const text = await read([
        "issue",
        "list",
        "--repo",
        repository,
        "--label",
        "scout",
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,url,state,createdAt,body",
      ]);
      const entries = parseJsonArray(text);
      if (entries === undefined) throw new Error("gh issue list did not print a JSON array");
      const issues: ScoutGitHubIssue[] = [];
      const seen = new Set<number>();
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (
          typeof record.number !== "number" ||
          !Number.isInteger(record.number) ||
          typeof record.title !== "string" ||
          typeof record.url !== "string" ||
          typeof record.createdAt !== "string" ||
          typeof record.body !== "string" ||
          typeof record.state !== "string"
        ) {
          continue;
        }
        if (seen.has(record.number)) continue;
        seen.add(record.number);
        const state = record.state.toLowerCase() === "closed" ? "closed" : "open";
        issues.push({
          number: record.number,
          title: record.title,
          url: record.url,
          state,
          createdAt: record.createdAt,
          body: record.body,
        });
      }
      return issues;
    },

    async listOpenIssueTitles(): Promise<string[]> {
      const text = await read([
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "title",
      ]);
      const entries = parseJsonArray(text);
      if (entries === undefined) throw new Error("gh issue list did not print a JSON array");
      const titles: string[] = [];
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const title = (entry as Record<string, unknown>).title;
        if (typeof title === "string") titles.push(title);
      }
      return titles;
    },

    async listReleases(): Promise<ScoutRelease[]> {
      const text = await read([
        "api",
        `repos/${repository}/releases`,
        "--paginate",
        "--jq",
        ".[] | {tag: .tag_name, publishedAt: .published_at, draft: .draft}",
      ]);
      const releases: ScoutRelease[] = [];
      for (const entry of parseJsonLines(text)) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.tag !== "string" || record.tag.length === 0) continue;
        if (record.draft === true) continue;
        if (typeof record.publishedAt !== "string" || record.publishedAt.length === 0) continue;
        releases.push({ tag: record.tag, publishedAt: record.publishedAt });
      }
      return releases;
    },

    async closingCommit(issueNumber: number): Promise<string | null> {
      let timelineFailure: string | null = null;
      try {
        const text = await api(
          `issues/${issueNumber}/timeline`,
          '.[] | select(.event == "closed" and .commit_id != null) | .commit_id',
        );
        const commits = text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => isSha(line));
        const timeline = closingCommitFromTimeline(
          commits.map((commit) => ({ event: "closed", commit_id: commit })),
        );
        if (timeline !== null) return timeline;
      } catch (error) {
        timelineFailure = error instanceof Error ? error.message : String(error);
      }

      try {
        const text = await api(`issues/${issueNumber}/comments`, ".[] | {body: .body}");
        const comments: string[] = [];
        for (const entry of parseJsonLines(text)) {
          if (typeof entry !== "object" || entry === null) continue;
          const body = (entry as Record<string, unknown>).body;
          if (typeof body === "string") comments.push(body);
        }
        return closingCommitFromComments(comments);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(timelineFailure === null ? detail : `${timelineFailure}; ${detail}`);
      }
    },

    async resolveCommit(short: string): Promise<string | null> {
      if (!isSha(short)) return null;
      const local = git(options.repoDir, "rev-parse", "--verify", "--quiet", `${short}^{commit}`);
      if (local.code === 0) {
        const sha = local.stdout.split(/\s+/)[0] ?? "";
        if (FULL_SHA.test(sha)) return sha;
      }
      const result = await run(
        ["api", `repos/${repository}/commits/${short}`, "--jq", ".sha"],
        environment,
      );
      if (result.code !== 0) return null;
      const sha = result.stdout.trim();
      return FULL_SHA.test(sha) ? sha : null;
    },

    async containingReleaseTags(commit: string, releases: ScoutRelease[]): Promise<string[]> {
      const local = git(options.repoDir, "tag", "--contains", commit);
      if (local.code === 0) {
        const tags = new Set(
          local.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
        if (tags.size > 0) {
          const contained = releases
            .filter((release) => tags.has(release.tag))
            .map((release) => release.tag);
          if (contained.length > 0) return contained;
        }
      }
      const contained: string[] = [];
      for (const release of releases) {
        const result = await run(
          [
            "api",
            `repos/${repository}/compare/${commit}...${encodeURIComponent(release.tag)}`,
            "--jq",
            ".status",
          ],
          environment,
        );
        if (result.code !== 0) continue;
        const status = result.stdout.trim();
        if (status === "ahead" || status === "identical") contained.push(release.tag);
      }
      return contained;
    },
  };
}

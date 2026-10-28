import type { GhRunner } from "./actions";
import { ghCommand } from "./preflight";
import {
  createRepositoryGitHub,
  isFullSha,
  isSha,
  shaTokens,
  type GitHubRelease,
} from "../../lib/github-release";
import { configuredGiteaToken, giteaBaseUrl, type Forge } from "../../lib/forge";
import {
  giteaJson,
  giteaListIssues,
  repoPath,
  type FetchLike,
  type GiteaTarget,
} from "../../lib/gitea";
import { git } from "../repository";

/**
 * The GitHub facts Auto Scout reads: every `scout` issue in any state, every
 * published release, and the commit that closed an issue. Reads go through the
 * operator's `gh` credential; commit resolution also uses the checkout, and
 * release containment prefers the checkout's tags before asking GitHub. The
 * release resolution itself lives in `lib/github-release.ts`, shared with the
 * watchdog activity page.
 */

export {
  closingCommitFromComments,
  closingCommitFromTimeline,
  earliestRelease,
  isSha,
  parseJsonArray,
  parseJsonLines,
  shaTokens,
  shippedVersion,
} from "../../lib/github-release";

export interface ScoutGitHubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
}

export type ScoutRelease = GitHubRelease;

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

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/** Parses a JSON array `gh` printed, refusing a shape it does not know. */
function parseIssues(text: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ScoutGitHubOptions {
  /** The host origin's `owner/name`. */
  repository: string;
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /**
   * Deadline for each command the default runner starts. The worker passes
   * its periodic read deadline so a stalled `gh` always settles.
   */
  timeoutMs?: number;
  /** Aborts the default runner's in-flight commands; ignored by an injected `run`. */
  signal?: AbortSignal;
  /** The origin forge; defaults to GitHub for backward compatibility. */
  forge?: Forge;
  /** Gitea HTTP origin. */
  baseUrl?: string;
  /** Injectable transport for the Gitea API. */
  giteaFetch?: FetchLike;
  /**
   * Injectable forge command; defaults to the operator's `gh`. An injected
   * runner owns its own deadline: `createScoutGitHub` cannot bound a promise
   * the runner never settles.
   */
  run?: GhRunner;
}

function createScoutGitea(options: ScoutGitHubOptions): ScoutGitHubClient {
  const environment = options.environment ?? process.env;
  const remote = { forge: "gitea" as const, host: "", project: options.repository };
  const baseUrl = options.baseUrl ?? giteaBaseUrl(remote, environment);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("the scout needs DEVBOARD_GITEA_URL for a Gitea origin");
  }
  const token = configuredGiteaToken(environment);
  const target: GiteaTarget = {
    baseUrl,
    project: options.repository,
    ...(token === undefined ? {} : { token }),
  };

  async function readJson(path: string): Promise<unknown> {
    return await giteaJson<unknown>(target, path, undefined, options.giteaFetch);
  }

  function releaseList(value: unknown): ScoutRelease[] {
    if (!Array.isArray(value)) return [];
    const releases: ScoutRelease[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.tag_name !== "string" || record.tag_name.length === 0) continue;
      if (record.draft === true) continue;
      const published = record.published_at;
      if (typeof published !== "string" || published.length === 0) continue;
      releases.push({ tag: record.tag_name, publishedAt: published });
    }
    return releases;
  }

  return {
    async listIssues(): Promise<ScoutGitHubIssue[]> {
      const issues = await giteaListIssues(target, "all", options.giteaFetch);
      return issues
        .filter((issue) => issue.labels.includes("scout"))
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          url: issue.url,
          state: issue.state,
          createdAt: issue.createdAt,
          body: issue.body,
        }));
    },

    async listOpenIssueTitles(): Promise<string[]> {
      const issues = await giteaListIssues(target, "open", options.giteaFetch);
      return issues.map((issue) => issue.title);
    },

    async listReleases(): Promise<ScoutRelease[]> {
      return releaseList(await readJson(`${repoPath(target)}/releases?limit=100`));
    },

    async closingCommit(issueNumber: number): Promise<string | null> {
      const timeline = await readJson(`${repoPath(target)}/issues/${issueNumber}/timeline`);
      const bodies: string[] = [];
      if (Array.isArray(timeline)) {
        for (const entry of timeline) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.commit_id === "string" && isSha(record.commit_id)) {
            return record.commit_id;
          }
          if (typeof record.body === "string") bodies.push(record.body);
        }
      }
      const comments = await readJson(`${repoPath(target)}/issues/${issueNumber}/comments`);
      if (Array.isArray(comments)) {
        for (const entry of comments) {
          if (typeof entry !== "object" || entry === null) continue;
          const body = (entry as Record<string, unknown>).body;
          if (typeof body === "string") bodies.push(body);
        }
      }
      for (let index = bodies.length - 1; index >= 0; index -= 1) {
        const tokens = shaTokens(bodies[index] ?? "");
        if (tokens.length > 0) return tokens[tokens.length - 1] ?? null;
      }
      return null;
    },

    async resolveCommit(short: string): Promise<string | null> {
      if (!isSha(short)) return null;
      const local = git(options.repoDir, "rev-parse", "--verify", "--quiet", `${short}^{commit}`);
      if (local.code === 0) {
        const sha = local.stdout.split(/\s+/)[0] ?? "";
        if (isFullSha(sha)) return sha;
      }
      const value = await readJson(`${repoPath(target)}/git/commits/${short}`);
      if (typeof value === "object" && value !== null && "sha" in value) {
        return typeof value.sha === "string" && isFullSha(value.sha) ? value.sha : null;
      }
      return null;
    },

    async containingReleaseTags(
      commit: string,
      releases: ScoutRelease[],
    ): Promise<string[]> {
      const local = git(options.repoDir, "tag", "--contains", commit);
      if (local.code === 0) {
        const tags = new Set(
          local.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
        );
        const contained = releases
          .filter((release) => tags.has(release.tag))
          .map((release) => release.tag);
        if (contained.length > 0) return contained;
      }
      const contained: string[] = [];
      for (const release of releases) {
        const value = await readJson(
          `${repoPath(target)}/compare/${commit}...${encodeURIComponent(release.tag)}`,
        );
        if (typeof value !== "object" || value === null || !("status" in value)) continue;
        if (value.status === "ahead" || value.status === "identical") {
          contained.push(release.tag);
        }
      }
      return contained;
    },
  };
}

export function createScoutGitHub(options: ScoutGitHubOptions): ScoutGitHubClient {
  if ((options.forge ?? "github") === "gitea") return createScoutGitea(options);
  const repository = options.repository;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.environment ?? process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  const run =
    options.run ??
    ((argv, env) =>
      ghCommand(argv, env, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
  const repositoryGitHub = createRepositoryGitHub({
    repository,
    repoDir: options.repoDir,
    run,
    environment,
  });

  async function read(argv: string[]): Promise<string> {
    const result = await run(argv, environment);
    if (result.code !== 0) throw new Error(firstLine(result.stderr));
    return result.stdout;
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
      const entries = parseIssues(text);
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
      const entries = parseIssues(text);
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
      return await repositoryGitHub.listReleases();
    },

    async closingCommit(issueNumber: number): Promise<string | null> {
      return await repositoryGitHub.closingCommit(issueNumber);
    },

    async resolveCommit(short: string): Promise<string | null> {
      return await repositoryGitHub.resolveCommit(short);
    },

    async containingReleaseTags(
      commit: string,
      releases: ScoutRelease[],
    ): Promise<string[]> {
      return await repositoryGitHub.containingReleaseTags(commit, releases);
    },
  };
}

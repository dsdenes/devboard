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
  giteaListIssues,
  giteaListReleases,
  type FetchLike,
  type GiteaTarget,
} from "../../lib/gitea";
import { createGiteaVersionClient } from "../../lib/gitea-release";

/**
 * The GitHub facts Auto Scout reads: every `scout` issue in any state, every
 * published release, and the commit that closed an issue. Reads go through the
 * operator's `gh` credential; commit resolution also uses the checkout, and
 * release containment prefers the checkout's tags before asking the forge. The
 * release resolution itself lives in `lib/github-release.ts` and
 * `lib/gitea-release.ts`, shared with the watchdog activity page.
 */

export {
  closingCommitFromComments,
  closingCommitFromTimeline,
  earliestRelease,
  isSha,
  parseJsonArray,
  parseJsonLines,
  releaseAtClose,
  resolveShippedVersion,
  shaTokens,
  shippedVersion,
  type VersionResolution,
} from "../../lib/github-release";

export interface ScoutGitHubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  /** When the issue was closed, or null while it is open. */
  closedAt: string | null;
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
  /** Every candidate for that commit, newest first, for verification. */
  closingCommits?(issueNumber: number): Promise<string[]>;
  /** The checkout's own commits whose landed subject ends with `(#<number>)`. */
  landedCommits?(issueNumber: number): string[];
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

export interface GhRunner {
  (argv: string[], environment: Record<string, string>): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
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

  const version = createGiteaVersionClient(target, options.repoDir, options.giteaFetch);

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
          closedAt: issue.closedAt,
          body: issue.body,
        }));
    },

    async listOpenIssueTitles(): Promise<string[]> {
      const issues = await giteaListIssues(target, "open", options.giteaFetch);
      return issues.map((issue) => issue.title);
    },

    async listReleases(): Promise<ScoutRelease[]> {
      return await giteaListReleases(target, options.giteaFetch);
    },

    closingCommit: (issueNumber) => version.closingCommit(issueNumber),

    closingCommits: (issueNumber) => version.closingCommits(issueNumber),

    landedCommits: (issueNumber) => version.landedCommits(issueNumber),

    resolveCommit: (short) => version.resolveCommit(short),

    containingReleaseTags: (commit, releases) =>
      version.containingReleaseTags(commit, releases),
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
        "number,title,url,state,createdAt,closedAt,body",
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
          closedAt:
            typeof record.closedAt === "string" && record.closedAt.length > 0
              ? record.closedAt
              : null,
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

    async closingCommits(issueNumber: number): Promise<string[]> {
      return await repositoryGitHub.closingCommits(issueNumber);
    },

    landedCommits: (issueNumber) => repositoryGitHub.landedCommits(issueNumber),

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

import {
  createRepositoryGitHub,
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
import { ghCommand } from "../scout/preflight";
import { DEAD_CODE_LABEL } from "./paths";

/**
 * The forge facts Dead Code reads: every `dead-code` issue in any state, every
 * published release, and the commit that closed an issue. It is the agent's
 * own reader so the Auto Scout and Design System clients keep their labels.
 */

export interface DeadCodeForgeIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  /** When the issue was closed, or null while it is open. */
  closedAt: string | null;
  body: string;
}

export type DeadCodeRelease = GitHubRelease;

export interface DeadCodeForgeClient {
  listIssues(): Promise<DeadCodeForgeIssue[]>;
  listOpenIssueTitles(): Promise<string[]>;
  listReleases(): Promise<DeadCodeRelease[]>;
  closingCommit(issueNumber: number): Promise<string | null>;
  /** Every candidate for that commit, newest first, for verification. */
  closingCommits?(issueNumber: number): Promise<string[]>;
  /** The checkout's own commits whose landed subject ends with `(#<number>)`. */
  landedCommits?(issueNumber: number): string[];
  resolveCommit(short: string): Promise<string | null>;
  containingReleaseTags(commit: string, releases: DeadCodeRelease[]): Promise<string[]>;
}

export interface DeadCodeForgeOptions {
  repository: string;
  repoDir: string;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  forge?: Forge;
  baseUrl?: string;
  giteaFetch?: FetchLike;
  run?: (
    argv: string[],
    environment: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

const RATE_LIMIT_PATTERNS = [
  "rate limit exceeded",
  "secondary rate limit",
  "abuse detection",
  "too many requests",
  "http 429",
];

export function isForgeRateLimited(text: string): boolean {
  const message = text.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => message.includes(pattern));
}

function parseIssues(text: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createDeadCodeGitea(options: DeadCodeForgeOptions): DeadCodeForgeClient {
  const environment = options.environment ?? process.env;
  const remote = { forge: "gitea" as const, host: "", project: options.repository };
  const baseUrl = options.baseUrl ?? giteaBaseUrl(remote, environment);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("the dead-code agent needs DEVBOARD_GITEA_URL for a Gitea origin");
  }
  const token = configuredGiteaToken(environment);
  const target: GiteaTarget = {
    baseUrl,
    project: options.repository,
    ...(token === undefined ? {} : { token }),
  };

  const version = createGiteaVersionClient(target, options.repoDir, options.giteaFetch);

  return {
    async listIssues(): Promise<DeadCodeForgeIssue[]> {
      const issues = await giteaListIssues(target, "all", options.giteaFetch);
      return issues
        .filter((issue) => issue.labels.includes(DEAD_CODE_LABEL))
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
    async listReleases(): Promise<DeadCodeRelease[]> {
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

export function createDeadCodeForge(options: DeadCodeForgeOptions): DeadCodeForgeClient {
  if ((options.forge ?? "github") === "gitea") return createDeadCodeGitea(options);
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
    async listIssues(): Promise<DeadCodeForgeIssue[]> {
      const text = await read([
        "issue",
        "list",
        "--repo",
        repository,
        "--label",
        DEAD_CODE_LABEL,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,url,state,createdAt,closedAt,body",
      ]);
      const entries = parseIssues(text);
      if (entries === undefined) throw new Error("gh issue list did not print a JSON array");
      const issues: DeadCodeForgeIssue[] = [];
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
        issues.push({
          number: record.number,
          title: record.title,
          url: record.url,
          state: record.state.toLowerCase() === "closed" ? "closed" : "open",
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
    listReleases: () => repositoryGitHub.listReleases(),
    closingCommit: (issueNumber) => repositoryGitHub.closingCommit(issueNumber),
    closingCommits: (issueNumber) => repositoryGitHub.closingCommits(issueNumber),
    landedCommits: (issueNumber) => repositoryGitHub.landedCommits(issueNumber),
    resolveCommit: (short) => repositoryGitHub.resolveCommit(short),
    containingReleaseTags: (commit, releases) =>
      repositoryGitHub.containingReleaseTags(commit, releases),
  };
}

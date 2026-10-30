import {
  createRepositoryGitHub,
  isFullSha,
  isSha,
  type GitHubRelease,
} from "../../lib/github-release";
import { configuredGiteaToken, giteaBaseUrl, type Forge } from "../../lib/forge";
import {
  giteaClosingCommit,
  giteaJson,
  giteaListIssues,
  giteaListReleases,
  repoPath,
  type FetchLike,
  type GiteaTarget,
} from "../../lib/gitea";
import { git } from "../repository";
import { ghCommand } from "../scout/preflight";
import { DESIGN_LABEL } from "./paths";

/**
 * The forge facts Design System reads: every `design` issue in any state,
 * every published release, and the commit that closed an issue. It is the
 * design agent's own reader so the Auto Scout client keeps its scout label.
 */

export interface DesignForgeIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
}

export type DesignRelease = GitHubRelease;

export interface DesignForgeClient {
  listIssues(): Promise<DesignForgeIssue[]>;
  listOpenIssueTitles(): Promise<string[]>;
  listReleases(): Promise<DesignRelease[]>;
  closingCommit(issueNumber: number): Promise<string | null>;
  resolveCommit(short: string): Promise<string | null>;
  containingReleaseTags(commit: string, releases: DesignRelease[]): Promise<string[]>;
}

export interface DesignForgeOptions {
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

function createDesignGitea(options: DesignForgeOptions): DesignForgeClient {
  const environment = options.environment ?? process.env;
  const remote = { forge: "gitea" as const, host: "", project: options.repository };
  const baseUrl = options.baseUrl ?? giteaBaseUrl(remote, environment);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("the design agent needs DEVBOARD_GITEA_URL for a Gitea origin");
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

  return {
    async listIssues(): Promise<DesignForgeIssue[]> {
      const issues = await giteaListIssues(target, "all", options.giteaFetch);
      return issues
        .filter((issue) => issue.labels.includes(DESIGN_LABEL))
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
    async listReleases(): Promise<DesignRelease[]> {
      return await giteaListReleases(target, options.giteaFetch);
    },
    async closingCommit(issueNumber: number): Promise<string | null> {
      return await giteaClosingCommit(target, issueNumber, options.giteaFetch);
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
    async containingReleaseTags(commit: string, releases: DesignRelease[]): Promise<string[]> {
      const local = git(options.repoDir, "tag", "--contains", commit);
      if (local.code === 0) {
        const tags = new Set(local.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
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
        if (value.status === "ahead" || value.status === "identical") contained.push(release.tag);
      }
      return contained;
    },
  };
}

export function createDesignForge(options: DesignForgeOptions): DesignForgeClient {
  if ((options.forge ?? "github") === "gitea") return createDesignGitea(options);
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
    async listIssues(): Promise<DesignForgeIssue[]> {
      const text = await read([
        "issue",
        "list",
        "--repo",
        repository,
        "--label",
        DESIGN_LABEL,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,url,state,createdAt,body",
      ]);
      const entries = parseIssues(text);
      if (entries === undefined) throw new Error("gh issue list did not print a JSON array");
      const issues: DesignForgeIssue[] = [];
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
    resolveCommit: (short) => repositoryGitHub.resolveCommit(short),
    containingReleaseTags: (commit, releases) =>
      repositoryGitHub.containingReleaseTags(commit, releases),
  };
}

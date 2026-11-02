import { configuredGiteaToken, giteaBaseUrl, type Forge } from "../../lib/forge";
import {
  giteaListIssues,
  type FetchLike,
  type GiteaTarget,
} from "../../lib/gitea";
import { ghCommand } from "../scout/preflight";
import { API_STANDARDS_LABEL } from "./paths";

/**
 * The forge facts API Standards reads before a turn: every `api-standards`
 * issue in any state, and every open issue title in the repository. It is the
 * agent's own reader, so the Auto Scout client keeps its scout label and the
 * Design System client keeps `design`.
 */

export interface ApiStandardsForgeIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
}

export interface ApiStandardsForgeClient {
  listIssues(): Promise<ApiStandardsForgeIssue[]>;
  listOpenIssueTitles(): Promise<string[]>;
}

export interface ApiStandardsForgeOptions {
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

function createApiStandardsGitea(options: ApiStandardsForgeOptions): ApiStandardsForgeClient {
  const environment = options.environment ?? process.env;
  const remote = { forge: "gitea" as const, host: "", project: options.repository };
  const baseUrl = options.baseUrl ?? giteaBaseUrl(remote, environment);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("the API Standards agent needs DEVBOARD_GITEA_URL for a Gitea origin");
  }
  const token = configuredGiteaToken(environment);
  const target: GiteaTarget = {
    baseUrl,
    project: options.repository,
    ...(token === undefined ? {} : { token }),
  };
  return {
    async listIssues(): Promise<ApiStandardsForgeIssue[]> {
      const issues = await giteaListIssues(target, "all", options.giteaFetch);
      return issues
        .filter((issue) => issue.labels.includes(API_STANDARDS_LABEL))
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
  };
}

export function createApiStandardsForge(
  options: ApiStandardsForgeOptions,
): ApiStandardsForgeClient {
  if ((options.forge ?? "github") === "gitea") return createApiStandardsGitea(options);
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

  async function read(argv: string[]): Promise<string> {
    const result = await run(argv, environment);
    if (result.code !== 0) throw new Error(firstLine(result.stderr));
    return result.stdout;
  }

  return {
    async listIssues(): Promise<ApiStandardsForgeIssue[]> {
      const text = await read([
        "issue",
        "list",
        "--repo",
        repository,
        "--label",
        API_STANDARDS_LABEL,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,url,state,createdAt,body",
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("gh issue list did not print a JSON array");
      }
      if (!Array.isArray(parsed)) throw new Error("gh issue list did not print a JSON array");
      const issues: ApiStandardsForgeIssue[] = [];
      const seen = new Set<number>();
      for (const entry of parsed) {
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("gh issue list did not print a JSON array");
      }
      if (!Array.isArray(parsed)) throw new Error("gh issue list did not print a JSON array");
      const titles: string[] = [];
      for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) continue;
        const title = (entry as Record<string, unknown>).title;
        if (typeof title === "string") titles.push(title);
      }
      return titles;
    },
  };
}

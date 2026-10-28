import type { GhRunner } from "./actions";
import { ghCommand } from "./preflight";
import {
  createRepositoryGitHub,
  type GitHubRelease,
} from "../../lib/github-release";

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

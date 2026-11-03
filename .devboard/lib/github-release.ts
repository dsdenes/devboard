import { git } from "../issues/repository";
import { commitCandidatesFromComments, isFullSha, isSha } from "./commit";
import { landedCommits, localReleaseContainment } from "./release-containment";
import type { PublishedRelease } from "./release-resolution";

export {
  closingCommitFromComments,
  isFullSha,
  isSha,
  shaTokens,
} from "./commit";

/**
 * GitHub's release transport: binds the credential environment, runs `gh`,
 * paginates its output, and parses the forge's JSON into release facts. The
 * policy that decides which release shipped an issue lives in
 * `release-resolution.ts`, so a change to GitHub's API and a change to the
 * resolution rules are separate reasons to edit.
 */

export interface GitHubCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitHubCommandRunner = (
  argv: string[],
  environment: Record<string, string>,
) => Promise<GitHubCommandOutcome>;

export interface RepositoryGitHubOptions {
  /** `owner/name` on github.com. */
  repository: string;
  /** The checkout used to resolve a short commit and contain release tags. */
  repoDir: string;
  /** The forge command, already bound to its credential. */
  run: GitHubCommandRunner;
  environment?: Record<string, string | undefined>;
}

export interface RepositoryGitHub {
  /** Every published release, drafts excluded. */
  listReleases(): Promise<PublishedRelease[]>;
  /** The issue's state and both timestamps, as GitHub reports them. */
  issueTimes(issueNumber: number): Promise<{
    state: "open" | "closed";
    createdAt: string | null;
    closedAt: string | null;
  }>;
  /** The commit that closed an issue, from its timeline or newest comment. */
  closingCommit(issueNumber: number): Promise<string | null>;
  /** Every candidate for that commit, newest first, for verification. */
  closingCommits(issueNumber: number): Promise<string[]>;
  /** The checkout's own commits whose landed subject ends with `(#<number>)`. */
  landedCommits(issueNumber: number): string[];
  /**
   * One unambiguous full commit, through the checkout or GitHub; null only
   * when GitHub reports no such commit, never when the read itself failed.
   */
  resolveCommit(short: string): Promise<string | null>;
  /** The published release tags whose history contains `commit`. */
  containingReleaseTags(commit: string, releases: PublishedRelease[]): Promise<string[]>;
}

/**
 * The HTTP status `gh` names in the diagnostic of a failed request, when that
 * status says the commit does not exist. Every other failure is distinct from
 * an absent commit.
 */
const MISSING_COMMIT_STATUS = /\bHTTP\s*:?\s*\(?(?:404|422)\b/i;

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

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/**
 * One repository's GitHub reads. Every request carries the repository, so a
 * surface that watches several repositories owns one reader per repository.
 */
export function createRepositoryGitHub(options: RepositoryGitHubOptions): RepositoryGitHub {
  const repository = options.repository;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.environment ?? process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  const run = options.run;

  async function read(argv: string[]): Promise<string> {
    const result = await run(argv, environment);
    if (result.code !== 0) throw new Error(firstLine(result.stderr));
    return result.stdout;
  }

  async function api(endpoint: string, jq: string): Promise<string> {
    return await read(["api", `repos/${repository}/${endpoint}`, "--paginate", "--jq", jq]);
  }

  /**
   * The timeline's closing commit when GitHub reports one, otherwise every hex
   * token of the newest comment, most recent first. A later comment's
   * fingerprint or epoch stamp is not a commit, so the resolver verifies each
   * candidate before it reports a version.
   */
  async function closingCommits(issueNumber: number): Promise<string[]> {
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
      if (timeline !== null) return [timeline];
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
      return commitCandidatesFromComments(comments);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(timelineFailure === null ? detail : `${timelineFailure}; ${detail}`);
    }
  }

  return {
    async listReleases(): Promise<PublishedRelease[]> {
      const text = await read([
        "api",
        `repos/${repository}/releases`,
        "--paginate",
        "--jq",
        ".[] | {tag: .tag_name, publishedAt: .published_at, draft: .draft}",
      ]);
      const releases: PublishedRelease[] = [];
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

    async issueTimes(issueNumber: number): Promise<{
      state: "open" | "closed";
      createdAt: string | null;
      closedAt: string | null;
    }> {
      const text = await read([
        "api",
        `repos/${repository}/issues/${issueNumber}`,
        "--jq",
        '[.state, .created_at, .closed_at] | @tsv',
      ]);
      const [reported, created, closed] = text.trim().split("\t");
      const state = (reported ?? "").toLowerCase();
      if (state !== "open" && state !== "closed") {
        throw new Error(`gh reported an unknown issue state for ${repository}#${issueNumber}`);
      }
      return {
        state,
        createdAt:
          created !== undefined && created.length > 0 && created !== "null" ? created : null,
        closedAt:
          closed !== undefined && closed.length > 0 && closed !== "null" ? closed : null,
      };
    },

    async closingCommit(issueNumber: number): Promise<string | null> {
      return (await closingCommits(issueNumber))[0] ?? null;
    },

    closingCommits,

    landedCommits: (issueNumber) => landedCommits(options.repoDir, issueNumber),

    async resolveCommit(short: string): Promise<string | null> {
      if (!isSha(short)) return null;
      const local = git(options.repoDir, "rev-parse", "--verify", "--quiet", `${short}^{commit}`);
      if (local.code === 0) {
        const sha = local.stdout.split(/\s+/)[0] ?? "";
        if (isFullSha(sha)) return sha;
      }
      const result = await run(
        ["api", `repos/${repository}/commits/${short}`, "--jq", ".sha"],
        environment,
      );
      if (result.code !== 0) {
        // `gh` prints `<message> (HTTP <status>)`. A 404 or 422 means GitHub
        // has no such commit, so the candidate is skipped and the next one is
        // tried; every other failure — a rate limit, a 5xx, an expired
        // credential — is a failed read. Reporting that as "no such commit"
        // would let the release-timeline fallback persist a fabricated shipped
        // version, so it is thrown and the resolver records the reason, the
        // same way the Gitea client answers.
        if (MISSING_COMMIT_STATUS.test(result.stderr)) return null;
        throw new Error(firstLine(result.stderr));
      }
      const sha = result.stdout.trim();
      if (isFullSha(sha)) return sha;
      throw new Error(`gh did not name a commit for ${short}`);
    },

    async containingReleaseTags(commit: string, releases: PublishedRelease[]): Promise<string[]> {
      const local = localReleaseContainment(options.repoDir, commit, releases);
      if (local.pending.length === 0) return local.contained;
      const contained = [...local.contained];
      for (const release of local.pending) {
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

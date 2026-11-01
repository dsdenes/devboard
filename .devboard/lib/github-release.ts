import { git } from "../issues/repository";
import { commitCandidatesFromComments, isFullSha, isSha } from "./commit";
import { localReleaseContainment } from "./release-containment";

export {
  closingCommitFromComments,
  isFullSha,
  isSha,
  shaTokens,
} from "./commit";

/**
 * GitHub release resolution shared by Auto Scout and the watchdog activity
 * page. One repository-scoped reader lists published releases, finds the
 * commit that closed an issue, and answers which release shipped it. Both
 * surfaces call this module, so a change to the rules changes both at once.
 */

export interface GitHubRelease {
  tag: string;
  /** ISO publication time; only published releases are listed. */
  publishedAt: string;
}

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
  listReleases(): Promise<GitHubRelease[]>;
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
  /** One unambiguous full commit, through the checkout or GitHub, or null. */
  resolveCommit(short: string): Promise<string | null>;
  /** The published release tags whose history contains `commit`. */
  containingReleaseTags(commit: string, releases: GitHubRelease[]): Promise<string[]>;
}

const SHA = /^[0-9a-fA-F]{7,40}$/;

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

/**
 * The earliest published release whose tag is in `tags`, ordered by
 * publication time and breaking a tie by tag name.
 */
export function earliestRelease(releases: GitHubRelease[], tags: string[]): string | null {
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

export interface ClosingCommitIssue {
  number: number;
  state: "open" | "closed";
  /** When the issue was filed, ISO 8601; a release older than it cannot hold the fix. */
  createdAt?: string | null;
  /** When the issue was closed, ISO 8601; the anchor of the release-timeline fallback. */
  closedAt?: string | null;
}

export interface ClosingCommitClient {
  closingCommit(issueNumber: number): Promise<string | null>;
  /**
   * Every candidate for the closing commit, newest first. A reader that can
   * name several supplies this so one unresolvable token does not hide the
   * real commit; a client without it is asked for the single closing commit.
   */
  closingCommits?(issueNumber: number): Promise<string[]>;
  resolveCommit(short: string): Promise<string | null>;
  containingReleaseTags(commit: string, releases: GitHubRelease[]): Promise<string[]>;
}

/** The shipped release and, when there is none, why the resolution failed. */
export interface VersionResolution {
  version: string | null;
  /** Why `version` is null; null when the issue is open or the version shipped. */
  error: string | null;
  /** True when no commit named the fix and `version` came from the release timeline. */
  inferred: boolean;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function closingCandidates(
  client: ClosingCommitClient,
  issueNumber: number,
): Promise<string[]> {
  if (client.closingCommits !== undefined) {
    return await client.closingCommits(issueNumber);
  }
  const single = await client.closingCommit(issueNumber);
  return single === null ? [] : [single];
}

/**
 * The release closest to the issue's close, for a forge that records no
 * closing commit at all. The harness publishes a release before it closes the
 * issue that release fixed, so the newest release published at or before the
 * close is the answer; a release published after the close wins only when none
 * precedes it. A release published before the issue was filed cannot contain
 * its fix and is never a candidate, so a bulk-imported issue closed with its
 * own creation time resolves to the release that followed it, if any.
 */
export function releaseAtClose(
  releases: GitHubRelease[],
  issue: { createdAt?: string | null; closedAt?: string | null },
): string | null {
  const closed = instant(issue.closedAt);
  if (closed === null) return null;
  const filed = instant(issue.createdAt);
  const candidates: Array<{ tag: string; at: number }> = [];
  for (const release of releases) {
    const at = instant(release.publishedAt);
    if (at === null) continue;
    if (filed !== null && at < filed) continue;
    candidates.push({ tag: release.tag, at });
  }
  candidates.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.tag === right.tag) return 0;
    return left.tag < right.tag ? -1 : 1;
  });
  const preceding = candidates.filter((candidate) => candidate.at <= closed).at(-1);
  return preceding?.tag ?? candidates[0]?.tag ?? null;
}

/**
 * The release that shipped the issue's closing commit: the timeline's commit
 * when present, otherwise the commit candidates of the newest comments, each
 * resolved to one full commit before it is matched against the earliest
 * published release containing it. A candidate that does not resolve is
 * skipped rather than ending the search, because comment prose carries
 * fingerprints, process ids, and epoch stamps that look like a SHA. A forge
 * that records no closing commit at all — the harness closes its own issues
 * through the API — falls back to the release published closest to the close.
 * Every failure is reported rather than thrown, so a caller can record why a
 * closed issue stays unresolved.
 */
export async function resolveShippedVersion<Issue extends ClosingCommitIssue>(
  issue: Issue,
  client: ClosingCommitClient,
  releases: GitHubRelease[],
): Promise<VersionResolution> {
  if (issue.state !== "closed") return { version: null, error: null, inferred: false };
  const nearest = releaseAtClose(releases, issue);
  const withoutCommit = (error: string): VersionResolution =>
    nearest === null
      ? { version: null, error, inferred: false }
      : { version: nearest, error: null, inferred: true };
  try {
    const candidates = await closingCandidates(client, issue.number);
    if (candidates.length === 0) return withoutCommit("no closing commit was found");
    let error = `closing commit ${candidates[0]} could not be resolved`;
    let resolved: string | null = null;
    for (const candidate of candidates) {
      const commit = await client.resolveCommit(candidate);
      if (commit === null) continue;
      resolved = commit;
      const tags = await client.containingReleaseTags(commit, releases);
      const version = earliestRelease(releases, tags);
      if (version !== null) return { version, error: null, inferred: false };
      error = `no published release contains ${commit}`;
    }
    // A candidate that resolved names the fix, so its release is the answer
    // once it publishes; only an issue that names no commit at all falls back
    // to the release timeline.
    return resolved === null
      ? withoutCommit(error)
      : { version: null, error, inferred: false };
  } catch (error) {
    return {
      version: null,
      error: error instanceof Error ? error.message : String(error),
      inferred: false,
    };
  }
}

export async function shippedVersion<Issue extends ClosingCommitIssue>(
  issue: Issue,
  client: ClosingCommitClient,
  releases: GitHubRelease[],
): Promise<string | null> {
  return (await resolveShippedVersion(issue, client, releases)).version;
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
    async listReleases(): Promise<GitHubRelease[]> {
      const text = await read([
        "api",
        `repos/${repository}/releases`,
        "--paginate",
        "--jq",
        ".[] | {tag: .tag_name, publishedAt: .published_at, draft: .draft}",
      ]);
      const releases: GitHubRelease[] = [];
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
      if (result.code !== 0) return null;
      const sha = result.stdout.trim();
      return isFullSha(sha) ? sha : null;
    },

    async containingReleaseTags(commit: string, releases: GitHubRelease[]): Promise<string[]> {
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

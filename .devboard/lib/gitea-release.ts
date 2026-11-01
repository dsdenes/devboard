import { git } from "../issues/repository";
import { isFullSha, isSha, type GitHubRelease } from "./github-release";
import {
  giteaClosingCommit,
  giteaClosingCommits,
  giteaJson,
  repoPath,
  type FetchLike,
  type GiteaTarget,
} from "./gitea";

/**
 * One Gitea repository's shipped-version facts, shared by Auto Scout, Design
 * System, and the watchdog activity page. One implementation keeps their
 * Shipped columns in agreement: the checkout's tags answer when they are
 * current, and the forge answers when they are not.
 */

export interface GiteaVersionClient {
  /** The commit that closed an issue, from its timeline or newest comment. */
  closingCommit(issueNumber: number): Promise<string | null>;
  /** Every candidate for that commit, newest first, for verification. */
  closingCommits(issueNumber: number): Promise<string[]>;
  /** One unambiguous full commit, through the checkout or the forge, or null. */
  resolveCommit(short: string): Promise<string | null>;
  /** The published release tags whose history contains `commit`. */
  containingReleaseTags(commit: string, releases: GitHubRelease[]): Promise<string[]>;
}

/**
 * True when `tag`'s history contains `commit`. Gitea's compare answers with the
 * commits `head` has and `base` lacks and reports no `status`, so the tag is
 * the base and an empty commit list is containment. The reverse order
 * (`commit...tag`) is empty both for a contained commit and for one made after
 * the tag, and cannot answer the question.
 */
export async function giteaTagContainsCommit(
  target: GiteaTarget,
  tag: string,
  commit: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const value = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/compare/${encodeURIComponent(tag)}...${commit}`,
    undefined,
    fetchImpl,
  );
  if (typeof value !== "object" || value === null) return false;
  const total = (value as Record<string, unknown>).total_commits;
  return typeof total === "number" && total === 0;
}

/**
 * The resolver every Gitea-backed surface reads. A tag already in the checkout
 * answers containment offline; a release the checkout has not fetched is
 * verified against the forge, so a host without local release tags still
 * reports the version that shipped an issue.
 */
export function createGiteaVersionClient(
  target: GiteaTarget,
  repoDir: string,
  fetchImpl: FetchLike = fetch,
): GiteaVersionClient {
  async function resolveCommit(short: string): Promise<string | null> {
    if (!isSha(short)) return null;
    const local = git(repoDir, "rev-parse", "--verify", "--quiet", `${short}^{commit}`);
    if (local.code === 0) {
      const sha = local.stdout.split(/\s+/)[0] ?? "";
      if (isFullSha(sha)) return sha;
    }
    const value = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/git/commits/${short}`,
      undefined,
      fetchImpl,
    );
    if (typeof value !== "object" || value === null || !("sha" in value)) return null;
    const sha = (value as Record<string, unknown>).sha;
    return typeof sha === "string" && isFullSha(sha) ? sha : null;
  }

  async function containingReleaseTags(
    commit: string,
    releases: GitHubRelease[],
  ): Promise<string[]> {
    const local = git(repoDir, "tag", "--contains", commit);
    if (local.code === 0) {
      const tags = new Set(local.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
      const contained = releases
        .filter((release) => tags.has(release.tag))
        .map((release) => release.tag);
      if (contained.length > 0) return contained;
    }
    const contained: string[] = [];
    for (const release of releases) {
      // One release the forge cannot compare — a deleted tag, an unreadable
      // entry — is skipped: it must not hide a later release that contains the
      // commit.
      const matched = await giteaTagContainsCommit(
        target,
        release.tag,
        commit,
        fetchImpl,
      ).catch(() => false);
      if (matched) contained.push(release.tag);
    }
    return contained;
  }

  return {
    closingCommit: (issueNumber) => giteaClosingCommit(target, issueNumber, fetchImpl),
    closingCommits: (issueNumber) => giteaClosingCommits(target, issueNumber, fetchImpl),
    resolveCommit,
    containingReleaseTags,
  };
}

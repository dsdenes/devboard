import { git } from "../issues/repository";
import { isFullSha, isSha, type GitHubRelease } from "./github-release";
import { landedCommits, localReleaseContainment } from "./release-containment";
import {
  GiteaError,
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
  /** The checkout's own commits whose landed subject ends with `(#<number>)`. */
  landedCommits(issueNumber: number): string[];
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
 * The resolver every Gitea-backed surface reads. A release tag already in the
 * checkout answers containment offline; every other release is verified
 * against the forge, so a checkout that fetched only some release tags still
 * sees every release that shipped an issue — including an earlier one whose
 * tag it never fetched.
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
    try {
      const value = await giteaJson<unknown>(
        target,
        `${repoPath(target)}/git/commits/${short}`,
        undefined,
        fetchImpl,
      );
      if (typeof value !== "object" || value === null || !("sha" in value)) return null;
      const sha = (value as Record<string, unknown>).sha;
      return typeof sha === "string" && isFullSha(sha) ? sha : null;
    } catch (error) {
      // Comment prose carries epoch stamps and fingerprints that look like a
      // SHA. A 404 means "no such commit", so the candidate is skipped and the
      // next one is tried; a failed read is still an error.
      if (error instanceof GiteaError && (error.status === 404 || error.status === 422)) {
        return null;
      }
      throw error;
    }
  }

  async function containingReleaseTags(
    commit: string,
    releases: GitHubRelease[],
  ): Promise<string[]> {
    const local = localReleaseContainment(repoDir, commit, releases);
    if (local.pending.length === 0) return local.contained;
    const contained = [...local.contained];
    for (const release of local.pending) {
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
    landedCommits: (issueNumber) => landedCommits(repoDir, issueNumber),
    resolveCommit,
    containingReleaseTags,
  };
}

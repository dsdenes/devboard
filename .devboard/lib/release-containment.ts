import { git } from "../issues/repository";
import type { GitHubRelease } from "./github-release";

/**
 * What the checkout alone can say about the published releases that contain a
 * commit. A release the checkout carries as a tag is answered offline — either
 * its history holds the commit or it does not. A checkout may carry only some
 * published release tags: one it does not carry is unanswered, not absent, and
 * `pending` is the part of the release list only the forge can answer. An empty
 * `pending` therefore means `contained` is the complete answer.
 *
 * Both release resolvers share this split, so a partially fetched tag set can
 * never make one of them report a later release than the earliest one that
 * contains the commit.
 */
export interface LocalReleaseContainment {
  /** Release tags the checkout proves contain the commit. */
  contained: string[];
  /** Releases the checkout cannot answer, in release-list order. */
  pending: GitHubRelease[];
}

function tagNames(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * Splits `releases` into the tags the checkout proves contain `commit` and the
 * releases it must ask the forge about. A release tag the checkout carries
 * answers containment: `git tag --contains` names it when the commit is in its
 * history, and its absence from that list means it is not. A tag the checkout
 * does not carry, or a checkout where git cannot answer, stays pending.
 */
export function localReleaseContainment(
  repoDir: string,
  commit: string,
  releases: GitHubRelease[],
): LocalReleaseContainment {
  const listed = git(repoDir, "tag", "--list");
  const containing = git(repoDir, "tag", "--contains", commit);
  const present = listed.code === 0 ? tagNames(listed.stdout) : new Set<string>();
  const named = containing.code === 0 ? tagNames(containing.stdout) : null;
  const contained: string[] = [];
  const pending: GitHubRelease[] = [];
  for (const release of releases) {
    if (!present.has(release.tag) || named === null) pending.push(release);
    else if (named.has(release.tag)) contained.push(release.tag);
  }
  return { contained, pending };
}

import { git } from "../issues/repository";
import { COMMIT_CANDIDATE_LIMIT, isFullSha } from "./commit";
import type { PublishedRelease } from "./release-resolution";

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
  pending: PublishedRelease[];
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
 * The landed commits that name an issue, newest first. The harness ends the
 * subject of the commit that lands a fix with `(#<number>)`, so the checkout's
 * own history answers which commit shipped the work even when the forge records
 * no closing commit and no comment carries a SHA. Only `HEAD`'s history is read:
 * a commit on an unlanded branch is not shipped. The list is bounded like the
 * forge's candidates, so one issue never turns into an unbounded history walk.
 */
export function landedCommits(repoDir: string, issueNumber: number): string[] {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return [];
  const marker = `(#${issueNumber})`;
  const result = git(repoDir, "log", "HEAD", "--format=%H%x09%s");
  if (result.code !== 0) return [];
  const commits: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const sha = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    if (!isFullSha(sha) || !subject.endsWith(marker)) continue;
    commits.push(sha);
    if (commits.length >= COMMIT_CANDIDATE_LIMIT) break;
  }
  return commits;
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
  releases: PublishedRelease[],
): LocalReleaseContainment {
  const listed = git(repoDir, "tag", "--list");
  const containing = git(repoDir, "tag", "--contains", commit);
  const present = listed.code === 0 ? tagNames(listed.stdout) : new Set<string>();
  const named = containing.code === 0 ? tagNames(containing.stdout) : null;
  const contained: string[] = [];
  const pending: PublishedRelease[] = [];
  for (const release of releases) {
    if (!present.has(release.tag) || named === null) pending.push(release);
    else if (named.has(release.tag)) contained.push(release.tag);
  }
  return { contained, pending };
}

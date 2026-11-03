/**
 * Forge-neutral release resolution shared by Auto Scout, Design System, Dead
 * Code, and the watchdog activity page. It answers which published release
 * shipped an issue from the facts a reader supplies: the issue's own state and
 * timestamps, the commits that claim to close it, and the releases a forge
 * published. It names no forge, builds no argv, and runs no command, so the
 * GitHub and Gitea readers both resolve shipped versions through it.
 */

export interface PublishedRelease {
  tag: string;
  /** ISO publication time; only published releases are listed. */
  publishedAt: string;
}

/**
 * The earliest published release whose tag is in `tags`, ordered by
 * publication time and breaking a tie by tag name.
 */
export function earliestRelease(releases: PublishedRelease[], tags: string[]): string | null {
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
  /**
   * The checkout's own commits whose landed subject ends with `(#<number>)`,
   * newest first. A client that can read the checkout supplies this so the
   * exact landed commit outranks a forge that recorded no closing reference.
   */
  landedCommits?(issueNumber: number): string[];
  /**
   * The one full commit a candidate names. Null means the forge reports no
   * such commit, so the candidate is skipped; a failed read throws, so the
   * resolver reports it instead of inferring a release from the timeline.
   */
  resolveCommit(short: string): Promise<string | null>;
  containingReleaseTags(commit: string, releases: PublishedRelease[]): Promise<string[]>;
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
  releases: PublishedRelease[],
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
 * The version that shipped an issue named by a landed commit. The checkout is
 * authoritative when it carries a commit whose subject ends with `(#<number>)`:
 * the harness writes that reference on the commit that lands a fix, so the
 * earliest published release containing any such commit is the exact answer
 * even when the forge recorded no closing commit and no comment carries a SHA.
 * Null means the checkout names none, so the forge's own candidates answer
 * instead; a landed commit no release contains yet stays unresolved rather
 * than falling back to an approximation.
 */
async function landedShippedVersion(
  issueNumber: number,
  client: ClosingCommitClient,
  releases: PublishedRelease[],
): Promise<VersionResolution | null> {
  if (client.landedCommits === undefined) return null;
  const candidates = client.landedCommits(issueNumber);
  if (candidates.length === 0) return null;
  const tags = new Set<string>();
  let resolved: string | null = null;
  for (const candidate of candidates) {
    const commit = await client.resolveCommit(candidate);
    if (commit === null) continue;
    resolved ??= commit;
    for (const tag of await client.containingReleaseTags(commit, releases)) tags.add(tag);
  }
  if (resolved === null) return null;
  const version = earliestRelease(releases, [...tags]);
  return version === null
    ? { version: null, error: `no published release contains ${resolved}`, inferred: false }
    : { version, error: null, inferred: false };
}

/**
 * The release that shipped the issue's closing commit: the timeline's commit
 * when present, otherwise the commit candidates of the newest comments, each
 * resolved to one full commit before it is matched against the earliest
 * published release containing it. A candidate that does not resolve is
 * skipped rather than ending the search, because comment prose carries
 * fingerprints, process ids, and epoch stamps that look like a SHA. A commit
 * the checkout landed with the issue's `(#<number>)` reference answers before
 * the forge is asked, so a forge that records no closing commit still reports
 * the exact release; an issue no commit names at all falls back to the release
 * published closest to the close. Every failure is reported rather than thrown,
 * so a caller can record why a closed issue stays unresolved.
 */
export async function resolveShippedVersion<Issue extends ClosingCommitIssue>(
  issue: Issue,
  client: ClosingCommitClient,
  releases: PublishedRelease[],
): Promise<VersionResolution> {
  if (issue.state !== "closed") return { version: null, error: null, inferred: false };
  const nearest = releaseAtClose(releases, issue);
  const withoutCommit = (error: string): VersionResolution =>
    nearest === null
      ? { version: null, error, inferred: false }
      : { version: nearest, error: null, inferred: true };
  try {
    const landed = await landedShippedVersion(issue.number, client, releases);
    if (landed !== null) return landed;
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
  releases: PublishedRelease[],
): Promise<string | null> {
  return (await resolveShippedVersion(issue, client, releases)).version;
}

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import {
  isMergeCommit,
  nextReleaseVersion,
  readCommits,
  releaseLevel,
  type CommitRecord,
} from "./commit-gate";
import { highestReleaseVersion } from "./release";

/**
 * The Release Train's one deterministic pre-check.
 *
 * Contract: "unreleased" means at least one non-merge commit is reachable from
 * the tracked branch's tip and not reachable from the newest release tag that
 * is also reachable from that tip. A merge commit alone never counts, so a
 * merge of already-released work releases nothing. With no reachable release
 * tag the whole history is unreleased and the first release is `1.0.0`.
 *
 * The helper fetches the remote branch and its tags, reads the merged release
 * tags itself (never a silent empty list on failure), and reports any fetch,
 * tag, revision, or commit-read failure as `state: "error"`. A caller must not
 * start an agent on an error, and must not treat one as "nothing to release".
 *
 * It is the Release Train worker's only gate. Another family that needs the
 * same answer calls `checkReleaseTrain` rather than re-implementing the
 * definition.
 */

export interface ReleaseTrainCommit {
  sha: string;
  subject: string;
  merge: boolean;
}

export interface ReleaseTrainTag {
  tag: string;
  version: string;
}

export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type GateGit = (args: string[]) => GitOutcome;

export interface ReleaseTrainGateOptions {
  /** The canonical remote; defaults to `origin`. */
  remote?: string;
  /** The canonical branch; defaults to `main`. */
  branch?: string;
  /** Fetch the branch and tags before reading; defaults to true. */
  fetch?: boolean;
  /** Test seam; defaults to `git -C <repoDir>`. */
  run?: GateGit;
}

export interface ReleaseTrainUnreleased {
  state: "unreleased";
  /** The tracked branch tip the range ends at. */
  target: string;
  previous: ReleaseTrainTag | null;
  /** `<previous tag>..<target>`, or the target when no release tag exists. */
  range: string;
  /** The version the range releases under the Conventional Commit derivation. */
  version: string;
  /** Every commit in the range, merges included. */
  commits: ReleaseTrainCommit[];
  /** The non-merge commits that make the range unreleased. */
  releaseCommits: ReleaseTrainCommit[];
}

export interface ReleaseTrainNothing {
  state: "nothing";
  target: string;
  previous: ReleaseTrainTag | null;
  range: string;
}

export interface ReleaseTrainFailure {
  state: "error";
  detail: string;
}

export type ReleaseTrainGate = ReleaseTrainUnreleased | ReleaseTrainNothing | ReleaseTrainFailure;

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

function gitOutcome(result: SpawnSyncReturns<string>): GitOutcome {
  return {
    code: result.error === undefined ? (result.status ?? 1) : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr:
      result.error === undefined
        ? typeof result.stderr === "string"
          ? result.stderr
          : ""
        : result.error.message,
  };
}

/** The default runner: one `git -C <repoDir>` invocation. */
export function releaseTrainGit(repoDir: string): GateGit {
  return (args) =>
    gitOutcome(
      spawnSync("git", ["-C", resolve(repoDir), ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }),
    );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function failure(description: string, outcome: GitOutcome): ReleaseTrainFailure {
  return { state: "error", detail: `${description}: ${firstLine(outcome.stderr || outcome.stdout)}` };
}

/** Every release tag merged into `target`, or an error when that read fails. */
function mergedTags(
  run: GateGit,
  target: string,
): { tags: ReleaseTrainTag[] } | ReleaseTrainFailure {
  const result = run(["tag", "--merged", target, "--list", "v*"]);
  if (result.code !== 0) return failure(`could not read the release tags merged into ${target}`, result);
  const tags: ReleaseTrainTag[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = RELEASE_TAG.exec(line.trim());
    if (match?.[1] !== undefined) tags.push({ tag: `v${match[1]}`, version: match[1] });
  }
  return { tags };
}

function describeCommit(commit: CommitRecord): ReleaseTrainCommit {
  return {
    sha: commit.sha,
    subject: commit.subject,
    merge: isMergeCommit(commit),
  };
}

/** One deterministic answer for the tracked branch: release, nothing, or failure. */
export function checkReleaseTrain(
  repoDir: string,
  options: ReleaseTrainGateOptions = {},
): ReleaseTrainGate {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? "main";
  const run = options.run ?? releaseTrainGit(repoDir);
  const targetRef = `refs/remotes/${remote}/${branch}`;

  if (options.fetch !== false) {
    const fetched = run([
      "fetch",
      "--prune",
      remote,
      `+refs/heads/${branch}:${targetRef}`,
      "+refs/tags/*:refs/tags/*",
    ]);
    if (fetched.code !== 0) {
      return failure(`could not fetch ${remote}/${branch} and its tags`, fetched);
    }
  }

  const resolved = run(["rev-parse", "--verify", `${targetRef}^{commit}`]);
  if (resolved.code !== 0) {
    return failure(`could not read ${remote}/${branch}`, resolved);
  }
  const target = resolved.stdout.trim();
  if (target.length === 0) {
    return { state: "error", detail: `could not read ${remote}/${branch}: it resolved to no commit` };
  }

  const tags = mergedTags(run, target);
  if ("state" in tags) return tags;
  const newest = highestReleaseVersion(tags.tags.map((tag) => tag.version));
  const previous =
    newest === undefined
      ? null
      : (tags.tags.find((tag) => tag.version === newest) ?? null);
  const range = previous === null ? target : `${previous.tag}..${target}`;

  let commits: CommitRecord[];
  try {
    commits = readCommits(resolve(repoDir), range);
  } catch (error) {
    return {
      state: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const releaseCommits = commits.filter((commit) => !isMergeCommit(commit));
  if (releaseCommits.length === 0) {
    return { state: "nothing", target, previous, range };
  }
  return {
    state: "unreleased",
    target,
    previous,
    range,
    version: nextReleaseVersion(previous?.version, releaseLevel(commits)),
    commits: commits.map(describeCommit),
    releaseCommits: releaseCommits.map(describeCommit),
  };
}

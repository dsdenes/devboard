import { spawnSync } from "node:child_process";
import { compareReleaseVersions, highestReleaseVersion } from "./release";

/**
 * The Conventional Commits gate and the release version derived from release
 * tags and commit messages. One implementation backs the pre-push hook, the
 * release step, the design release path, and the source-checkout version, so
 * no caller can compute a different number from the same history.
 *
 * A merge commit is exempt from both the grammar and the bump mapping: a real
 * merge has two or more parents, and Git's generated `Merge …` subject covers
 * synthetic merges whose duplicate parents Git dropped. The first release of
 * this line is `1.0.0`, whatever the commit types in its range are; later
 * releases advance the newest reachable release tag by the highest level in
 * the non-merge commits after it.
 */

export const BASELINE_VERSION = "1.0.0";

export const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];
export type ReleaseLevel = "major" | "minor" | "patch";

export interface CommitRecord {
  sha: string;
  subject: string;
  /** The message body without the subject line. */
  body: string;
  parents: string[];
}

export interface CommitViolation {
  sha: string;
  subject: string;
  rule: string;
}

export interface ReleaseTag {
  tag: string;
  version: string;
}

export interface ReleaseDerivation {
  /** The version this range releases. */
  version: string;
  /** The newest release tag reachable from the target, when one exists. */
  previous: ReleaseTag | undefined;
  level: ReleaseLevel | null;
  /** `<previous tag>..<target>`, or the target alone when no tag exists. */
  range: string;
  commits: CommitRecord[];
}

export interface ParsedSubject {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

export interface PrePushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const SUBJECT = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?: ([\s\S]*)$/;
const MERGE_SUBJECT = /^Merge /;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const ZERO_SHA = /^0+$/;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const LOG_FORMAT = `%H${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(directory: string, args: string[], input?: string): GitResult {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The parsed parts of a subject, or null when it has no Conventional shape. */
export function parseSubject(subject: string): ParsedSubject | null {
  const match = SUBJECT.exec(subject);
  if (match === null) return null;
  const [, rawType = "", scope, bang, description = ""] = match;
  return {
    type: rawType,
    ...(scope === undefined ? {} : { scope }),
    breaking: bang === "!",
    description,
  };
}

/** The rule a subject breaks, or null when it conforms. */
export function subjectRule(subject: string): string | null {
  if (subject.trim().length === 0) return "the subject is empty";
  const parsed = parseSubject(subject);
  if (parsed === null) {
    return "the subject is not `<type>[(<scope>)][!]: <description>`";
  }
  if (parsed.type !== parsed.type.toLowerCase()) {
    return `the type "${parsed.type}" must be lowercase`;
  }
  if (!(CONVENTIONAL_TYPES as readonly string[]).includes(parsed.type)) {
    return `the type "${parsed.type}" is not one of ${CONVENTIONAL_TYPES.join(", ")}`;
  }
  if (parsed.scope !== undefined && !/^[a-z0-9._-]+$/.test(parsed.scope)) {
    return `the scope "${parsed.scope}" must match [a-z0-9._-]+`;
  }
  if (
    parsed.description.length === 0 ||
    parsed.description !== parsed.description.trim()
  ) {
    return "the description must be non-empty with no leading or trailing whitespace";
  }
  return null;
}

/**
 * True for a merge commit. Git records two parents for a real merge; a
 * synthetic merge built with `git commit-tree -p HEAD -p HEAD` keeps only one
 * parent because Git drops the duplicate, so Git's generated `Merge …` subject
 * is recognized too. Both are exempt from the grammar and the bump mapping.
 */
export function isMergeCommit(commit: CommitRecord): boolean {
  return commit.parents.length >= 2 || MERGE_SUBJECT.test(commit.subject);
}

/** The bump one commit contributes; null for a merge commit. */
export function commitLevel(commit: CommitRecord): ReleaseLevel | null {
  if (isMergeCommit(commit)) return null;
  const parsed = parseSubject(commit.subject);
  const footerBreaking = /^BREAKING[ -]CHANGE:/m.test(commit.body);
  if (parsed?.breaking === true || footerBreaking) return "major";
  if (parsed?.type === "feat") return "minor";
  return "patch";
}

/** The highest bump among the commits; null when there is no non-merge commit. */
export function releaseLevel(commits: readonly CommitRecord[]): ReleaseLevel | null {
  let level: ReleaseLevel | null = null;
  for (const commit of commits) {
    const current = commitLevel(commit);
    if (current === "major") return "major";
    if (current === "minor") level = "minor";
    else if (current === "patch" && level === null) level = "patch";
  }
  return level;
}

/** The next release version: the 1.0.0 baseline first, then the bump. */
export function nextReleaseVersion(
  previous: string | undefined,
  level: ReleaseLevel | null,
): string {
  if (previous === undefined) return BASELINE_VERSION;
  if (compareReleaseVersions(previous, previous) === undefined) {
    throw new Error(`unreadable release version: ${previous}`);
  }
  const order = compareReleaseVersions(previous, BASELINE_VERSION);
  if (order === undefined) throw new Error(`unreadable release version: ${previous}`);
  if (order < 0) return BASELINE_VERSION;
  if (level === null) return previous;
  const [major = 0, minor = 0, patch = 0] = previous.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function parseRecords(text: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of text.split(RECORD_SEPARATOR)) {
    const record = chunk.replace(/^\n+/, "");
    if (record.trim().length === 0) continue;
    const [sha = "", parents = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
    records.push({
      sha,
      subject,
      body,
      parents: parents.split(/\s+/).filter((parent) => parent.length > 0),
    });
  }
  return records;
}

/** Every commit reachable from `range`, merges included. */
export function readCommits(directory: string, range: string): CommitRecord[] {
  const result = git(directory, ["log", `--format=${LOG_FORMAT}`, range, "--"]);
  if (result.code !== 0) {
    throw new Error(
      `could not read the commits of ${range}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return parseRecords(result.stdout);
}

function readCommitsBySha(directory: string, shas: readonly string[]): CommitRecord[] {
  if (shas.length === 0) return [];
  const result = git(
    directory,
    ["log", "--no-walk=unsorted", "--stdin", `--format=${LOG_FORMAT}`],
    `${shas.join("\n")}\n`,
  );
  if (result.code !== 0) {
    throw new Error(
      `could not read ${shas.length} commit(s): ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return parseRecords(result.stdout);
}

/** Every non-merge commit in the range whose subject breaks the grammar. */
export function commitViolations(commits: readonly CommitRecord[]): CommitViolation[] {
  const violations: CommitViolation[] = [];
  for (const commit of commits) {
    if (isMergeCommit(commit)) continue;
    const rule = subjectRule(commit.subject);
    if (rule !== null) {
      violations.push({ sha: commit.sha, subject: commit.subject, rule });
    }
  }
  return violations;
}

export function checkCommitRange(directory: string, range: string): CommitViolation[] {
  return commitViolations(readCommits(directory, range));
}

/** One line per violation: the sha and subject, then the broken rule. */
export function formatViolations(violations: readonly CommitViolation[]): string {
  return violations
    .map((violation) => `commit-gate: ${violation.sha} ${violation.subject}\n  ${violation.rule}`)
    .join("\n");
}

/** The release tags reachable from `head`, with their `v` stripped. */
export function releaseTags(directory: string, head = "HEAD"): ReleaseTag[] {
  const result = git(directory, ["tag", "--merged", head, "--list", "v*"]);
  if (result.code !== 0) return [];
  const tags: ReleaseTag[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = RELEASE_TAG.exec(line.trim());
    if (match?.[1] !== undefined) tags.push({ tag: `v${match[1]}`, version: match[1] });
  }
  return tags;
}

/** The newest release version reachable from `head`; the source-checkout rule. */
export function newestReleaseVersion(directory: string, head = "HEAD"): string | undefined {
  return highestReleaseVersion(releaseTags(directory, head).map((tag) => tag.version));
}

/** The highest release tag reachable from `head`. */
export function previousReleaseTag(directory: string, head = "HEAD"): ReleaseTag | undefined {
  let previous: ReleaseTag | undefined;
  for (const tag of releaseTags(directory, head)) {
    const order = previous === undefined ? 1 : compareReleaseVersions(tag.version, previous.version);
    if (order === undefined) continue;
    if (order > 0) previous = tag;
  }
  return previous;
}

/** The highest release version whose tag points exactly at `sha`. */
export function releaseVersionAt(directory: string, sha = "HEAD"): string | undefined {
  const result = git(directory, ["tag", "--points-at", sha, "--list", "v*"]);
  if (result.code !== 0) return undefined;
  const versions: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = RELEASE_TAG.exec(line.trim());
    if (match?.[1] !== undefined) versions.push(match[1]);
  }
  return highestReleaseVersion(versions);
}

/**
 * The version a `head` commit releases: the newest reachable release tag
 * advanced by the non-merge commits after it, or the 1.0.0 baseline while the
 * newest release is still below it.
 */
export function deriveReleaseVersion(directory: string, head = "HEAD"): ReleaseDerivation {
  const previous = previousReleaseTag(directory, head);
  const range = previous === undefined ? head : `${previous.tag}..${head}`;
  const commits = readCommits(directory, range);
  const level = releaseLevel(commits);
  return {
    version: nextReleaseVersion(previous?.version, level),
    previous,
    level,
    range,
    commits,
  };
}

/** The four-field lines a pre-push hook receives on standard input. */
export function parsePrePush(input: string): PrePushRef[] {
  const refs: PrePushRef[] = [];
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) {
      throw new Error(`unreadable pre-push line: ${trimmed}`);
    }
    const [localRef = "", localSha = "", remoteRef = "", remoteSha = ""] = parts;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

function objectExists(directory: string, sha: string): boolean {
  return git(directory, ["cat-file", "-e", `${sha}^{commit}`]).code === 0;
}

/**
 * The commits a push makes reachable that no remote already has. The remote
 * sha from the pre-push line is authoritative for its destination; every
 * known remote-tracking ref is excluded too, so a commit already pushed to
 * another remote is not re-checked and no network access is needed.
 */
export function pushedCommits(
  directory: string,
  refs: readonly PrePushRef[],
): CommitRecord[] {
  const shas = new Set<string>();
  for (const ref of refs) {
    if (ZERO_SHA.test(ref.localSha)) continue;
    const args = ["rev-list", ref.localSha, "--not"];
    if (!ZERO_SHA.test(ref.remoteSha) && objectExists(directory, ref.remoteSha)) {
      args.push(ref.remoteSha);
    }
    args.push("--remotes");
    const result = git(directory, args);
    if (result.code !== 0) {
      throw new Error(
        `could not list the commits of ${ref.localRef}: ` +
          (result.stderr.trim() || `exit ${result.code}`),
      );
    }
    for (const sha of result.stdout.split("\n")) {
      if (sha.trim().length > 0) shas.add(sha.trim());
    }
  }
  return readCommitsBySha(directory, [...shas]);
}

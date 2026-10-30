#!/usr/bin/env bun
/**
 * The Conventional Commits gate.
 *
 *   bun scripts/commit-gate.ts check <range>
 *   bun scripts/commit-gate.ts version <previous> <range>
 *   bun scripts/commit-gate.ts hook
 *
 * `check` exits 1 and names every non-conforming non-merge commit in the
 * range. `version` prints the release version that range produces from the
 * given previous release. `hook` is the pre-push entry point: it reads the
 * ref lines from standard input and checks only the commits the push makes
 * reachable that no remote already has.
 */

import {
  checkCommitRange,
  commitViolations,
  formatViolations,
  nextReleaseVersion,
  parsePrePush,
  pushedCommits,
  readCommits,
  releaseLevel,
  type CommitViolation,
} from "../lib/commit-gate";

function usage(): never {
  console.error(`Usage: bun scripts/commit-gate.ts <command>

  check <range>                Reject non-Conventional subjects in the range.
  version <previous> <range>   Print the version the range releases.
  hook                         Check the refs on standard input (pre-push).`);
  process.exit(2);
}

function report(violations: CommitViolation[]): number {
  if (violations.length === 0) return 0;
  console.error(formatViolations(violations));
  console.error(
    `commit-gate: ${violations.length} commit(s) are not Conventional Commits; ` +
      "reword them with `git commit --amend` or an interactive rebase and retry",
  );
  return 1;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const directory = process.cwd();
  if (command === "check") {
    const range = args[0];
    if (range === undefined) usage();
    return report(checkCommitRange(directory, range));
  }
  if (command === "version") {
    const [previous, range] = args;
    if (previous === undefined || range === undefined) usage();
    const version = nextReleaseVersion(previous, releaseLevel(readCommits(directory, range)));
    console.log(version);
    return 0;
  }
  if (command === "hook") {
    const refs = parsePrePush(await Bun.stdin.text());
    return report(commitViolations(pushedCommits(directory, refs)));
  }
  usage();
}

process.exit(await main());

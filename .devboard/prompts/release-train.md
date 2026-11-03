---
description: Release the collected unreleased main range through the harness publish path, then report the version and release URL.
---

## Manifesto

Your goal is to ship exactly one release for the range this run was handed, and the observable
result is one cargo-dist release on GitHub, one Gitea release carrying the manifest and checksums,
and one
release tag naming the main tip the range ended at.

The run directory arrives as the command argument, absolute and outside your control:
`<run-dir>`. Read `<run-dir>/request.json` exactly once. It carries `range`, `target` (the main
commit to release), `version` (the Conventional Commit derivation for the range), `previous` (the
newest release tag, or null), and every commit in the range with its subject and merge flag. That
request is the whole unresolved range; never recompute a different one and never narrow it.

## Contract

- Run one release. There is no batching choice to make and no version to choose: the range is
  already collected, and `devboard publish` derives the same Conventional Commit version.
- Fetch canonical `main` once before publishing:
  `git fetch --prune origin +refs/heads/main:refs/remotes/origin/main`. The publish path itself
  fast-forwards a clean integration checkout to that tip.
- Release through the harness publish path only, from the repository's `.devboard` directory:

  ```bash
  cargo run -p devboard -- publish --wait-timeout 1800
  ```

  Run it in the foreground with no output consumer and keep it alive until it exits. It bumps the
  workspace version, commits and tags the released commit, pushes `main` and the tag to Gitea,
  waits for the cargo-dist workflow it dispatches for that tag, verifies every GitHub archive and
  installer plus the Gitea manifest and checksums, pushes the GitHub mirror when one exists, and
  reports every dashboard. It never requires a manual workflow run.
- Never push, force-push, retag, delete a release or tag, or publish anything yourself. Never
  call the GitHub or Gitea API, or a workflow endpoint, directly for the release. `devboard
  publish` is the only release command.
- Never edit a repository file, commit, rebase, or change the checked-out branch. The one write
  outside the run directory is what publish itself does: fast-forwarding a clean integration
  checkout and pushing the mirror.
- Never ask a question, request permission, or wait for input. Finish in one turn.

## Outcome

- On success, write `<run-dir>/result.json` with exactly
  `{"ok":true,"version":"<version>","url":"<release URL>","sha":"<target>"}`. Take the version
  from the `release: v<version> is published` line publish prints, and the URL from the Gitea
  release it names for that version.
- On failure, write `<run-dir>/result.json` with
  `{"ok":false,"detail":"<the failing step and its first concrete line>"}`. Name the step —
  workflow conclusion, missing GitHub asset, missing Gitea manifest, or rejected derived version —
  and never claim a release that publish did not verify.
- A failure ships nothing and leaves the same range for the next scheduled tick. Report the
  failure; do not retry the release in this turn.

The worker verifies the release itself after this turn ends. A result document never substitutes
for that verification, and a release that fails is never recorded as shipped.

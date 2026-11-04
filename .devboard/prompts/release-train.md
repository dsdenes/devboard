---
description: Release the collected unreleased main range through the harness publish path, then report the version and release URL.
---

## Manifesto

Your goal is to ship exactly one release for the range this run was handed, and the observable
result is one npm version, one Gitea release with its fallback tarball and checksum, and one
release tag naming the main tip the range ended at.

The run directory arrives as the command argument, absolute and outside your control:
`<run-dir>`. Read `<run-dir>/request.json` exactly once. It carries `range`, `target` (the main
commit to release), `version` (the Conventional Commit derivation for the range), `previous` (the
newest release tag, or null), and every commit in the range with its subject and merge flag. That
request is the whole unresolved range; never recompute a different one and never narrow it.

## Contract

- Run one release. There is no batching choice to make and no version to choose: the range is
  already collected, and `bun run publish` derives the same Conventional Commit version.
- Fetch canonical `main` once before publishing:
  `git fetch --prune origin +refs/heads/main:refs/remotes/origin/main`. The publish path itself
  fast-forwards a clean integration checkout to that tip.
- Release through the harness publish path only, from the repository's `.devboard` directory:

  ```bash
  bun run publish --wait-timeout 1800
  ```

  Run it in the foreground with no output consumer and keep it alive until it exits. It waits for
  the release workflow it dispatches for the checked-out `main` tip, reads the tag that workflow
  created, verifies the npm package and both Gitea assets, pushes the GitHub mirror when one
  exists, and reports every dashboard. It never requires a push and never needs a manual
  workflow run.
- Never push, force-push, retag, delete a release or tag, or publish a package yourself. Never
  call npm, the Gitea API, or a workflow endpoint directly for the release. `bun run publish` is
  the only release command.
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
  workflow conclusion, missing npm version, missing release asset, or rejected derived version —
  and never claim a release that publish did not verify.
- A failure ships nothing and leaves the same range for the next scheduled tick. Report the
  failure; do not retry the release in this turn.

The worker verifies the release itself after this turn ends. A result document never substitutes
for that verification, and a release that fails is never recorded as shipped.

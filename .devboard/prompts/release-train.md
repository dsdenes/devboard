---
description: Release the collected unreleased main range through the harness publish path, then report the version and release URL.
---

## Manifesto

Your goal is to ship exactly one release for the range this run was handed, and the observable
result is one tagged version, one GitHub release with the platform archives and installers, and one
Gitea release carrying `devboard-manifest.json` and the checksums, all naming the main tip the range
ended at.

The run directory arrives as the command argument, absolute and outside your control:
`<run-dir>`. Read `<run-dir>/request.json` exactly once. It carries `range`, `target` (the main
commit to release), `version` (the Conventional Commit derivation for the range), `previous` (the
newest release tag, or null), and every commit in the range with its subject and merge flag. That
request is the whole unresolved range; never recompute a different one and never narrow it.

## Contract

- Run one release. There is no batching choice to make and no version to choose: the range is
  already collected, and `devboard publish` derives the same Conventional Commit version.
- `devboard publish` fetches canonical `main` itself and fast-forwards a clean integration
  checkout to that tip before it derives the range; never fetch it by hand first.
- The run directory carries `env.sh`, the forge coordinates this worker was started with. Source
  it in the same shell as the release command and never print it:
  `set -a; . <run-dir>/env.sh; set +a`.
- Release through the harness publish path only. From the repository root run `devboard publish
  --repo . --wait-timeout 1800`; in a source checkout where the binary is not on `PATH`, run
  `cargo run --manifest-path .devboard/Cargo.toml -p devboard -- publish --repo .
  --wait-timeout 1800`. The `--repo .` names the checkout root, not the harness directory.

  Run it in the foreground and keep it alive until it exits. Publish records each phase of
  the release — the fetch, the derived version, the bundle rebuild, every suite attempt, the
  CI run and its conclusion, the tag push, the GitHub assets, and the Gitea manifest — into
  `<run-dir>/publish-progress.jsonl` itself, so the release log names the CI run and its
  success before the tag push without any `tee` or shell redirection. It runs the
  release suite before tagging, pushes the branch, waits for that commit's `devboard-ci.yml` run
  to conclude success, then pushes the tag. It dispatches `devboard-build.yml` from the canonical
  commit, verifies the GitHub archives, installer, checksums, and manifest against the Gitea
  manifest, moves the GitHub release tag to an empty-tree commit, and reports every dashboard. It
  never requires a push and never needs a manual workflow run.
- Never push, force-push, retag, delete a release or tag, or publish a package yourself. Never
  call cargo-dist, the GitHub API, the Gitea API, or a workflow endpoint directly for the release.
  `devboard publish` is the only release command.
- The release suite runs inside `devboard publish`. When a test fails three consecutive attempts,
  the suite quarantines it: the rest of that run skips it, one deduplicated issue records its file,
  exact test name, and failed output, and the release continues. Never rewrite a tracked test file,
  delete a failing test, or bypass the suite; a structural suite failure (a compile error or no
  per-test result) stops the release and prints the first concrete error line.
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
  workflow conclusion, missing platform archive or installer, missing Gitea manifest, or rejected
  derived version —
  and never claim a release that publish did not verify.
- A failure ships nothing and leaves the same range for the next scheduled tick. Report the
  failure; do not retry the release in this turn.

The worker verifies the release itself after this turn ends. A result document never substitutes
for that verification, and a release that fails is never recorded as shipped.

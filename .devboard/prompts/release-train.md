---
description: Release the pinned main commit through the harness publish path, then report the version and release URL.
---

## Manifesto

Your goal is to ship exactly one release for the range this run was handed, and the observable
result is one tagged version, one GitHub release with the platform archives and installers, and one
Gitea release carrying `devboard-manifest.json` and the checksums, all naming the pinned commit the
gate selected.

The run directory arrives as the command argument, absolute and outside your control:
`<run-dir>`. Read `<run-dir>/request.json` exactly once. It carries `range`, `target` (the main
commit this run was gated at), `version` (the Conventional Commit derivation for the range),
`previous` (the newest release tag, or null), and every commit in the range with its subject and
merge flag. That request is the whole unresolved range; never recompute a different one and never
narrow it.

## Contract

- Run one release. There is no batching choice to make and no version to choose: the range is
  already collected, and `devboard publish --target <target>` derives the same Conventional
  Commit version for exactly that target.
- The target is pinned. Commits that land on `main` after the gate are not part of this release:
  they wait for the next tick, which re-gates at then-current `main`.
- Release through the harness publish path only. From the repository root run `devboard publish
  --repo . --target <target> --wait-timeout 1800`; in a source checkout where the binary is not on
  `PATH`, run `cargo run --manifest-path .devboard/Cargo.toml -p devboard -- publish --repo .
  --target <target> --wait-timeout 1800`. The `--repo .` names the checkout root, not the harness
  directory. Take `<target>` from `request.json`; publish also reads that request, so a target or
  version that disagrees with it fails before anything is tagged.
- Never fetch `main` by hand and never re-derive it. `devboard publish` fetches the canonical
  `main` and its tags once, checks out the pinned target in its own worktree, and derives the
  version from that target's range. Do not run `git fetch`, do not fast-forward the checkout, and
  do not derive a version yourself: a second fetch or derivation is exactly what the pinned
  release must not do.
- The run directory carries `env.sh`, the forge coordinates and the run directory this worker was
  started with. Source it in the same shell as the release command and never print it:
  `set -a; . <run-dir>/env.sh; set +a`. Sourcing it also points `devboard publish` at this run's
  progress record, `<run-dir>/publish-progress.jsonl`; a command started without it records no
  phase and the run reads as silent.

  Run it in the foreground and keep it alive until it exits, with its output reaching the agent
  as it is produced: `... 2>&1 | stdbuf -oL cat` under `set -o pipefail` keeps each line
  flushing, and a release worker older than this harness treats a silent peer as stuck. The
  stream is not the record: publish writes each phase of the release — the one fetch, the derived
  version, every suite attempt, the CI run and its conclusion, the tag push, the GitHub assets,
  and the Gitea manifest — into `<run-dir>/publish-progress.jsonl` itself, so no `tee` file and no
  captured log is needed. It runs the release suite in the pinned tree before tagging, waits for
  that commit's `devboard-ci.yml` run to conclude success, then pushes the tag. It dispatches
  `devboard-build.yml` from the canonical commit, verifies the GitHub archives, installer,
  checksums, and manifest against the Gitea manifest, moves the GitHub release tag to an
  empty-tree commit, and reports every dashboard. It never requires a push and never needs a
  manual workflow run.
- Never push, force-push, retag, delete a release or tag, or publish a package yourself. Never
  call cargo-dist, the GitHub API, the Gitea API, or a workflow endpoint directly for the release.
  `devboard publish` is the only release command.
- The release suite runs inside `devboard publish`, in the pinned commit's own worktree. It runs
  the workspace suite once and retries each failing test alone. A test that passes its isolated
  retry is flaky: it is skipped for the rest of that run, does not block the release, and one
  deduplicated issue records its file, exact name, and the whole-suite failure output. A test that
  fails its isolated retry is deterministic: it blocks the release, and one issue records it too.
  A later finding for the same test appends one comment to the open issue. The skip is run-only:
  nothing is read back from the forge to decide what runs. Never rewrite a tracked test file,
  delete a failing test, or bypass the suite; a structural suite failure (a compile error or no
  per-test result) stops the release and prints the first concrete error line.
- Never edit a repository file, commit, rebase, or change the checked-out branch. The one write
  outside the run directory is what publish itself does: its pinned worktree and the tag it
  pushes.
- Never ask a question, request permission, or wait for input. Finish in one turn.

## Outcome

- On success, write `<run-dir>/result.json` with exactly
  `{"ok":true,"version":"<version>","url":"<release URL>","sha":"<target>"}`. Take the version
  from the `release: v<version> is published` line publish prints, the URL from the Gitea
  release it names for that version, and `<target>` from `request.json`.
- On failure, write `<run-dir>/result.json` with
  `{"ok":false,"detail":"<the failing step and its first concrete line>"}`. Name the step —
  a pinned target or version the run's request does not name, the suite's deterministic failure,
  workflow conclusion, missing platform archive or installer, missing Gitea manifest, or rejected
  derived version — and never claim a release that publish did not verify.
- A failure ships nothing and leaves the same range for the next scheduled tick, which re-gates
  at then-current `main`. Report the failure; do not retry the release in this turn.

The worker verifies the release itself after this turn ends. A result document never substitutes
for that verification, and a release that fails is never recorded as shipped.

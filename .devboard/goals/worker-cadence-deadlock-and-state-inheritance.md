## Objective

This repository's Devboard harness (`.devboard/`) must stop freezing its background workers. After
the change, a worker whose persisted state already records a completed run keeps advancing its
cadence instead of blocking forever, and a newly installed harness version inherits the most
recently published worker state instead of the legacy unversioned snapshot. The surfaces are the
Auto Scout and Design System cadence gate and the versioned-state startup path shared by Auto
Scout, Design System, Dead Code, Single Responsibility, Consistent Naming, and API Standards. The
change is merged to `main`, pushed, released by the Release Train, and proved live by Auto Scout
scanning and filing issues again.

## Success criteria

1. Cadence liveness, scout and design. A worker whose published state already contains
   `lastScanStartedAt` (scout) or `lastCycleStartedAt` (design) older than its cadence completes a
   tick and publishes a new run start. The regression test fails if that tick has not completed
   within 5 seconds; it never hangs the suite.
2. Post-run liveness, scout and design. After a run completes and the state records its start, a
   later tick starts the next run once the cadence has elapsed, and the worker consumes a control
   command afterwards. The same 5-second bound applies.
3. Inheritance, six families. Starting a worker of a version that has no state of its own publishes,
   from the state with the newest `updatedAt` among `workers/<version>/state.json` files and the
   legacy `state.json`: the cadence anchor (`lastScanStartedAt` or `lastCycleStartedAt`), the
   newest run id (`newestScanId` or `newestCycleId`), the limit values, and `sync` and
   `releaseSignature` where the family records them.
4. Legacy precedence, six families. When a versioned state is newer than the legacy file, no
   anchor, run id, or limit from the legacy file appears in the published state; when only the
   legacy file exists, it is used.
5. Own-state precedence, six families. A version that already has its own versioned state keeps it,
   whatever other versions' timestamps are.
6. Every required check exits zero:
   `cd .devboard && cargo test --test scout_worker --test design_worker --test consistent_naming --test audit_workers`
   `cd .devboard && cargo test --workspace`
   `cd .devboard && cargo clippy --workspace --all-targets -- -D warnings`
7. Red-first. Each new regression test compiles and fails within its bound, not by hanging, on the
   parent commit of the fix, and passes on the fix.
8. Push. `git ls-remote origin refs/heads/main` names the integrated commit, and
   `git status --short --branch` reports no commits ahead of the upstream.
9. Release. The Release Train, never a manual `devboard publish`, publishes exactly one version:
   tag `v<version>` on the released commit, a Gitea release whose `devboard-manifest.json` asset
   names the version and every platform artifact with its SHA-256, and the platform archives on
   GitHub Releases. The dashboard reports `versionState.running` equal to that version.
10. Live scan. After the release, Auto Scout is stopped and started through the dashboard, never by
    hand, so the new-version worker replaces the stuck one. The new worker consumes a Refresh
    control (its published `sync.at` advances) and completes a scan: the newest `scan.json` records
    `status: "succeeded"`, and the Auto Scout panel reports `lastRunAt` equal to that scan's
    `startedAt` with a later `nextRunAt`.
11. Filed issues. Every issue number the new scan's activity names exists on Gitea with the `scout`
    label, and the count equals the scan's `filed`. A scan that files zero is accepted only when
    `scan.json` records `filed: 0` and the activity reports that no candidate met the significance
    threshold.
12. Restart survival. A second Stop and Start keeps `lastRunAt` at the completed scan's `startedAt`;
    the panel never falls back to `2026-11-01T20:24:42Z`.

## Verification

- Criterion 6: run each command verbatim from the repository root; every invocation must exit 0.
- Criterion 7: in a second worktree checked out at the fix's parent commit
  (`git -C .devboard worktree add .worktree/red-first <parent>`), copy in only the new test files,
  run `cd .devboard && cargo test --test scout_worker --test design_worker --test
  consistent_naming --test audit_workers` under `timeout 60`, and record each new test failing;
  the same tests pass on the fixed tree.
- Criterion 8: `git ls-remote origin refs/heads/main` must print the commit that
  `git -C .devboard rev-parse HEAD` names after the merge, and `git status --short --branch` must
  not report `ahead`.
- Criterion 9: read the running dashboard's version through its agent or version state, and query
  the Gitea API for the tag release at `$DEVBOARD_GITEA_URL`; confirm the manifest asset names the
  version and each artifact's SHA-256, and that the GitHub release for the same tag carries the
  archives.
- Criterion 10: inspect the newest scan from current state, never from memory:

  ```
  python3 - <<'PY'
  import glob, json, os
  path = max(glob.glob('.devboard/.tmp/scout/scans/*/scan.json'), key=os.path.getmtime)
  print(path, json.load(open(path)))
  PY
  ```

  Read the Auto Scout panel at the dashboard address and token the running server owns.
- Criterion 11: read the issue numbers from the same scan's `activity.json` and fetch each with the
  Gitea API; compare the count with `scan.json`'s `filed`.
- Criterion 12: use the dashboard's Stop and Start controls, then read the panel and the versioned
  state file again.

## Boundaries

Allowed:

- All work in `.worktree/<name>`; the goal file only in this session until hand-off.
- `.devboard/crates/devboard/src/workers/scout.rs`, `design.rs`, `dead_code.rs`,
  `single_responsibility.rs`, `consistent_naming.rs`, `api_standards.rs`, and any shared module
  they import.
- `.devboard/crates/devboard/tests/scout_worker.rs`, `design_worker.rs`, `consistent_naming.rs`,
  `audit_workers.rs`.
- Harness documentation only where it already states the changed cadence or startup behavior.
- Runtime: the dashboard's Auto Scout controls, read-only reading of `.devboard/.tmp/scout/**`,
  the Gitea API, and the Release Train's automatic release.

Untouched:

- `adrs/`, `GOAL.md`, and every host project file.
- `.github/workflows/release.yml`, `.devboard/release-train/`, `.devboard/dist-workspace.toml`.
- Auto Scout and Design prompts, caps, thresholds, and cadence settings.
- The other families' cadence functions beyond the shared startup path.
- `.omp/` and `.devboard/omp/`; no shipped file changes.
- No manual `devboard publish`, no hand-dispatched release workflow, no hand-kill or hand-spawn of
  the dashboard or any worker.
- Never remove, widen, or bypass the cadence gate, and never make a worker run on every tick.

## Stop conditions

- Continue until every criterion is verified against current state. There is no attempt cap, token
  budget, or time limit.
- Halt and surface only for: a criterion that contradicts the code (for example a family state with
  no `updatedAt`); an irreversible or destructive operation (force push, deleting worker state,
  hand-killing the dashboard); a missing prerequisite (Gitea token, paused Release Train, absent omp
  command); a blocked external dependency (GitHub release host unreachable, dashboard unable to
  replace itself); or the red-first proof being impossible to produce.

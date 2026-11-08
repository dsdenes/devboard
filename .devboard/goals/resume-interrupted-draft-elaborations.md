## Objective

In this repository's Devboard harness under `.devboard/`, a draft elaboration started from the Draft
goals page is never reported as interrupted when it is not. A dashboard running outside
`devboard.slice` no longer mistakes its `systemd-run` launcher for the draft owner and fails the run
in its first watcher poll; a live owner survives any dashboard exit and the next dashboard adopts
it without a reload handoff; and a run whose owner is really gone is restarted automatically exactly
once from the draft, with the recorded activity kept as a prefix. A run that cannot continue records
the actual cause — `The elaboration owner did not start.` when no owner ever claims,
`The elaboration owner exited before it finished.` after the one automatic restart also dies — and
never claims a server exit that did not happen. The interrupted draft
`.devboard/goal-proposals/gitea-only-forge-gh-push-mirror.md` is not re-run by this goal.

## Success criteria

1. **The launcher is not the owner.** A `running` run with no owner claim yet is never marked
   `failed` before 10,000 ms have passed from its `startedAt`; once an owner claims, liveness is
   judged only by the identity that owner process publishes in `owner` (pid, argv, cwd), never by
   the argv of the `systemd-run` launcher that was forked before it. In
   `crates/devboard/tests/goal_drafts.rs`, a test named
   `a_slow_owner_launcher_is_not_a_dead_owner` sets `DEVBOARD_OWNER_EXECUTABLE` to a launcher under
   `.devboard/.test-tmp/` that sleeps 300 ms and then `exec`s the real devboard binary, samples the
   owner state every 10 ms for 1,000 ms, and observes every sample `running` with `error` null and
   a final `owner` whose pid, argv, and cwd equal `/proc/<pid>/cmdline` and `/proc/<pid>/cwd`.
2. **A dashboard exit leaves a live owner running.** With an owner started by the real
   `devboard worker goal-draft` and a stub agent streaming activity, deleting the goal-draft lease
   and killing its recorded launcher and supervisor pid leaves the owner alive for at least 15,000
   ms, its state `running`, and its activity still growing. A second `App` on the same repository
   and state directory, with no `handoff.json` present, adopts that same owner pid, replays its
   activity, delivers an answer to the same peer, and ends it with Stop; no `failed` state is
   written at any point. A test named
   `a_live_owner_survives_a_supervisor_exit_and_a_new_app_adopts_it` proves this.
3. **The orphan reaper does not kill a live owner.** A supervision pass run with the dashboard dead
   and no fresh lease reports no kill for a pid recorded as the owner of a `running` draft run, and
   that process is still alive afterwards. A test named
   `the_orphan_reaper_never_kills_a_live_goal_draft_owner` proves this.
4. **A dead owner is restarted exactly once.** With the dashboard alive, killing the owner pid of a
   running stub elaboration produces, within 5,000 ms, exactly one new owner for that draft: the
   run stays `running`, the state's owner pid changes once, the run's recorded activity is a prefix
   of the new activity, no client sends `startGoalDraft`, and the client receives a `running`
   `issuesDraftState`. Killing the restarted owner too records `failed` with the exact error
   `The elaboration owner exited before it finished.`, spawns no third owner, and leaves the draft
   listed with its row Start enabled. Tests named
   `a_dead_owner_is_restarted_once_and_a_second_death_is_truthful` cover both outcomes.
5. **A start that never claims fails truthfully.** A launcher that never `exec`s produces exactly
   one automatic restart, then a `failed` run whose error is exactly
   `The elaboration owner did not start.`, and no third launcher invocation. A test named
   `a_start_that_never_claims_fails_truthfully` proves this.
6. **A missing draft is never restarted.** A `running` record whose draft file is absent starts no
   owner and is recorded `failed` with the same `No draft at <path>.` message a start refusal uses.
7. **The false message is gone.** `grep -rn "interrupted the elaboration" .devboard/crates
   .devboard/client .devboard/README.md` prints nothing.
8. **The interface and contract are untouched.** `git diff --exit-code -- .devboard/client
   .devboard/contract ../DESIGN.md` is empty against the integration base, and the existing
   `tests/goal_drafts.rs`, `tests/restart.rs`, `tests/cleanup.rs`, and supervision tests pass
   without a change to their expected frames, test ids, or refusal texts.
9. **The README states the new lifecycle.** It says a live goal-draft owner survives any dashboard
   exit and is adopted by the next dashboard without a handoff, that an interrupted run restarts
   once automatically, and it names both truthful errors. `grep -n "Any other dashboard exit"
   .devboard/README.md` and `grep -n "nothing resumes automatically" .devboard/README.md` print
   nothing.
10. **The workspace gates pass.** `cargo fmt --check --all`, `cargo clippy --workspace --all-targets
    -- -D warnings`, `cargo test --workspace`, `cargo test -p devboard-contract`, `bun test`,
    `bun run check`, and `bun run build` all exit 0, and `bun scripts/embed-client.mjs` leaves
    `git diff --exit-code -- ../crates/devboard/assets` empty.
11. **The change is merged, pushed, and released.** `main` at the upstream names the integrated
    commit, `git status --short --branch` reports no commits ahead, and the Release Train publishes
    the versions from that commit through the ordinary GitHub workflow and Gitea manifest; a live
    dashboard's `versionState` reports the published version.
12. **The live path is proven.** A dashboard built from the worktree and started outside
    `devboard.slice` against a fixture repository under `.devboard/.test-tmp/`, with
    `AGENT_COMMAND` set to the `acp-stub --goal-draft` command, starts a fixture draft from the
    Draft goals page: the run stays `running` with activity past 10,000 ms, no interrupted error
    appears, and Stop then records `stopped`.

## Verification

Run every step inside the worktree `<REPO_DIR>/.worktree/<name>`, then repeat the workspace gates on
`main` after the merge and push.

- Targeted regressions, each named test required:
  ```bash
  cd .devboard
  cargo test -p devboard --test goal_drafts \
    a_slow_owner_launcher_is_not_a_dead_owner
  cargo test -p devboard --test goal_drafts \
    a_live_owner_survives_a_supervisor_exit_and_a_new_app_adopts_it
  cargo test -p devboard --test goal_drafts \
    the_orphan_reaper_never_kills_a_live_goal_draft_owner
  cargo test -p devboard --test goal_drafts \
    a_dead_owner_is_restarted_once_and_a_second_death_is_truthful
  cargo test -p devboard --test goal_drafts \
    a_start_that_never_claims_fails_truthfully
  ```
- Message retirement: `grep -rn "interrupted the elaboration" .devboard/crates .devboard/client
  .devboard/README.md` prints nothing, and the second-death and never-claim tests assert the two
  exact replacement errors.
- Contract and client: `git diff --exit-code -- .devboard/client .devboard/contract ../DESIGN.md`,
  then `cd .devboard && cargo test --workspace`.
- Documentation: `grep -n "adopts" .devboard/README.md` shows the dashboard-exit paragraph, the two
  `grep -n` commands in criterion 9 print nothing, and
  `grep -n "The elaboration owner did not start." .devboard/README.md` and
  `grep -n "The elaboration owner exited before it finished." .devboard/README.md` each print a
  line.
- Gates:
  ```bash
  cd .devboard
  cargo fmt --check --all
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
  cargo test -p devboard-contract
  bun install --frozen-lockfile
  bun test
  bun run check
  bun run build && bun scripts/embed-client.mjs
  git diff --exit-code -- ../crates/devboard/assets ../contract ../DESIGN.md
  git status --porcelain
  ```
- Live path, only against a build from this worktree and never against a stale bundle: copy a
  fixture repository under `.devboard/.test-tmp/live/`, run
  `cargo run -p devboard -- serve --repo .devboard/.test-tmp/live/repo --state-dir
  .devboard/.test-tmp/live/state --port <free>` with
  `AGENT_COMMAND="<abs>/devboard acp-stub --goal-draft --log=<abs>/agent.log"` from a shell whose
  process is not in `devboard.slice` (`cat /proc/self/cgroup` proves it), open the Draft goals
  page, start the fixture draft, and observe at least 10,000 ms of `running` state with activity,
  no `interrupted` text, and no `failed` state; Stop then shows `stopped`. Also confirm the spawned
  owner appears in `devboard.slice` (`cat /proc/<owner-pid>/cgroup`).
- Orphan proof: with the live dashboard killed by the test harness only for the fixture state
  directory, run one `devboard worker watchdog` pass (or its exposed reaper entry point) against
  that state directory and confirm its report lists no kill for the live owner pid.
- Delivery:
  ```bash
  git fetch origin main
  git ls-remote origin refs/heads/main
  git rev-parse HEAD
  git status --short --branch
  curl -fsS "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/latest"
  ```
  The first two name the same commit, the status line reports no commits ahead, and the release
  carries `devboard-manifest.json` with that tag, version, and artifact SHA-256. A live dashboard
  started from the published revision reports the release through `versionState`.

## Boundaries

- Work only in a git worktree under `<repo root>/.worktree/`; never edit the opened checkout.
- Harness mode: every edit stays under `.devboard/`. Host files at the repository root, `adrs/`,
  and `GOAL.md` stay byte-identical. Leave the concurrent uncommitted changes in the opened
  checkout — `.devboard/crates/devboard/src/ask_mode.rs` and the `.omp/skills/*` deletions —
  alone, and start the worktree from the integration branch, not from them.
- Allowed source files: `.devboard/crates/devboard/src/goal_drafts.rs`,
  `.devboard/crates/devboard/src/workers/goal_draft.rs`,
  `.devboard/crates/devboard/src/detached_run.rs`,
  `.devboard/crates/devboard/src/supervision.rs`,
  `.devboard/crates/devboard/src/workers/watchdog.rs`,
  `.devboard/crates/devboard/src/resources.rs`, the Rust tests under
  `.devboard/crates/devboard/tests/`, and `.devboard/README.md`.
- Forbidden: any edit to `.devboard/client/**`, `.devboard/contract/**`, `../DESIGN.md`,
  `.devboard/omp/**`, `install.sh`, an installed host, or the harness release workflow; any new
  WebSocket frame type or state-file key visible on the wire; any change to the resources budget,
  the slice accounting, the proof-based orphan-kill rule, or the release path; any file, cache,
  log, worktree, or test fixture outside `<repo root>` (fixtures go under
  `.devboard/.test-tmp/` or `.devboard/.tmp/`).
- Never kill, spawn, or relaunch the production dashboard by hand. Only test-owned dashboard and
  owner processes under `.devboard/.test-tmp/` may be started and killed.
- Never re-run `.devboard/goal-proposals/gitea-only-forge-gh-push-mirror.md`, never edit it, and
  never hand-publish or hand-dispatch the release workflow.

## Stop conditions

- Effort is uncapped: no attempt limit and no token or time budget. Continue until every success
  criterion is verified.
- Halt and surface, rather than proceed, for: genuine ambiguity; a risky or irreversible operation
  (a wire-format change, a contract-corpus change, a slice-budget change, a new release path); a
  missing prerequisite (a live Gitea, the Release Train worker, a dashboard serving this checkout);
  or a blocked external dependency (GitHub or Gitea unreachable, the release workflow red, the
  Release Train not publishing).
- Never weaken a documented guarantee to make a criterion pass: the frame contract, the contract
  corpus, the resources reserve, the reaper's process-proof rule, or the Release Train's exclusive
  publish path. If a criterion cannot be met without weakening one, stop and report the conflict.

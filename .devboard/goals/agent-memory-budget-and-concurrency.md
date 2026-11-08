## Objective

On this repository's Devboard harness (`.devboard/`), a resource governor must prevent any agent
fan-out from exhausting the host's memory. On Linux, every worker, run owner, and `omp acp` peer
the dashboard starts runs inside a transient `devboard.slice` whose `MemoryHigh` and `MemoryMax`
are derived from system RAM; on macOS the same governor enforces the concurrency cap and
admission control without a cgroup. A single global cap, shared by the Issues worker, every
background family, goal/flow/discover runs, the Release Train, and manual runs started from the
dashboard, defers a new start while the cap or the memory reserve is reached and admits it later;
running work is never killed for budget reasons except when the hard slice limit is reached. The
budget, cap, and reserve are auto-derived, overridable by environment variables, editable in a
Devboard `Resources` tab, and persisted across restarts. A brief `## Resource limits` section in
`AGENTS.md` states the operator rules. The change is merged to `main`, pushed, released by the
Release Train, and proved live on this host.

## Success criteria

1. **Issues concurrency cap.** With a stub agent, five queued issues, and a configured cap of two,
   at most two peers run at once; the third starts only after one finishes; no queue item is lost
   or marked failed. A regression test fails if a third peer starts early or if the queue drains.
2. **Global cap across surfaces.** With the cap at one and one goal run active, an Issues start
   and a flow or discover start are deferred; when the active run ends, the deferred start
   proceeds. The test covers Issues plus at least one non-Issues surface.
3. **Admission control.** A memory snapshot below the reserve defers every start; a snapshot at or
   above the reserve admits; a later recovered snapshot admits the deferred start. A fake memory
   reader proves all three.
4. **Deferral is recorded, not failed.** A deferred start appears in the worker's activity or the
   dashboard journal with the reason, is retried on a later tick, and never marks the run failed
   or kills a live peer.
5. **Budget derivation.** The defaults are `reserve = max(1 GiB, 25% of MemTotal)`,
   `max = 50% of MemTotal`, and `high = 80% of max`, with `DEVBOARD_MEMORY_HIGH_MB`,
   `DEVBOARD_MEMORY_MAX_MB`, and `DEVBOARD_MEMORY_RESERVE_MB` overriding them. The default agent
   cap is `min(4, max(1, cpus / 4))`, overridden by `DEVBOARD_MAX_AGENT_PEERS`. A unit test proves
   the formulas and overrides; the live slice's `memory.high` and `memory.max` match the values.
6. **Hard slice isolation (Linux).** A synthetic allocator started through the governor inside
   `devboard.slice` with `MemoryMax=128M` is killed when the slice reaches its limit; a canary
   process in the session cgroup survives; `systemd-oomd` logs no kill of the session. The test
   runs on this host and does not skip when `DEVBOARD_REQUIRE_SLICE=1`.
7. **Control plane survives.** The dashboard process is not inside `devboard.slice`; when the
   slice reaches `MemoryMax` and its processes are killed, the dashboard stays serving, records
   the kill, and can start a new run after the budget recovers.
8. **Membership.** While an Issues run, a goal run, and a flow run are active, every
   `devboard worker`, run owner, `omp acp` peer, and its `devboard` MCP child has a
   `/proc/<pid>/cgroup` path containing `devboard.slice`; the dashboard's own path does not.
9. **Settings.** The Devboard workspace exposes a `Resources` tab with max concurrent agents,
   memory high, memory max, and reserve. Saving persists across a server restart, an environment
   variable sets the default when no saved value exists, and the live slice properties update on
   save without a restart. A client test and a server test prove save, readback, persistence, and
   live application.
10. **macOS fallback.** The macOS path compiles and uses no cgroup or systemd call; the cap and
    admission control remain active. The release's macOS artifacts build; a `cfg` unit test
    proves the macOS memory snapshot parser.
11. **No regression.** These exit zero: `cargo fmt --check --all`,
    `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
    `bun run check`, `bun test --max-concurrency=1`, and
    `bun run build && bun scripts/embed-client.mjs`.
12. **AGENTS.md.** The root `AGENTS.md` carries a brief `## Resource limits` section;
    `cmp AGENTS.md .devboard/templates/host-AGENTS.md` exits zero; no other section changes.
13. **Push and release.** `git ls-remote origin refs/heads/main` names the integrated commit and
    `git status --short --branch` reports no commits ahead. The Release Train, never a manual
    `devboard publish`, publishes exactly one version; `versionState.running` equals it.
14. **Live proof.** After the release, with the dashboard running and a small budget (for example
    `MemoryMax=2G`) and cap of two, a stress of ten or more starts through the governor leaves at
    most two active, keeps the slice's `memory.current` at or below `MemoryMax`, keeps the session
    cgroup's `memory.current` below `MemTotal - reserve`, and produces no `systemd-oomd` kill of
    the session; the `Resources` tab reports the live values.

## Verification

- Criterion 11: run each command verbatim from `.devboard`; every invocation must exit zero.
- Criteria 1-5 and 9: `cd .devboard && cargo test --test resource_governor -- --nocapture`
  (test names: `concurrency_cap_defers_the_next_issue`, `global_cap_spans_goal_and_issues`,
  `admission_defers_below_reserve`, `budget_formula_and_overrides`,
  `settings_persist_across_restart`) and `cd .devboard && bun test client/lib/resources.test.ts`.
- Criteria 6-8: `cd .devboard && DEVBOARD_REQUIRE_SLICE=1 cargo test --test resource_governor
  slice -- --nocapture` (test names: `slice_memory_max_kills_inside_and_spares_session`,
  `dashboard_survives_slice_kill`, `peers_join_the_slice`). The test creates a transient
  `devboard.slice`, runs the allocator, reads `/proc/<pid>/cgroup`, and removes the slice.
- Criterion 5, live: `systemctl --user show devboard.slice -p MemoryHigh -p MemoryMax
  -p MemoryCurrent` and read `memory.high` and `memory.max` under the slice's `ControlGroup`.
- Criterion 7, live: read the dashboard's PID from the running server and `cat
  /proc/<pid>/cgroup`; after the kill, the PID is still alive and the journal records the kill.
- Criterion 6, live: `journalctl --since <start> --no-pager | grep -i 'systemd-oomd'` shows no
  `session-*.scope` kill; a canary process started in the session before the stress is still
  alive.
- Criterion 9: open the Devboard > Resources tab, save values, restart the server, and read the
  tab and the slice again; the values match.
- Criterion 12: `cmp AGENTS.md .devboard/templates/host-AGENTS.md` and `git diff --stat` shows
  only the intended section.
- Criterion 13: `git ls-remote origin refs/heads/main` must print the commit `git rev-parse HEAD`
  names after the merge; `git status --short --branch` must not report `ahead`. Query the Gitea
  API for the tag release at `$DEVBOARD_GITEA_URL`; the manifest asset names the version and each
  artifact's SHA-256; the GitHub release for the same tag carries the archives.
- Criterion 14: start the dashboard through its normal launcher; set the budget and cap in the
  Resources tab; run the stress harness the implementation adds; read the Resources tab,
  `/proc/<pid>/cgroup`, `systemctl --user show devboard.slice -p MemoryCurrent -p MemoryMax`, and
  the journal.

## Boundaries

Allowed:

- All work in `.worktree/<name>`; the goal file only in this session until hand-off.
- `.devboard/crates/devboard/src/**`, including a new resource-governor module and the spawn
  paths in `issues_mode.rs`, `workers/**`, `supervision.rs`, `detached_run.rs`, `app.rs`,
  `config.rs`, `protocol.rs`, and the goal/flow/discover/release-train run paths.
- `.devboard/crates/devboard/tests/**` for the new regression and slice tests.
- `.devboard/client/lib/**` and the Devboard workspace for the `Resources` tab, store, and
  protocol types.
- A stress harness under `.devboard/scripts/` or `crates/devboard/tests/` for the live proof.
- Root `AGENTS.md` and `.devboard/templates/host-AGENTS.md` for the brief `## Resource limits`
  section only.
- Runtime: a transient `devboard.slice` and transient scopes/units, cgroup and `/proc` reads,
  `journalctl` reads, the dashboard, and the Release Train.

Untouched:

- `adrs/`, `GOAL.md`, and every host project file.
- `.github/workflows/release.yml`, `.devboard/release-train/`, `.devboard/dist-workspace.toml`.
- The filing caps (`maxPerHour`, `maxPending`), error-issue dedup, and every prompt.
- `.omp/` and `.devboard/omp/`; no shipped file changes.
- `.devboard/AGENTS.md`; only the root contract and its template change.
- No persistent systemd unit file outside the repo; only transient slices, scopes, and units. If
  a persistent host file is required, halt and surface.
- No manual `devboard publish`, no hand-dispatched release workflow, no hand-kill or hand-spawn
  of the dashboard or any worker.
- No bypass path, no disabled cap in tests, and no weakening of the hard limit to make a test
  pass.

## Stop conditions

- Continue until every criterion is verified against current state. There is no attempt cap,
  token budget, or time limit.
- Halt and surface only for: a criterion that contradicts the code; an irreversible or
  destructive operation (force push, deleting worker state, hand-killing the dashboard); a
  missing prerequisite (no systemd user manager or cgroup v2 on this host, no Gitea token, a
  paused Release Train, no `omp` command); a blocked external dependency (GitHub release host
  unreachable, Gitea manifest unavailable); or a transient slice that cannot be created without
  a persistent host file.

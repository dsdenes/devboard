## Objective

On the Devboard harness in this repository (`dsdenes/devboard`, all code under `.devboard/`), the
Issues worker and the dashboard stop failing under their own load. A workspace test, release-suite
run, or CLI invocation never rewrites the live `devboard.slice`; a worker that stops unexpectedly
is restarted without operator action while an explicit Stop or Pause stays respected; creating a
goal no longer stops the Issues worker; the dashboard caches resolved forge facts and re-reads only
unresolved URLs, so a 30-minute soak stays at or below 120 Gitea requests/min with no `/issues`
request over 10 s; and the resource budget may use the host up to `MemTotal - operator reserve`,
with the reserve as the only hard protection for the desktop session and the peer cap operator-set
1..64. The change is merged to `main`, pushed, released by the Release Train, and proved live on
this host.

## Success criteria

1. **Live slice untouched by non-dashboard processes.** A regression test starts a canary in the
   live `devboard.slice` and runs, in order, `devboard resources stress --state-dir <scratch>
   --count 4 --hold-ms 100` with `DEVBOARD_MEMORY_MAX_MB=2048`, `devboard resources admit
   --state-dir <scratch>`, and `devboard worker <family> --repo <fixture> --state-dir <scratch>`.
   After each, `systemctl --user show devboard.slice -p MemoryMax` equals the pre-test value, the
   canary is alive, and `resources/kills.jsonl` has no new line. The test fails on the current
   commit.
2. **The 2048 MB rewrite is gone.** `a_low_memory_snapshot_defers_every_start_in_the_cli` and
   `global_cap_spans_goal_and_issues` in `tests/resource_governor.rs` no longer change
   `devboard.slice`; `cd .devboard && DEVBOARD_REQUIRE_SLICE=1 cargo test --test
   resource_governor` exits 0 with 0 ignored and 0 quarantined.
3. **Release suite clean.** `cd .devboard && cargo run -p devboard -- release-suite --dir
   .devboard` exits 0 with `0 fail` and `0 quarantined`, and the live slice's `MemoryMax` is
   unchanged across the run.
4. **Auto-resume.** With the Issues worker running (`enabled=true`, pid P), `kill -9 P`; within
   30 s a new `devboard worker issues` pid Q != P exists for the same repository and version, the
   state has `enabled=true`, `lifecycle` in `idle|running`, and `worker.pid == Q`. A dashboard Stop
   leaves `enabled=false`, `lifecycle=stopped`, and no new pid for 60 s. A Pause leaves
   `paused=true` and the pid alive.
5. **Goal creation preserves Issues.** With the Issues worker running, the goal-creation path
   leaves the worker pid alive, `enabled=true`, and its `updatedAt` advances; a unit test asserts
   the goal-creation preemption no longer includes the Issues gate (`abort_all_work` does not call
   `IssuesGate::abort_active_work`).
6. **Budget policy.** `Settings` with `MemTotal=96,468 MB` and `reserve=10,000 MB` accepts
   `memoryMaxMb=86,468` and rejects `86,469`; with `reserve=24,117 MB` accepts `72,351`;
   `maxAgentPeers` accepts 64 and rejects 65; the saved `{max:70000, high:60000, reserve:10000,
   peers:12}` is accepted; `AGENTS.md` and `.devboard/templates/host-AGENTS.md` `cmp` exits 0 and
   their `## Resource limits` section states the new rule; after a save, the live slice's
   `MemoryMax` equals the saved max.
7. **Desktop survives.** A synthetic allocator that fills the slice to `MemoryMax` is killed at the
   limit; a canary in the session cgroup survives; `journalctl` shows no OOM kill of
   `session-*.scope`; the slice's `memory.current` stays at or below `MemoryMax`.
8. **Forge rate bound.** A 30-minute soak with the dashboard open and the Issues worker running
   shows at most 120 dashboard requests/min in `/home/ds/gitea/log/gitea.log`, no `/issues`
   request over 10 s, the worker's `poll.error` null at the end, no new `[ui] Error notification:
   the forge read did not finish within 30000 ms` issue, and no `resource-kill` journal entry.
9. **Resolved facts cached.** A fake-reader test shows the second projection cycle requests only
   pending/unreadable URLs, still reports the resolved URL's state and version, and reads the
   release list at most once per cycle.
10. **No regressions.** `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D
    warnings`, `cargo test --workspace`, `bun run check`, `bun test --max-concurrency=1`, and
    `bun run build && bun scripts/embed-client.mjs` each exit 0.
11. **Push and release.** `git ls-remote origin refs/heads/main` names the integrated commit;
    `git status --short --branch` reports no commits ahead; the Release Train publishes exactly one
    version; `versionState.running` equals it; the release-suite report has 0 quarantined and 0
    fail.
12. **Live proof.** After the release, the dashboard and Issues worker run for 30 minutes; the
    worker is still running, the slice max equals the saved max, and criteria 7 and 8 hold.

## Verification

- Criterion 1: `cd .devboard && cargo test --test resource_governor slice_rewrite -- --nocapture`
  (the new test), plus the live commands it runs; after the test,
  `systemctl --user show devboard.slice -p MemoryMax` and
  `tail -1 .devboard/.tmp/resources/kills.jsonl` must show no new line.
- Criterion 2: `cd .devboard && DEVBOARD_REQUIRE_SLICE=1 cargo test --test resource_governor --
  --nocapture`; the output must list 0 ignored and 0 filtered out for the slice tests.
- Criterion 3: `cd .devboard && cargo run -p devboard -- release-suite --dir .devboard`; read its
  report and `systemctl --user show devboard.slice -p MemoryMax` before and after.
- Criterion 4: `cd .devboard && cargo test --test issues_mode auto_resume -- --nocapture`; live,
  read `.devboard/.tmp/issues/<key>/workers/<version>/state.json` and `ps -o pid,args -C devboard`
  after the SIGKILL and after Stop and Pause.
- Criterion 5: `cd .devboard && cargo test --test goal_authoring preemption -- --nocapture`; live,
  read the Issues worker state before and after a goal creation.
- Criterion 6: `cd .devboard && cargo test --test resource_governor budget -- --nocapture`;
  `cmp AGENTS.md .devboard/templates/host-AGENTS.md`; save the values in the Resources tab and read
  `systemctl --user show devboard.slice -p MemoryMax -p MemoryHigh -p MemoryCurrent`.
- Criterion 7: `cd .devboard && DEVBOARD_REQUIRE_SLICE=1 cargo test --test resource_governor
  desktop -- --nocapture`; `journalctl --since <start> --no-pager | grep -iE 'oom|Killed process'`
  must name no `session-*.scope` victim.
- Criterion 8: during the soak, count requests and durations from
  `/home/ds/gitea/log/gitea.log` with a script that selects the soak window and the dashboard's
  connections; read the worker state's `poll.error`; query the Gitea issues API for the exact
  timeout title; read `.devboard/.tmp/journal/*.jsonl` for `resource-kill`.
- Criterion 9: `cd .devboard && cargo test --test agents_mode forge_projection -- --nocapture`.
- Criterion 10: run each command verbatim from `.devboard`; every invocation must exit 0.
- Criterion 11: `git ls-remote origin refs/heads/main` must print the integrated commit;
  `git status --short --branch` must not report `ahead`; read `versionState` and the Gitea release
  manifest for the published tag.
- Criterion 12: the same 30-minute soak, reading the live state, slice, journal, and Gitea log.

## Boundaries

Allowed:

- All work in `.worktree/<name>`; the goal file only in this session until hand-off.
- `.devboard/crates/devboard/src/resources.rs`, `main.rs`, `workers/mod.rs`, `issues_mode.rs`,
  `agents_mode.rs`, `forge.rs`, `goal_authoring.rs`, `app.rs`, `protocol.rs`, `config.rs`,
  `state.rs`, `supervision.rs`, and the shared modules they import.
- `.devboard/crates/devboard/tests/resource_governor.rs`, `issues_mode.rs`, `agents_mode.rs`,
  `goal_authoring.rs`, `forge.rs`, and new test files for the criteria above.
- `.devboard/client/lib/resources.svelte.ts`, `DevboardResources.svelte`, and
  `resources.test.ts` for validation and readback.
- Root `AGENTS.md` and `.devboard/templates/host-AGENTS.md` for the `## Resource limits` section
  only; `.devboard/README.md` only where it states the changed budget, forge-read, or worker
  lifecycle behavior.
- Runtime: transient slices and scopes, `/proc` and cgroup reads, `journalctl` reads, the
  dashboard, the Issues worker, the Gitea API and log (read-only), and the Release Train.

Untouched:

- `adrs/`, `GOAL.md`, and every host project file.
- `.github/workflows/release.yml`, `.devboard/release-train/`, `.devboard/dist-workspace.toml`.
- Gitea's configuration and database under `/home/ds/gitea`; they are read-only evidence.
- `.omp/` and `.devboard/omp/`; no shipped skill or command changes.
- No manual `devboard publish`, no hand-dispatched release workflow, and no hand-kill or hand-spawn
  of the dashboard or a worker; the test's deliberate SIGKILL of one Issues worker to prove
  auto-resume is authorized.
- No test deletion, skip, filter, retry, or quarantine to make a suite pass; no bypass of the
  slice's hard limit.
- This goal supersedes only the 50% `memoryMax` cap and the `min(4, cpus/4)` peer ceiling in
  `agent-memory-budget-and-concurrency.md` criterion 5 and the `## Resource limits` section of
  `AGENTS.md`; every other criterion of that goal and every other goal stands.

## Stop conditions

- Continue until every criterion is verified against current state. There is no attempt cap, token
  budget, or time limit.
- Halt and surface only for: a criterion that contradicts the code or the new budget policy; an
  irreversible or destructive operation (force push, deleting worker state, hand-killing the
  dashboard); a missing prerequisite (no systemd user manager or cgroup v2, no Gitea token, a
  paused Release Train, no `omp` command); a blocked external dependency (GitHub release host
  unreachable, Gitea manifest or log unreadable); or a test that would need deletion, skipping,
  filtering, or a weakened limit to pass.

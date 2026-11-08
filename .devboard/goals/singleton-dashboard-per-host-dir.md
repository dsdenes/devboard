## Objective

This repository's Devboard harness (`.devboard/`) must serve each host directory with at most one
dashboard process, and must make the MATE top-panel icon (`desktop/devboard-launcher.py`) the
sanctioned operator path that clears this host's stray and orphaned dashboards before starting or
restarting exactly one. A second `devboard serve` for a host dir that a live dashboard already
serves must exit nonzero naming the live instance instead of starting; a confirmed replacement (a
start carrying the readiness marker the relaunch path already writes) stays allowed and transfers
the guard, so the host never serves two dashboards during a handoff. Through the same Rust code,
the icon keeps the newest dashboard that answers `/ready`, stops every other dashboard of this host
dir — terminating an unresponsive one only after a bounded probe grace — then runs the existing
orphan reaper for this host's scopes so children whose owner is gone are ended, while a detached
run with a live lease and a live older-version worker are never signalled. The rule is per host
dir: dashboards for two different host dirs remain legal, and nothing outside the served host dir
is stopped.

## Success criteria

1. **Refusal.** A second `devboard serve` whose resolved, canonical `--repo-dir` equals a host dir
   a live dashboard already serves exits nonzero within 15 seconds, and its stderr names that
   dashboard's `pid`, its `port`, and the repo path. The refused process starts no listener, writes
   nothing into the live dashboard's state (its `version.json` bytes and journal size are
   unchanged), and starts no worker. Test `a_second_start_for_the_same_host_dir_is_refused` and
   `refusal_names_the_live_pid_port_and_repo`.

2. **Identity is the host dir.** Port and state dir never defeat the guard: a second start for the
   same repo dir with `--port 0` and a different `--state-dir` is still refused, while two
   dashboards whose repo dirs differ both serve. Tests
   `a_different_port_and_state_dir_do_not_defeat_the_guard` and
   `different_host_dirs_each_serve`.

3. **Atomic.** Four `devboard serve --port 0` processes launched simultaneously for one host dir
   leave exactly one bound and ready; the other three exit nonzero with the refusal message. Test
   `concurrent_starts_leave_exactly_one_dashboard`.

4. **Crash-safe.** After a serving dashboard is `SIGKILL`ed, the next `devboard serve` for the same
   host dir binds and serves without manual cleanup, and `devboard instances status --repo-dir
   <host> --json` reports exactly that one. Test `a_killed_dashboard_never_blocks_the_next_start`.

5. **Replacement still works.** A start carrying `DEVBOARD_REPLACEMENT_READY_FILE` is admitted
   while the old dashboard holds the port: the replacement announces readiness, the old process
   exits, the replacement binds and serves, and exactly one dashboard remains. The existing
   `restartServer` tests, `runs`, and `relaunch` integration tests stay green. Test
   `a_confirmed_replacement_transfers_the_guard`.

6. **Instance surface.** `devboard instances status --repo-dir <dir> --json` prints one entry per
   live dashboard serving that host dir with `pid`, `port`, `ready`, and `repoDir`, ordered by pid;
   `devboard instances sweep --repo-dir <dir>` performs the sweep below and exits 0 when no stray
   for that host dir remains. These command names and flags are the contract the icon and the
   verification use.

7. **Sweep keeps the newest ready.** With several live dashboards for one host dir, a sweep stops
   every ready one except the newest by process start time that answers `/ready`, and never stops
   the only ready dashboard for the host. Tests `sweep_keeps_the_newest_ready_dashboard` and
   `sweep_records_the_kept_and_stopped_pids`.

8. **Sweep stops a hung instance.** A dashboard that is alive but fails `/ready` is signalled
   `SIGTERM` only after a probe grace of at least 5 seconds, then `SIGKILL` after the existing
   2-second kill grace. A dashboard answering `/ready` is never treated as hung. Tests
   `sweep_stops_an_unresponsive_dashboard_after_the_grace` and
   `sweep_never_signals_a_ready_dashboard`.

9. **Sweep is host-scoped and respects protection.** A sweep for one host dir leaves another host
   dir's live dashboard untouched; it ends a recorded child whose owner is dead, and it never
   signals a detached run with a live lease, a live older-version worker, or a verification
   fixture. The reap writes its pass line under the host's state dir. Tests
   `sweep_leaves_another_host_dirs_dashboard_alone`,
   `sweep_reaps_a_dead_owners_children`, and `sweep_spares_a_live_lease_and_an_older_version_worker`.

10. **The icon uses it.** `desktop/devboard-launcher.py` runs `devboard instances sweep --repo-dir`
    before it decides to start or restart, logs the sweep's kept and stopped pids to
    `desktop/launcher.log` ahead of its start or restart line, and never starts a dashboard while
    the subcommand reports one live. After one panel click with one dashboard running,
    `instances status --json` reports exactly one entry, and two rapid clicks still leave exactly
    one. Verified by the manual click steps in Verification.

11. **Guardrail text matches behavior.** Root `AGENTS.md` and `.devboard/templates/host-AGENTS.md`
    both name the panel icon among the sanctioned dashboard start/stop paths and remain
    byte-identical; `.devboard/AGENTS.md` no longer forbids the icon's sweep. `cargo test -p
    devboard --test docs` passes.

12. **Checks and release.** In the worktree, `cargo fmt --check --all`, `cargo clippy --workspace
    --all-targets -- -D warnings`, and `cargo test --workspace` all exit 0; existing
    `install_start` tests still pass. The change is merged to `main`, pushed, and released by the
    Release Train; the upstream tip names the integrated commit, `git status --short --branch`
    reports no commits ahead, and the published release's dashboard reports the released version
    as `running` in `versionState`.

## Verification

All commands run from `<repo root>/.worktree/<name>/.devboard` unless stated, against current
state.

Criterion 1-6, the guard, atomicity, crash, and replacement:

```bash
cargo test -p devboard --test instances
cargo test -p devboard --test runs
cargo test -p devboard --test relaunch
```

Criterion 7-9, the sweep:

```bash
cargo test -p devboard --test instances sweep
```

Criterion 6 and 3 against a live host, using the worktree's binary:

```bash
cargo build -p devboard
./target/debug/devboard instances status --repo-dir <host dir> --json
./target/debug/devboard serve --port 0 --repo-dir <host dir> --state-dir .tmp/refused-state 2>&1; echo $?
```

The second command must print one JSON entry per live dashboard; the `serve` must exit nonzero and
its stderr must name the live `pid`, `port`, and repo path.

Criterion 10, one manual click with one dashboard running:

```bash
./target/debug/devboard instances status --repo-dir <repo root> --json      # one entry, note pid/port
# click the Devboard icon in the top panel once
./target/debug/devboard instances status --repo-dir <repo root> --json      # exactly one entry
grep -n 'instances sweep\|start:\|restart:' .tmp/desktop/launcher.log
```

The log must show a sweep line naming the kept pid before the start or restart line, and the status
count must be 1 after the click. Click twice in quick succession: the status count is still 1 and
the launcher log shows the second run reporting the launcher lock.

Criterion 11:

```bash
cmp ../AGENTS.md templates/host-AGENTS.md
grep -n 'panel icon' ../AGENTS.md templates/host-AGENTS.md AGENTS.md
cargo test -p devboard --test docs
```

Criterion 12:

```bash
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p devboard --test install_start
git status --short --branch
git ls-remote origin refs/heads/main
```

The release is proven by the Release Train's recorded run for the integrated commit, its GitHub
assets and Gitea manifest checks, and a dashboard's `versionState` naming that released version as
`running`.

## Boundaries

Allowed to change, all under `<repo root>/`:

- `crates/devboard/src/**` — one guard/sweep module plus the `serve` ordering in `main.rs`, the new
  `instances` subcommand, and reuse of `supervision`, `workers/watchdog` discovery and reaping, and
  `mcp_server::discover_dashboards`;
- `crates/devboard/tests/**` — a new `instances.rs`, plus adjustments to `relaunch.rs`, `runs.rs`,
  or `install_start.rs` only where start ordering or a message changed;
- `desktop/devboard-launcher.py` — call `instances sweep`/`status`, log the result, keep its
  existing handoff and credential handling;
- root `AGENTS.md`, `.devboard/templates/host-AGENTS.md`, and `.devboard/AGENTS.md` for the
  guardrail wording only, keeping the two contract files byte-identical;
- `.devboard/README.md` only if it documents the start/stop paths.

Stays untouched:

- `client/`, `dist/`, `public/`, `contract/` — no client change is part of this goal;
- `desktop/install-panel-icon.py` and `desktop/devboard.desktop` — the panel wiring already exists;
- worker family locks, the resource governor, the Release Train, `publish.rs`, and the release
  workflow;
- detached-run semantics: a replacement still adopts live runs, and a run with a live lease or
  handoff is never ended by the guard or the sweep;
- `.omp/` and the installed mirror; host data at the root (`adrs/`, `GOAL.md`, `DESIGN.md`,
  `openui.json`, `stories/`, `design/`, `WATCHDOG.yml`);
- dashboards of other host dirs, and anything outside `<repo root>` — no temporary files, caches,
  or logs elsewhere.

Operating limits:

- The guard's identity is the canonical real path of the resolved `repo_dir`; a relative path, a
  symlinked path, a different port, and a different state dir all resolve to the same host dir.
- The guard is one held OS lock under `<host>/.devboard/.tmp`, released by the kernel on any exit,
  so a crash never leaves a stale refusal; a host where that path cannot be created fails closed
  with a diagnostic instead of starting unguarded.
- Refusal never signals anything. The sweep signals only another dashboard of the same host dir,
  or a process the reaper's own proofs already cover, using `SIGTERM` then `SIGKILL` after the
  existing kill grace; a doubt leaves the process alive and logs it.
- On a platform without `/proc`, the lock still enforces the singleton and the discovery, sweep,
  and reaper report themselves unavailable without signalling anything.
- The icon never kills the dashboard it keeps, never starts a second one, and its launcher lock
  keeps two clicks from racing.

## Stop conditions

Continue until every criterion above is verified against current state. There is no attempt cap
and no token, time, or cost budget.

Halt and surface only for: a genuine ambiguity this repository cannot resolve; a risky or
irreversible operation (a signal outside this host dir, ending a live run or lease, or work outside
`<repo root>`); a missing prerequisite (no `/proc`, no writable host `.devboard/.tmp`, no panel
available for the click proof); or a blocked external dependency (the Release Train cannot
publish).

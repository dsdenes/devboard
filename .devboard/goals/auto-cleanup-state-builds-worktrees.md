## Objective

This repository's Devboard harness (`.devboard/`, the canonical source checkout) must reclaim the
space its own runs leave behind, automatically, without ever deleting uncommitted work, a live
process's directory, credentials, or an unmerged commit. Three accumulations are in scope. First,
state directories: the watchdog sweep already deletes entries older than seven days, but
`.tmp/providers/` is exempt at any age and `.worktree/*/.devboard/.tmp` is not covered at all —
2.7 GiB and 35 GiB respectively in this checkout. Second, abandoned worktrees: `.worktree/` holds
142 registered worktrees plus 28 unregistered directories, and 14 of them are merged into `main`
with a clean working tree. Third, Rust build output: `.devboard/target/debug` is 47 GiB because
every harness build leaves a new ~350 MB `libdevboard-<hash>.rlib` and a ~260 MB `devboard-<hash>`
binary that cargo never garbage-collects. This goal gives each accumulation one deterministic
retention rule, applied by `devboard cleanup` and by the existing ten-minute watchdog cycle, with a
dry run that predicts exactly what a real pass removes.

## Success criteria

1. **Worktree state directories are covered.** The sweep's covered state directories include
   `<root>/.worktree/*/.devboard/.tmp` for the root passed to `run_cleanup`, in addition to today's
   canonical, sibling, and live-dashboard directories. A test seeds an old file in a worktree
   `.devboard/.tmp` and asserts it is a dry-run candidate and is removed by a real pass, and that
   the directory is listed once per real path.

2. **Provider transcripts obey the retention rule.** Inside every covered state directory, a
   transcript `providers/agents/<selection-dir>/sessions/<project>/<stem>.jsonl`, its sibling
   directory `<project>/<stem>/`, and files under `providers/agents/<selection-dir>/blobs/` are
   candidates once older than `7 * 24 * 60 * 60 * 1000` ms, and are removed by a real sweep; the
   same shapes modified one hour before the sweep survive. A test proves both directions.

3. **The floors hold.** No file under `providers/agents/**` whose mtime is less than 24 hours before
   the sweep's `now` is ever a candidate, and the 1,000 newest transcripts by mtime are never
   candidates, at any size. A test seeds an oversized tree and asserts both floors survive.

4. **The cap holds.** After a real sweep, `providers/agents/**` in a covered state directory is at
   most `1_073_741_824` bytes whenever evictable units exist outside the floors; eviction removes
   whole session units (transcript plus its sibling directory) oldest first and stops as soon as
   the tree fits. A test with an injected cap proves the post-sweep size and the surviving set.

5. **Orphan selection directories go.** `providers/agents/<dir>` is removed in full when `<dir>`
   with one trailing `-watchdog-dedup` stripped matches no `subscriptions[].id` in
   `<state>/providers/credentials.json` and no file inside it is newer than 24 hours. A directory
   whose base identifier matches a subscription is never removed, and a missing or unparseable
   `credentials.json` removes none. Tests cover all four cases.

6. **Durable state is untouched.** `providers/credentials.json`, `providers/selection.json`, and,
   in every selection directory that is not removed, `agent.db*`, `models.db*`,
   `skill-descriptions.db*`, `config.yml`, `mcp.json`, and `devboard-mcp.ts` survive every sweep at
   every age. `.tmp/state/`, `.tmp/journal/`, `.tmp/issues/`, `.tmp/flow/`, `.tmp/coach/`,
   `.tmp/goal-drafts/`, the watchdog's own files, `control/`, and the cycle's run directory keep
   today's exemptions. A test asserts each survives with every age set past the cutoff.

7. **Merged worktrees are removed.** A directory `<root>/.worktree/<name>` is removed when its HEAD
   branch is an ancestor of `main`, `git -C <path> status --porcelain` is empty, no live process
   has its working directory inside it, and it is neither the cleanup process's own directory nor
   the checkout the running dashboard serves. There is no idle gate: a worktree created from
   `main` a minute earlier is eligible, as chosen. A dirty worktree, an unmerged worktree, a
   detached HEAD, and a worktree with a live process inside are never removed. Tests cover each.

8. **Unregistered directories follow the same rule.** A directory under `.worktree/` that holds a
   `.git` file, is absent from `git worktree list`, has a branch that is an ancestor of `main`, and
   has an empty `status --porcelain` is removed with the same guards; `.worktree/.test-tmp` and any
   directory without `.git` are never touched. `git worktree prune` runs on every pass. Tests cover
   both.

9. **Branches are cleaned with the worktree.** After a removal, `git branch -d <branch>` runs when
   the branch is an ancestor of `main`. A branch with unmerged commits and no worktree checkout is
   kept until it is idle 30 days; then `git format-patch main..<branch>` is written under
   `.devboard/.tmp/worktree-cleanup/branches/<branch>.patch` and the branch is deleted. A branch
   checked out in any worktree is never deleted. Tests cover all three.

10. **Stale build duplicates are dropped.** Under `.devboard/target/debug/deps`, files whose names
    end in `-<16 hex>.<ext>` are grouped by `<stem>.<ext>`; in each group only the newest file by
    mtime survives, and the rest are removed. If `target/debug` still exceeds `21_474_836_480`
    bytes afterwards, the whole `target/debug` directory is removed. Neither pass runs while any
    `cargo` or `rustc` process is alive. The dedup pass leaves `target/debug/devboard` and every
    file outside `deps` in place; only the cap backstop removes them. Tests with a synthetic
    target tree prove the grouping, the cap, and the live-build refusal.

11. **One policy, two entry points.** `devboard cleanup --dry-run --root <root> --json` reports the
    state-dir, worktree, and build candidates that a following `cleanup --once --root <root>`
    removes, and the dry run changes no bytes and deletes no worktree. The watchdog cycle applies
    the identical rules: a worker test seeds an old transcript, an eligible worktree, and a
    duplicate build artifact, runs one cycle, and asserts the cycle's `report.json` names each in
    its `cleanup`, `worktrees`, and `builds` sections.

12. **The live machine is bounded.** After one real sweep of this checkout, with the pre-sweep
    digests and worktree list captured first: `du -sb .devboard/.tmp/providers/agents` reports at
    most `1073741824`; `du -sb .devboard/target/debug` reports at most `21474836480`;
    `providers/credentials.json` is byte-identical; `git worktree list --porcelain` names no path
    that does not exist; and no worktree whose branch is an ancestor of `main` and whose status is
    empty remains, except one with a live process inside it.

13. **Existing checks stay green.** In `.devboard`, `cargo test --workspace` exits 0 and
    `cargo clippy --workspace --all-targets -- -D warnings` exits 0.

14. **Docs match behavior.** `.devboard/README.md` states the seven-day transcript age limit, the
    1 GiB cap, the 24-hour and newest-1,000 floors, the orphan-selection rule, the worktree removal
    conditions and branch rules, the build dedup rule and its 20 GiB backstop, and that worktree
    `.tmp` directories are covered; no sentence claims `.tmp/providers/` survives at any age.

15. **Shipped.** The change is merged into `main`, pushed to the upstream tracking it, and released
    by the Release Train; `git ls-remote <remote> refs/heads/main` names the integrated commit,
    `git status --short --branch` reports no commits ahead of the upstream, and a dashboard's
    `versionState` reports the released version as `running`.

## Verification

Run each command against current state; each must produce the stated result.

```bash
cd .devboard && cargo test --workspace
cd .devboard && cargo clippy --workspace --all-targets -- -D warnings
cd .devboard && cargo test --test cleanup
cd .devboard && cargo test --test watchdog_worker
```

Criteria 1–6 — the state-directory retention tests exist and pass:

```bash
cd .devboard && cargo test --test cleanup -- --nocapture providers
cd .devboard && cargo test --test cleanup -- --nocapture durable
cd .devboard && cargo test --test cleanup -- --nocapture worktree_state
```

Criteria 7–9 — the worktree tests pass, each named for its guard:

```bash
cd .devboard && cargo test --test cleanup -- --nocapture worktree
cd .devboard && cargo test --test cleanup -- --nocapture branch
```

Criterion 10 — the build tests pass:

```bash
cd .devboard && cargo test --test cleanup -- --nocapture target
```

Criterion 11 — dry run predicts the real pass. Capture the JSON of both and compare the candidate
path sets; the dry run leaves sizes and worktrees unchanged:

```bash
cd .devboard && cargo run -p devboard -- cleanup --dry-run --root /home/ds/devboard --json
cd .devboard && cargo run -p devboard -- cleanup --once --root /home/ds/devboard --json
```

Criterion 12 — the machine is bounded and nothing durable moved. Capture first, sweep, then
assert:

```bash
sha256sum /home/ds/devboard/.devboard/.tmp/providers/credentials.json
cd /home/ds/devboard && git worktree list --porcelain \
  > .devboard/.test-tmp-worktrees-before.txt
cd .devboard && cargo run -p devboard -- cleanup --once --root /home/ds/devboard --json
sha256sum /home/ds/devboard/.devboard/.tmp/providers/credentials.json
du -sb /home/ds/devboard/.devboard/.tmp/providers/agents
du -sb /home/ds/devboard/.devboard/target/debug
cd /home/ds/devboard && git worktree list --porcelain | awk '/^worktree /{print $2}' | \
  while read -r path; do test -d "$path" || echo "missing $path"; done
cd /home/ds/devboard && git status --short --branch
```

Criterion 14 — the documentation claims:

```bash
cd .devboard && grep -n -A 40 '### State-directory cleanup' README.md
cd .devboard && grep -n -E '1_073_741_824|1 GiB|newest 1,000|24 hours' README.md
cd .devboard && grep -n -E 'orphan|21_474_836_480|20 GiB|worktree' README.md | head -40
```

Criterion 15 — the push and the release:

```bash
cd /home/ds/devboard && git ls-remote origin refs/heads/main
cd /home/ds/devboard && git status --short --branch
curl -s http://127.0.0.1:8080/api/version
```

## Boundaries

Allowed to change, all under `<repo root>/.devboard/`:

- `crates/devboard/src/workers/watchdog.rs` — the retention constants, the provider carve-out in
  `is_protected`, the worktree-`.tmp` coverage in `covered_state_dirs`, and the sweep that enforces
  the age, cap, floor, and orphan rules;
- one new module beside `watchdog.rs` (for example `workers/worktrees.rs` and
  `workers/builds.rs`) plus its wiring in `workers/mod.rs`, holding the worktree and build passes;
- `crates/devboard/src/main.rs` — the `cleanup` subcommand's new flags and JSON output only;
- `crates/devboard/src/agent_sessions.rs` only to reuse or re-export `SESSION_MAX_FILES` as the
  newest-1,000 floor; its parsing, listing, and search behavior stays as it is;
- `crates/devboard/tests/cleanup.rs` and `crates/devboard/tests/watchdog_worker.rs` — the new
  proofs;
- `README.md` — the "State-directory cleanup" section, the worktree and build-cleanup sections,
  and the providers sentence that describes what cleanup may remove.

Stays untouched:

- the Svelte client, `dist/`, and the wire protocol — the change adds no setting, no field, and no
  control; every bound is a code constant;
- `providers/credentials.json` content, `providers/selection.json`, and the per-selection
  databases of a live selection directory;
- `.tmp/state/`, `.tmp/journal/`, `.tmp/issues/`, `.tmp/flow/`, `.tmp/coach/`, `.tmp/goal-drafts/`
  and the watchdog's own state — their exemptions and the journal's separate 7-day / 1 GiB prune
  stay exactly as documented today;
- every other worker family, the release workflow, `scripts/publish.ts`, and the source-refresh
  path;
- any worktree whose branch is not an ancestor of `main`, any worktree with a non-empty
  `status --porcelain`, any branch checked out in a worktree, and any directory under `.worktree/`
  without a `.git` file;
- `.test-tmp`, `.design/`, `node_modules`, `dist/`, and every path outside `<repo root>` —
  including `/home/ds/.local/share/kilo/worktree-pool/...`, which git lists but containment
  forbids touching;
- host data (`adrs/`, `GOAL.md`, `DESIGN.md`, `openui.json`, `stories/`, `design/`, `WATCHDOG.yml`),
  the root `AGENTS.md`, `.devboard/omp/`, and the installed `.omp/` mirror;
- anything outside `<repo root>` — no temporary files, caches, or logs elsewhere.

Operating limits:

- Worktree removal uses `git worktree remove` for a registered worktree and a directory removal
  for an unregistered one after `git worktree prune`; it never uses `--force`.
- A removal pass runs no git command inside a worktree that a live process holds, and skips the
  whole worktree pass when `git status` cannot be read.
- The build pass reads no target tree while a `cargo` or `rustc` process is alive, and a missing
  or unreadable `target/debug/deps` is reported, not treated as empty.
- The cap is enforced after the orphan and age passes, over the tree's remaining bytes, and stops
  once the tree fits or only floored units remain.
- Chosen consequence, recorded: with no idle gate, a worktree created from `main` is eligible on
  the next pass; the live-cwd guard is the only protection for an active session that has already
  committed nothing.

## Stop conditions

Continue until every criterion above is verified against current state. There is no attempt cap and
no token, time, or cost budget.

Halt and surface only for: a genuine ambiguity the repository cannot resolve; a risky or
irreversible operation (deleting a branch that is not an ancestor of `main` without its patch
written, deleting a live selection directory's databases, or touching any byte of
`credentials.json`); a missing prerequisite (no cargo toolchain, no writable state directory, no
git worktree metadata); or a blocked external dependency (the Release Train cannot publish).

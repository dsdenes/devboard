## Objective

The Devboard harness under `.devboard/` in this repository closes every capability gap recorded
in the 2026-11-04 catalogue, P0-1 through P2-9, in the Rust implementation and its installed-host
surface. Command dispatch is already complete (78 WebSocket commands, 36 MCP tools); this goal
closes the operational, worker-input, persistence, install/update/doctor, publish/release,
cleanup, supervision, and documentation gaps around that surface. The work applies to
`.devboard/crates/devboard`, `.devboard/tests`, `.devboard/contract`, `.devboard/shadow`,
`.devboard/README.md`, `.devboard/prompts`, `.devboard/omp`, and the Svelte client only where a
required backend frame is missing. It does not replace the client, reintroduce a
TypeScript/Bun/npm runtime, restore the Playwright suite, install a systemd watchdog timer, or
hand-run `devboard publish` or the release workflow; the Release Train owns publishing.

## Success criteria

Every criterion below is binary and must be proven by the stated test, command, or probe. A
criterion is not met by a code change alone.

**P0 — blockers**

- **P0-1a Dashboard discovery.** A dashboard started with `devboard serve --repo-dir <fixture>
  --port <free>` is discovered by `devboard worker watchdog --collect --dry-run --repo <fixture>`
  as exactly one instance with that pid and port; `devboard mcp` `devboard_status` from the
  fixture returns the same `dashboard.pid` and `dashboard.port`; `devboard cleanup --dry-run
  --root <fixture>` covers that dashboard's `STATE_DIR`; a second Rust dashboard for a different
  repository is not merged into the first. Tests use `devboard serve`, not `bun server/index.ts`.
- **P0-1b Credential publication.** A dashboard started without `DEVBOARD_DASHBOARD_TOKEN` exports
  the generated token into its own process environment: `/proc/<pid>/environ` contains
  `DEVBOARD_DASHBOARD_TOKEN=<token>` and `DEVBOARD_BOOTSTRAP_TOKEN=<bootstrap>`; an MCP control
  tool reaches `/ws` with `Authorization: Bearer <token>` and answers the expected state instead
  of 401; `devboard install <host> --port <n>` prints the `?bootstrap=` URL and that URL answers
  200 with the dashboard cookie.
- **P0-2 API Standards.** On a clean Rust harness checkout with no `.devboard/server` directory,
  API Standards Start preflight succeeds; `devboard worker api-standards --once --repo <repo>
  --state-dir <dir>` writes `request.json` whose `sourceDir` is `.devboard/crates/devboard/src`,
  whose `sources` entries end in `.rs` and exclude test files, and whose route inventory contains
  `POST /feedback`, `GET /ready`, `HEAD /ready`, `POST /goal-proposals`, the `/ws` upgrade, and the
  static fallback; a seeded MUST-level violation in that Rust surface files exactly one
  `api-standards` issue with a Rust path and line range.
- **P0-3 Watchdog deduplication.** A manual `devboard worker watchdog --once --repo <fixture>
  --state-dir <dir>` with an enabled OpenCode Go subscription in the provider store and no
  inherited `PI_CODING_AGENT_DIR` runs one dedup turn, writes `dedup-records.jsonl` and
  `dedup-reads.jsonl`, and files one issue for one unique candidate; a peer that answers 401 on
  the first binding rotates to the next binding; the peer deadline is 240000 ms; a peer that
  produces no records leaves the candidate pending and files nothing.
- **P0-4 Graceful shutdown.** A dashboard holding a stub ACP child, a running Discover staging
  directory, and dirty state receives `SIGTERM`; within 5 seconds the child is gone, the staging
  directory is removed, the state file is valid and persisted, and no `devboard worker`, `devboard
  acp-stub`, or `omp acp` child of that dashboard remains. The same cleanup runs on `SIGINT`; a
  replacement restart preserves handoff and staging instead of deleting them.
- **P0-5 Install start.** `devboard install <temp-host> --port <free>` exits 0, prints one
  bootstrap URL, and leaves exactly one dashboard process for that host; `/ready` with the printed
  token answers 200; opening the printed URL answers 200; a stale dashboard on the same port is
  replaced; a second `install --port` starts no second dashboard; a child that fails to bind makes
  the command exit nonzero with the bind error.
- **P0-6 Persisted agent snapshots.** With persisted watchdog, MCP optimizer, and Release Train
  worker state, settings, ledger, and projection present and no live dashboard, `devboard mcp`
  `background_agents_list` reports each agent's persisted lifecycle, `attached`/`owned`/`enabled`,
  cadence `lastRunAt`/`nextRunAt`, limits, filed issues, pending count, sync state, and
  cycle/activity detail; `background_agent_get` returns the same record for that id.

**P1 — major regressions**

- **P1-1 Complexity retention.** An old `<STATE_DIR>/complexity/<repo-key>/<date>.json` is absent
  from `devboard cleanup --dry-run` candidates and still exists after `devboard cleanup --once`;
  the same holds for the newer worker state directories (`api-standards`, `dead-code`,
  `single-responsibility`, `consistent-naming`, `mcp-optimizer`, `release-train`).
- **P1-2 Restart state machine.** A failed replacement removes the detached and goal-draft
  handoff files, keeps the old process serving, broadcasts one `versionState` carrying the failure
  and both versions, and leaves no page stuck in `serverRestarting`; a second `restartServer`
  while one is in progress is refused with `A server restart is already in progress.`; a
  when-idle restart broadcasts `upgradePending` and a later failure broadcasts `error`; a restored
  `restartWhenIdle` resumes waiting instead of being ignored; a damaged state file sends one
  `error` frame to the first client before any restored state.
- **P1-3 Install/update/doctor lifecycle.** Each of the following is proven by a fixture:
  - `devboard install` inside the canonical source checkout exits nonzero and changes no byte.
  - `devboard install` over a host whose `.devboard` tree is git-tracked refuses the operation.
  - Repairing a symlinked `.devboard` prefix preserves `<prefix>/.tmp` journal, locks, run state,
    and `source-refresh/applied.json`; `update` refuses a symlinked prefix.
  - A tracked `AGENTS.md` deleted by the host stays absent and is reported as drift.
  - `--force` overrides a differing unmarked wrapper; without it the run refuses.
  - A `git ls-files` failure refuses install instead of treating files as untracked.
  - `devboard doctor` checks `omp --version`/`omp usage`, the git root, release artifact
    download and SHA-256, installed vs latest version, the live dashboard's pid, port, and
    `/ready`, reports tracked drift as drift, names every failing check, and exits nonzero on
    each bad fixture.
  - `GITEA_URL` alone lets `devboard update` and `devboard doctor` resolve releases.
  - An offline or rate-limited update journals `activity`, not `update-error`.
  - An update syncs `.omp/commands`, `.omp/extensions`, prompts, and skills from the installed
    prefix before reporting the install.
- **P1-4 Publish/release verification.** `devboard publish` refuses a `dist` older than its
  sources, a `dist/index.html` that references a missing `/assets/...` file, a manifest without a
  matching `devboard-manifest.json.sha256`, and a manifest whose version differs from its tag;
  each refusal exits nonzero with a named reason and writes no source-refresh request. The
  agents' Shipped column uses bounded `HEAD` history and only published release tags, so an
  unlanded commit or a non-release tag never settles an issue.
- **P1-5 Design preflight.** Design System Start succeeds with `git` and `gh` on PATH and no
  `bun` or `npm`; it still refuses missing `.devboard/client`, `index.html`, `DESIGN.md`, or
  `design/tokens.json`, and it still refuses a GitLab origin.
- **P1-6 Process supervision.** `is_supervised_surface` recognizes `devboard serve`, `devboard
  worker <family>`, `devboard worker run-owner`, `devboard worker goal-draft`, and `devboard
  acp-stub`; `is_harness_supervisor` recognizes `devboard serve` and `devboard worker`; an
  orphaned Rust worker in verification scratch is reaped; a Rust dashboard ancestor protects its
  child from the reaper.
- **P1-7 ACP stub guard.** The ACP stub invoked with the harness checkout as its repository
  refuses `git add -A` and merge operations, logs the refusal, and leaves the harness checkout
  byte-identical.

**P2 — parity and documentation**

- **P2-1 Verification catalog.** The `verification_run` catalog `covers` includes `rust:fmt`,
  `rust:clippy`, and `rust:test`; MCP optimizer `is_trivial_command` recognizes those commands;
  a `cargo test` evidence row does not become a tool-gap family; the tool description names the
  Rust checks.
- **P2-2 Unknown live agent.** `background_agent_get` against a live dashboard for an unknown id
  returns `Unknown background agent: <id>.`, not `null`.
- **P2-3 Goal spec bytes.** `goal_spec_write` ends the file with exactly one `\n`; the bytes and
  the body `goal_draft_file` files match the recorded TypeScript fixture.
- **P2-4 Length units.** A label longer than 100 UTF-16 units is refused; a finding title longer
  than 200 code points is refused; emoji boundary cases match the TypeScript behavior.
- **P2-5 Session cache.** Repeated `agent_sessions_list` and `agent_session_search` over unchanged
  transcripts reuse cached headers and transcripts; a test seam proves no re-parse while output
  stays byte-identical.
- **P2-6 Static snapshot.** With `STATIC_DIR` set, a dashboard serves an immutable snapshot under
  `<STATE_DIR>/serving/<pid>-<version>`; replacing the source bundle does not change the bytes
  served until restart; snapshots of dead pids are pruned.
- **P2-7 Source-refresh identity.** A dashboard running a harness other than
  `<REPO_DIR>/.devboard` does not start the source refresher; a dashboard running that checkout's
  own harness does.
- **P2-8 Mutation host refusal.** `POST /feedback` and `POST /goal-proposals` with a valid
  credential and a Host the listener does not serve answer 403 with the TypeScript detail; `/ws`
  keeps 421; the corpus carries both cases.
- **P2-9 Stale references.** `README.md` no longer names `.devboard/server`,
  `server/fixtures/stub-agent.ts`, or a `worker.ts` entrypoint; every installed command path it
  names exists; `workers/issues.rs` no longer says “being ported”; every shipped worker `usage`
  string names `devboard worker`.

## Verification

Run every command from the repository root unless the command changes directory:

```bash
cd .devboard
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p devboard-contract
cargo run -p devboard-shadow -- --report ../shadow-report.json --window 60 --iterations 1
bun install --frozen-lockfile
bun run build
bun run check
bun test
```

Then prove the runtime criteria against fixtures under `.devboard/.tmp` or `.devboard/.test-tmp`:

```bash
# P0-1, P0-2, P0-4, P0-5, P1-1
devboard worker watchdog --collect --dry-run --repo <fixture>
devboard mcp                     # devboard_status, background_agents_list
devboard worker api-standards --once --repo <repo> --state-dir <dir>
kill -TERM <dashboard-pid>; sleep 5; pgrep -af 'omp acp|devboard worker'
devboard install <temp-host> --port <free>; curl <printed-bootstrap-url>
devboard cleanup --dry-run --root <fixture>; devboard cleanup --once --root <fixture>

# P0-3, P1-3, P1-4, P2-1
cargo test -p devboard --test watchdog_worker --test install --test doctor --test publish
cargo test -p devboard --test mcp_server --test mcp --test http_surface
```

For every criterion, the implementing change adds a regression test that fails on the current
tree and passes after the fix; where the criterion is observable, the exact live probe above is
also recorded in the test or its companion script. The final verification must show
`git status --porcelain` empty after the install, cleanup, and restart probes, and the contract
corpus and shadow report must report no unexplained divergence.

Completion also requires the repository's integration rule: the work is merged to `main`, pushed
to the upstream that tracks it, `git ls-remote <remote> refs/heads/main` names the integrated
commit, `git status --short --branch` reports no commits ahead, and the Release Train has
published the version with the GitHub assets and Gitea manifest verified. Do not run
`devboard publish` or dispatch the release workflow by hand.

## Boundaries

Allowed paths and operations:

- `.devboard/crates/devboard/**`, `.devboard/tests/**`, `.devboard/contract/**`,
  `.devboard/shadow/**`, `.devboard/bench/**`, `.devboard/README.md`, `.devboard/prompts/**`, and
  `.devboard/omp/**`.
- `.devboard/client/**` only for a frame or event a backend criterion requires; no client
  redesign, no new page, no visual refresh.
- One isolated worktree under `.worktree/<name>`; all builds and probes run there.
- Temporary fixtures under `.devboard/.tmp` or `.devboard/.test-tmp`; all writes stay inside the
  repository root.
- Contract changes are allowed only where a criterion explicitly requires the new behavior; the
  corpus is regenerated and reviewed in the same change.

Untouched:

- `adrs/`, `GOAL.md`, the host project outside `.devboard/`, and the root `AGENTS.md` except
  through `.devboard/templates/host-AGENTS.md` when the harness contract itself changes.
- Existing goal files under `.devboard/goals/`; never overwrite or delete one.
- Hand-edited `.omp/` files; edit `.devboard/omp/` and reinstall.
- No reintroduction of a TypeScript/Bun/npm harness runtime, no Playwright suite, no systemd
  watchdog timer installation, no npm package release, and no hand-run `devboard publish` or
  release workflow dispatch.
- No writes outside the repository root, including temporary files, caches, logs, and worktrees.

## Stop conditions

There is no attempt cap, token budget, time budget, or effort ceiling. Continue until every
success criterion is verified. Halt and surface the blocker only for genuine ambiguity that the
repository and this goal cannot resolve, a risky or irreversible operation, a missing
prerequisite such as a required credential or external service, or a blocked external dependency.
A failed check, a flaky test, or a failed Release Train attempt is not a stop condition; fix it
and continue. If a criterion can only be met by reintroducing a deliberately retired capability
or by changing an intentional behavior not named above, stop and ask before changing it.

## Objective

The Devboard harness under `.devboard/` reaches the state where every gap in the Rust
capability-gap catalogue is closed in the Rust implementation and its installed-host surface:
B1–B3, H1–H8, M1–M9, and V1–V5. The harness-runtime TypeScript that still pretends to be part of
the runtime is retired incrementally, one file at a time, only after its replacement behavior and
focused tests pass; the final state contains no harness-runtime `.ts` file, while the Svelte client,
its build tooling, and the six client-shared `lib/*.ts` modules remain. The historical browser/E2E
suite is explicitly retired and documented, not restored. The work applies to the `.devboard/`
harness and to a host tree produced by `devboard install`; it does not replace the client, the
decision corpus, or the release process.

## Success criteria

1. **B1 — extension commands survive without harness-runtime TS.** From a host installed by
   `devboard install`, `/implement-next-epic` and `/implement-goal-issue` remain available and
   execute their full lifecycle/issue behavior. No file under `.devboard/extensions/`,
   `.devboard/omp/extensions/`, or `.omp/extensions/` ends in `.ts`, no shipped command imports
   `../lib/forge-auth.ts`,
   `../lib/forge.ts`, or `../lib/gitea.ts`, and the installed command resolves without a Bun or
   Node runtime.
2. **B2 — no deleted forge-auth script is emitted.** No prompt, command, extension, or README line
   invoked by an agent contains `bun .devboard/scripts/forge-auth.ts` or
   `.devboard/scripts/forge-auth.ts`; every forge-auth invocation uses `devboard forge-auth`.
3. **B3 — container build.** `docker build -t devboard-gap-check .devboard` exits 0, the image
   starts `devboard serve`, `GET /ready` with the dashboard token answers 200, and the build needs
   no prompts/extensions files that the Dockerfile does not copy.
4. **H1 — Rust verification checks.** `verification_run` accepts `rust:fmt`, `rust:clippy`, and
   `rust:test`; it runs exactly `cargo fmt --check --all`,
   `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` from the
   resolved harness directory under the existing 900,000 ms and 16 KiB bounds. The existing
   `test`, `check`, `build`, `typecheck`, and `verify:<name>` semantics stay unchanged:
   `test` remains the Bun client-suite check, and the Rust workspace suite is `rust:test`. The
   unknown-check error names every accepted check.
5. **H2 — installed version state.** On an installed host, `getVersion`/`versionState.installed`
   equals the version in `<host>/.devboard/devboard.json`; `running` is the binary actually loaded;
   `stale` is true exactly when they differ; the reload control appears only for a failed
   replacement and names both versions.
6. **H3 — update starts the installed binary.** When a newer installed version exists, the
   replacement process starts `<host>/.devboard/bin/devboard`, not `current_exe()` when that path is
   a different binary. A failed replacement leaves the old process serving and journals one
   failure.
7. **H4 — release transport fallback and local source.** When a manifest asset URL on GitHub cannot
   serve the artifact and `DEVBOARD_GITEA_URL` is configured, install/update downloads the same
   version's Gitea artifact and verifies its checksum. `DEVBOARD_RELEASE_URL` serves a local
   manifest/artifact directory for offline verification. A failed download, checksum, auth, or
   install leaves the running harness intact and journals the failure.
8. **H5 — host sync applies package changes.** Install/update overwrites every changed package
   wrapper, extension, prompt, and `mcp.json`; it preserves a git-tracked host file (and reports
   drift) rather than overwriting it; a failed sync is journaled and retried on the next check.
9. **H6 — stale shipped files are removed.** Install/update deletes an untracked installed file
   under `.omp/commands`, `.omp/extensions`, `.devboard/prompts`, or `.devboard/extensions` that
   the current package no longer ships; a git-tracked stale file is preserved and reported as
   drift. A renamed command leaves only the new name in an untracked host.
10. **H7 — update and onboarding command.** `devboard update [host]` installs the latest release
    without requiring a browser click, exits 0, and leaves one dashboard version serving.
    `omp/commands/setup-devboard.md` names the native installer and `devboard install`/`devboard
    update`, not an npm package. `devboard install [host] [--port N]` accepts the documented
    options, is idempotent, and with `--port N` starts exactly one dashboard on `N` while
    replacing any previous dashboard for that host; without `--port` it installs only and prints
    the `devboard serve` command. A rerun starts no second dashboard, and `--port` is never
    treated as a host path.
11. **H8 — runtime harness resolution.** An installed binary resolves its harness directory from
    its own executable/prefix, not from compile-time `CARGO_MANIFEST_DIR`; `devboard_status
    .harnessDirectory` names a directory containing the installed manifest, and
    `verification_run` works from an agent worktree.
12. **M1 — dashboard-start reaping.** Every dashboard start performs one orphan-reaping pass
    before serving, journals the pass and every kill under `<STATE_DIR>/supervision/reaped.jsonl`,
    and never signals a live recorded child.
13. **M2 — source-checkout Gitea discovery.** A canonical source checkout whose origin is a
    loopback Gitea SSH address and whose `DEVBOARD_GITEA_URL` is unset discovers the lowest
    loopback Gitea HTTP origin; explicit `DEVBOARD_GITEA_URL`/`GITEA_URL` wins; an installed host
    never probes.
14. **M3 — proposed-goal naming.** `POST /goal-proposals` asks one bounded read-only ACP naming
    turn for a slug, uses the normalized slug, and falls back to the deterministic first-line slug
    when the peer times out, exits, asks a question, or returns no usable slug.
15. **M4 — MCP optimizer manual modes.** `devboard worker mcp-optimizer --once`,
    `--collect --dry-run`, `--json`, and `--now <ISO>` behave as documented. A dry run writes no
    ledger, report, issue, or control file; `--once` runs one real cycle under the worker lock.
16. **M5 — manual cleanup and watchdog uninstall.** `devboard cleanup --dry-run` and
    `devboard cleanup --once` sweep the documented state directories with the documented retention
    exceptions, and `devboard watchdog uninstall` stops, disables, and removes the legacy systemd
    unit and timer without touching repository files.
17. **M6 — doctor coverage.** `devboard doctor` checks release access, installed version and
    staleness, the running dashboard's pid and port, `.devboard`/`.omp` symlinks, and the last
    update failure; it exits nonzero and names the failing check for each bad fixture, and 0 for a
    healthy host.
18. **M7 — musl artifact selection.** A musl build selects the `*-unknown-linux-musl` archive for
    its platform, a gnu build selects the gnu archive, and an unsupported platform fails with one
    named error.
19. **M8 — publish inventory.** `devboard publish` prints one line per live dashboard with host,
    port, pid, running version, installed version, and stale flag, plus a summary count of
    dashboards and source-refresh requests written/failed.
20. **M9 — tracked payload safety.** Install/update preserves every git-tracked file under
    `.devboard/prompts` and `.devboard/extensions` byte-for-byte, reports it as drift, and never
    silently overwrites it.
21. **V1 — browser E2E retirement.** README states that the historical Playwright/browser
    `verify-*` suite is retired, names the coverage that replaces it, and no Playwright test or
    historical `verify-*.ts` script is added.
22. **V2 — shadow soak.** `cargo run -p devboard-shadow -- --report ../shadow-report.json
    --window 60 --iterations 1` compares every read live and every mutating command against its
    recorded corpus answer, state tree, and repository tree, reports at least one comparison per
    command, and reports `unexplained: []`. `bench/shadow-report.json` is regenerated from that
    run and carries no stale 100-comparison claim.
23. **V3 — contract coverage.** `contract/allowlist.json` no longer excludes `coach/`;
    `contract/events/versionState.json` carries an installed-host scenario as well as the source
    scenario; `contract/http` carries a successful `/goal-proposals` case; every contract test
    passes.
24. **V4 — no stale runtime references.** `prompts/`, `omp/`, `README.md`, `package.json`, and
    `scripts/` contain no reference to a deleted runtime path or command:
    `scripts/forge-auth.ts`, `scripts/verification.ts`, `server/index.ts`, `bin/devboard.mjs`,
    `bun run verify:`, `bun run cleanup`, `bun run watchdog`, `bun run mcp-optimizer`, or
    `bun run publish`. `prompts/implement-issue.md` names only checks that exist;
    `omp/commands/release-train.md` names `devboard publish`; every `package.json` script target
    exists.
25. **V5 — benchmark reproducibility.** The command documented in `bench/README` or
    `bench/report.md` runs from the current tree without `contract/serve-typescript.ts`, produces
    `bench/report.md`, and states the baseline commit or archived baseline it compared against.
26. **Cleanup — incremental per-file gate.** Each harness-runtime TypeScript file
    (`extensions/*.ts`, `omp/extensions/*.ts`, and any `.omp/extensions/*.ts` wrapper) may be
    deleted only after the replacement behavior and its focused tests pass. The final tree
    contains zero harness-runtime `.ts` files, `devboard install` writes none, and the Svelte
    client plus
    `lib/{agent-registry,dependencies,endpoints,goal-proposals,issue-labels,provider-catalog}.ts`
    remain and still build.
27. **Full gate.** `cargo fmt --check --all`, clippy with `-D warnings`,
    `cargo test --workspace`, `cargo test -p devboard-contract`, the client's
    `bun install --frozen-lockfile`, `bun run build`, `bun run check`, and `bun test` all exit 0.
28. **Repository done.** The change is merged to `main`, pushed to the canonical upstream, released
    by the Release Train, the integration checkout is advanced and published, and a live dashboard
    reports the released version as `running`.

## Verification

Run from the repository root unless a step changes directory. Every command is against the current
tree, not a remembered result.

- **Harness gate:** `cd .devboard && cargo fmt --check --all && cargo clippy --workspace
  --all-targets -- -D warnings && cargo test --workspace` exits 0.
- **Contract gate:** `cd .devboard && cargo test -p devboard-contract` exits 0, including
  `every_implemented_command_replays`, the HTTP table, and the event/command coverage tests.
- **Client gate:** `cd .devboard && bun install --frozen-lockfile && bun run build && bun run check
  && bun test` exits 0.
- **Container gate:** `docker build -t devboard-gap-check .devboard` exits 0; start the image with
  a scratch `/data` mount and a token, then `curl -fsS -H "Authorization: Bearer $TOKEN"
  http://127.0.0.1:<port>/ready` prints a pid.
- **Install/update gate:** create a host under `.devboard/.test-tmp/host.XXXXXX`, run
  `./target/debug/devboard install "$host"` twice, then `./target/debug/devboard doctor "$host"`;
  both installs exit 0, the second writes no byte, doctor exits 0, and the installed tree contains
  no `.ts` file under `.omp/extensions` or `.devboard/extensions`. Add a stale command file and a
  changed shipped command, rerun install, and assert the stale file is gone and the changed file
  matches the package.
- **Extension gate:** `cargo test --workspace extension_commands` drives the ACP stub through
  `/implement-next-epic` and `/implement-goal-issue` and asserts both commands exist in the
  installed tree and complete without importing a `.ts` runtime.
- **Verification-run gate:** `cargo test --workspace verification_run` drives the stdio MCP server
  with a stub `cargo`, asserting the exact argv, working directory, log path, output capture, and
  nonzero propagation for `rust:fmt`, `rust:clippy`, and `rust:test`, and that the existing
  `test`/`check`/`build`/`typecheck`/`verify:<name>` paths keep their current semantics.
- **Installed-version gate:** `cargo test --workspace installed_version` creates
  `<host>/.devboard/bin/devboard` plus `<host>/.devboard/devboard.json`, asserts
  `versionState.installed` equals the manifest version, `stale` changes when the loaded version
  differs, and the replacement program equals `<host>/.devboard/bin/devboard`.
- **Release transport gate:** `cargo test --workspace release_transport` serves a manifest whose
  GitHub URL fails and a Gitea asset with a matching checksum, asserts the Gitea artifact is
  installed; a second fixture proves `DEVBOARD_RELEASE_URL` works offline.
- **Sync gate:** `cargo test --workspace host_sync` proves changed wrappers are written, stale
  package files are removed, a git-tracked host file is preserved, and a failed sync is journaled
  and retried.
- **CLI gate:** `./target/debug/devboard update --help`, `./target/debug/devboard cleanup
  --dry-run --root .`, `./target/debug/devboard watchdog uninstall --help`, and
  `./target/debug/devboard worker mcp-optimizer --collect --dry-run --json --repo . --state-dir
  .devboard/.test-tmp/mcp-opt` each exit 0; the dry run writes no ledger, report, issue, or control
  file.
- **Doctor gate:** `cargo test --workspace doctor` asserts exit 0 for a healthy fixture and a named
  nonzero failure for a missing release, stale installed version, unresponsive dashboard, symlinked
  harness path, and recorded update failure.
- **Startup gate:** `cargo test --workspace startup` starts a dashboard against a state directory
  with a recorded dead child, asserts one reaping pass and one journal record, and asserts a live
  child is not signalled.
- **Discovery gate:** `cargo test --workspace gitea_discovery` proves a loopback fake Gitea is
  discovered from a source checkout, an explicit URL wins, and an installed host makes no probe.
- **Goal-naming gate:** `cargo test --workspace goal_slug` proves the ACP naming turn is invoked,
  the normalized slug is used, and every failure falls back to the deterministic slug.
- **Platform gate:** `cargo test --workspace platform_target` asserts musl→musl, gnu→gnu, and an
  unsupported pair→one named error.
- **Publish gate:** `cargo test --workspace publish` asserts the inventory lines and summary for two
  live dashboard fixtures.
- **Shadow gate:** `cd .devboard && cargo run -p devboard-shadow -- --report ../shadow-report.json
  --window 60 --iterations 1` exits 0 and its JSON has `unexplained: []`, one entry per command,
  and no excluded `coach/` prefix.
- **Contract coverage gate:** `cd .devboard && cargo test -p devboard-contract` passes with the
  installed `versionState` scenario and the successful `/goal-proposals` scenario; `rg -n '"coach/"'
  contract/allowlist.json` matches nothing.
- **Documentation gate:** `rg -n 'scripts/forge-auth\.ts|scripts/verification\.ts|server/index\.ts|
  bin/devboard\.mjs|bun run verify:|bun run cleanup|bun run watchdog|bun run mcp-optimizer|
  bun run publish' .devboard/prompts .devboard/omp .devboard/README.md .devboard/package.json
  .devboard/scripts` matches nothing.
- **Cleanup gate:** `find .devboard/extensions .devboard/omp/extensions .omp/extensions
  -name '*.ts' -print -quit 2>/dev/null` prints nothing, and
  `cd .devboard && bun run build && bun run check && bun test` still exits 0 with the six shared
  `lib/*.ts` modules present.
- **Benchmark gate:** `cd .devboard && bash bench/run.sh --rust target/debug/devboard --out
  bench/report.md` exits 0 without `contract/serve-typescript.ts`, and the regenerated
  `bench/report.md` names its baseline.
- **Release gate:** `git ls-remote origin refs/heads/main` names the integrated commit,
  `git status --short --branch` reports nothing ahead, the Release Train's newest run state names
  a released version, and a live dashboard's `getVersion` reports that version as `running`.

## Boundaries

- Harness mode. The edit root is `.devboard/`. Allowed paths: `crates/`, `client/`, `contract/`,
  `prompts/`, `omp/`, `extensions/` only for deletion after replacement, `scripts/`, `bench/`,
  `tests/`, `goals/`, `Cargo.toml`, `Cargo.lock` (generated), `package.json`, `bun.lock`
  (generated), `Dockerfile`, `.dockerignore`, `install.sh`, `dist-workspace.toml`, and
  `README.md`.
- `.omp/` at the repository root is regenerated only by `install.sh`; it is never hand-edited.
- `AGENTS.md` and `.devboard/templates/host-AGENTS.md` stay byte-identical. Edit the template and
  copy it to the root when contract text changes.
- The Svelte client and its TypeScript remain. Never delete `client/**`, `vite.config.ts`,
  `svelte.config.js`, `tsconfig.json`, `index.html`, `scripts/embed-client.mjs`, or
  `lib/{agent-registry,dependencies,endpoints,goal-proposals,issue-labels,provider-catalog}.ts`.
  Only harness-runtime `extensions/*.ts` and `.omp/extensions/*.ts` wrappers may be deleted.
- No new Playwright test, no restored `verify-*.ts` suite, and no browser-E2E gate. Verification
  stays on cargo, contract, client unit tests, CLI/HTTP smoke, Docker, and install/update fixtures.
- No new runtime dependency: the dashboard, workers, MCP server, install, update, and cleanup paths
  remain in the `devboard` binary. Bun remains only for client build and tests.
- Host data stays untouched: `adrs/`, `GOAL.md`, `.gitea/`, `.github/`, `.design/`, `DESIGN.md`,
  `design/`, `openui.json`, `stories/`, and every path outside `.devboard/`, `.omp/`, and the root
  `AGENTS.md`.
- `.github/workflows/release.yml` stays cargo-dist generated. The Release Train remains the only
  releaser; never run `devboard publish` or dispatch the release workflow by hand.
- Every scratch file, host fixture, state directory, worktree, log, and test artifact lives under
  `.devboard/.test-tmp/`, `.devboard/.tmp/`, or `.worktree/` inside the repository; nothing under
  `/tmp`, a home directory, or a parent checkout.
- The integration checkout is advanced only by the documented publish path. Preserve its
  uncommitted work; never discard it and never bypass the fast-forward.

## Stop conditions

- Continue until every success criterion is verified against the current tree. There is no attempt
  cap, no token budget, and no time limit.
- Halt and surface only for: a criterion that contradicts another criterion or the repository
  contract and cannot be resolved without an operator decision; a risky or irreversible operation
  (rewriting a release, tag, or history, force-pushing, discarding uncommitted integration-checkout
  work); a missing prerequisite (no `cargo`, `docker`, `omp`, forge credentials able to release, or
  a cargo-dist target that cannot build); or a blocked external dependency (GitHub/Gitea outage
  preventing the Release Train from verifying a release).
- Never weaken, narrow, or delete a success criterion to make a run pass. Report the criterion, the
  command, and the observed output instead.

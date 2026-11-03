## Objective

This repository's harness under `.devboard/` — the Devboard dashboard that serves the browser
interface, runs the Goal, Flow, Discover, Issues, Design, and Skills flows, supervises every
background worker family, and owns install, update, and release — becomes a Rust application whose
observable contract is an exact copy of the current Bun/TypeScript application. The contract is
recovered from behavior first: the single `/ws` JSON command and event protocol, `/ready`,
`/feedback`, `/goal-proposals`, static SPA serving with its host, origin, method, and
control-character refusals, the dashboard credential and cookie rules, the environment variables,
the `omp acp` and `git` children it spawns, and every durable file it writes under `STATE_DIR`.
The TypeScript implementation is readable while doing this, but only to explain a mismatch the
observations already exposed — never as the definition of correct behavior. The two dashboards run
side by side for as long as the operator wants: an external router keeps the TypeScript server the
only writer of durable state, mirrors read-only commands to Rust, and diffs every answer against a
machine-generated divergence report, so defects are fixed in Rust during the shadow period and no
command is cut over on faith. Cutover is per command, reversible by flipping back, and ends with
the TypeScript runtime deleted. Distribution moves off npm: cargo-dist builds the platform binaries
and one-command installers, GitHub Releases carries them publicly, Gitea remains the forge where
version control happens and the authority for release metadata, and each installed dashboard keeps
updating itself without an operator click. The finished harness installs with one command, needs no
Node, Bun, or npm at runtime, and reports its own measured latency, memory, and startup numbers
beside the TypeScript baseline it replaced.

## Success criteria

- A normative contract corpus exists under `.devboard/contract/`: one recording per dispatcher
  command name, one per server event type, one per HTTP path, method, and status family, plus an
  explicit nondeterminism allowlist naming each field excluded from comparison (identifiers,
  timestamps, pids, ports, absolute state paths). A test fails when a corpus command has no Rust
  handler, when a Rust handler has no corpus entry, or when the allowlist grows without an entry.
- Every corpus command replays against the Rust dashboard with byte-identical frames modulo the
  allowlist, and every command is exercised at least with one successful request, one malformed
  frame, and one unauthorized request.
- The HTTP surface matches: `/ready` answers GET and HEAD with `{pid}` and `Cache-Control:
  no-store`, any other method answers 405 with its `Allow` header, a non-GET `/ws` answers 405,
  a refused host or cross-origin upgrade answers 403, a static path containing a control character
  answers 400, and `/feedback` and `/goal-proposals` enforce the dashboard credential and answer
  HTTP 503 without `DEVBOARD_GITEA_URL`. The same table replayed against the TypeScript server
  passes before that server is removed, so the table itself is proven to describe current behavior.
- Every mutating command performed against a private `STATE_DIR` and `REPO_DIR` copy produces the
  same files at the same paths in the same formats as the TypeScript run, and starts the same
  child argv for `omp acp` and `git`. A recursive diff of the two state trees is empty modulo the
  allowlist.
- The dual-run router under `.devboard/shadow/` forwards every mutating command to the TypeScript
  server only, mirrors read commands to Rust, and writes one machine-generated divergence report
  per window. The Rust process is started with a copied state directory and never opens the live
  one for writing; a test asserts that wiring. During the operator's soak window every command is
  compared at least 100 times and no unexplained divergence remains.
- Cutover is per command through a configuration allowlist that needs no code change. The final
  allowlist names every command, a flip back of one command serves it from the TypeScript server
  again after a restart, and flipping it forward restores Rust with no state loss.
- When the goal is complete `.devboard/server/**` and the runtime half of `.devboard/lib/**` are
  gone, no dashboard process executes JavaScript or TypeScript, and a check finds no `from "bun"`
  or `node:` import outside test fixtures and the client build tooling. The Svelte client still
  builds, is embedded in the binary, and renders the same UI behavior.
- `.devboard/dist-workspace.toml` and its cargo-dist configuration produce linux x64 and arm64
  (gnu and musl) and macOS x64 and arm64 archives plus shell and powershell installers. `dist plan`
  lists exactly those artifacts, one release publishes them to GitHub Releases, and the same tag
  carries a Gitea release holding the manifest and checksums.
- A clean machine installs the harness with the released one-command installer, `devboard --version`
  reports the released version, `devboard install <host>` writes real `.omp/skills/devboard-*`,
  `.omp/commands`, `.omp/extensions`, `AGENTS.md`, and one `.gitignore` line, a rerun adds nothing,
  `devboard doctor` exits 0, and a one-byte change to a managed skill makes it exit nonzero.
- The npm distribution path is removed: nothing publishes `@dsdenes/devboard`, `bin/devboard.mjs`
  and the npm install, update, and verify scripts are gone or replaced by the Rust equivalents, and
  `AGENTS.md`, `.devboard/templates/host-AGENTS.md`, and `README.md` describe cargo-dist, GitHub
  Releases, and Gitea's release-metadata role instead. The root `AGENTS.md` and the template remain
  byte-identical, and the check that enforces it passes.
- The updater reads the Gitea release manifest at startup and every 60 seconds, installs a newer
  version, replaces the process without an operator click, reloads every connected page once, and
  never kills a live run or a background worker. An unreachable, invalid, or mismatched manifest
  leaves the running process serving and is journaled once per attempt.
- The Release Train keeps its gate, singleton, batching, and retry semantics, remains the only
  component that publishes, dispatches the cargo-dist workflow, and verifies the GitHub assets and
  the Gitea manifest before recording a version as released. `versionState` still reports `running`,
  `installed`, `latest`, `stale`, and `source` with the same status-bar labels.
- The six background worker families and the detached-run supervisor run as Rust processes with the
  same durable state, locks, drain handoff, multi-version coexistence, and post-replacement replay.
  The TypeScript tests that cover those semantics are ported and pass.
- A committed benchmark report holds both columns — TypeScript baseline and Rust — for p95
  read-command latency, idle and loaded RSS, cold start to `/ready`, full suite wall time, and the
  release path wall time, and reproduces on rerun. No threshold is a pass/fail condition in this
  goal; the report itself is the deliverable.
- New accepted decision records supersede `0001-interface-runtime-and-language`,
  `0003-browser-server-transport-and-api`, and `0008-deployment-and-hosting-target`; the existing
  record bodies are unmodified and `npx @adrkit/cli lint --dir adrs` exits 0.
- The container image builds from `.devboard/Dockerfile` on a Rust base, `docker run` answers
  `/ready` with its own pid, and no Bun image or `bun run server/index.ts` entry point remains.
- No repository text file gains a line longer than 768 bytes, and no file, cache, log, worktree, or
  test artifact is created outside the repository root.

## Verification

- `cargo fmt --check --all` and `cargo clippy --workspace --all-targets -- -D warnings` exit 0.
- `cargo test --workspace` exits 0 inside `.devboard/`, and the suite runs on a fresh checkout with
  no Node, Bun, or npm on `PATH`.
- `cargo test -p devboard-contract` replays the whole corpus and exits 0; a deliberately broken
  fixture makes it exit nonzero, proving the replay is not vacuous.
- `cargo run -p devboard-contract -- --compare-http <typescript-port>` reproduces the HTTP table
  against the TypeScript server while it still exists, and exits 0 before the TypeScript tree is
  deleted.
- `cargo run -p devboard-shadow -- --report .worktree/<name>/shadow-report.json --window <soak>`
  writes the divergence report; `read .worktree/<name>/shadow-report.json` is read to confirm the
  per-command comparison counts and an empty unexplained-divergence list.
- `cargo run -p devboard -- serve --port <free> --state-dir .worktree/<name>/state --repo-dir
  .worktree/<name>/repo` starts a private instance; `/ready` is fetched with the pid compared to
  the process just started, `/ws` is driven with recorded frames, and the process is stopped.
- `dist plan` and `dist build --artifacts=local` exit 0, and the listed artifacts match the
  platform matrix in the success criteria.
- `cargo run -p devboard -- install .worktree/<name>/host` then `cargo run -p devboard -- doctor
  .worktree/<name>/host` exits 0; `find .worktree/<name>/host/.omp -type f` lists the managed
  skills, commands, and extensions as real files.
- `bash .devboard/bench/run.sh --typescript <old-binary> --rust <new-binary>` writes the two-column
  report; the exact command appears in the report header so the numbers are reproducible.
- `npx @adrkit/cli lint --dir adrs` exits 0, and `npx @adrkit/cli show 0001 --dir adrs` reports the
  record as superseded by the new record.
- `docker build -t devboard-rust .devboard` succeeds and `docker run --rm -p <free>:8080
  devboard-rust` answers `GET /ready` with a pid.
- `git status --short --branch` inside the worktree reports no commits ahead of the upstream after
  the push, and `git ls-remote <remote> refs/heads/main` names the integrated commit.

## Boundaries

- Work happens in `.worktree/<name>` inside this repository, in harness mode: `.devboard/` is the
  edit root, plus the explicitly listed root files. The opened checkout is never edited directly.
- Allowed: `.devboard/**` (the new Rust workspace, the contract corpus, the shadow router, the
  benchmark, cargo-dist configuration, CI glue, tests, fixtures), `.devboard/Dockerfile`,
  `.devboard/package.json` and its lockfile only to delete or empty the npm publish path,
  `.gitea/workflows/**`, `.github/workflows/**`, root `AGENTS.md`,
  `.devboard/templates/host-AGENTS.md`, `.devboard/README.md`, and `adrs/**` for new superseding
  records only.
- Untouched: the visual behavior of `.devboard/client/**` beyond build wiring and the shared
  constants the client imports from the server tree; existing `adrs/0001`–`adrs/0012` bodies;
  `GOAL.md`, `DESIGN.md`, `openui.json`, `stories/`, `design/`, `.design/`; `.omp/` as a hand-edited
  tree (it is regenerated only by the installer); user host repositories; `.env` and every secret.
- Never: publish, deprecate, or unpublish an npm package; force-push, rewrite a published tag, or
  delete a release; run `bun run publish` or dispatch a release workflow by hand; spawn, kill, or
  relaunch the live dashboard that serves this checkout; write outside the repository root; or
  weaken a TypeScript test to make a Rust behavior pass.
- Verification processes run on a non-default port with a private `STATE_DIR` and `REPO_DIR` under
  the worktree, and never touch the live dashboard's port, state, or journal.
- The GitHub credential and the Gitea credentials are read from the environment; no token, cookie,
  or secret is committed, logged, or written into a fixture.

## Stop conditions

There is no attempt cap and no token or time budget; work continues until every success criterion is
verified against current state.

Halt and surface only for:

- genuine ambiguity that the corpus and the code cannot settle, or a contradiction between two
  success criteria;
- a risky or irreversible operation: anything that removes a published npm version, deletes or
  rewrites a release or tag, force-pushes, or discards uncommitted work in the integration checkout;
- a missing prerequisite: no GitHub or Gitea credentials able to create releases, no `omp` binary
  to verify the install path, or a cargo-dist release that cannot target a required platform;
- a blocked external dependency: a forge outage, an exhausted authenticated rate limit, or a
  failing upstream workflow that keeps the release unverified after retries;
- evidence that a contract behavior depends on a Bun-only or Node-only capability that no Rust
  stack reproduces, which needs a new decision record and an operator decision rather than a
  silent deviation.

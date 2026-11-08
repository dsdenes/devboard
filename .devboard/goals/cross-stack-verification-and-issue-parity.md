## Objective

The Devboard harness in this repository stops treating TypeScript as the only first-class
language on its two agent-facing paths. Its MCP verification tool gains first-class Rust
workspace checks, so `verification_run` can verify the TypeScript client and the Rust backend
under `.devboard/crates/` with the same result contract; and every background discovery family
that files issues maps each finding to both implementations of the same surface and states the
required action per side in the issue, so a Rust endpoint finding also names the TypeScript
client change that must land with it. The Issues worker's implementing run must then land both
named surfaces in one run and close only after both stacks' gates pass. Enforcement is
prompt-level by the developer's decision: no `issue_create` guard and no tracker-side rejection.

## Success criteria

1. `verification_run` accepts `rust:fmt`, `rust:clippy`, and `rust:test`. From the resolved
   harness directory it runs exactly `cargo fmt --check --all`,
   `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`,
   under the existing 900,000 ms bound and 16 KiB captured-output cap, and returns the existing
   `check`, `exitCode`, `output`, `truncated`, and `log` fields with the output also published
   to `<stateDir>/<check>.log`.
2. The unknown-check error names `rust:fmt`, `rust:clippy`, and `rust:test` in addition to
   today's `test`, `check`, `build`, `typecheck`, and `verify:<name>`.
3. Existing checks keep their exact semantics: `test` is `bun test [paths]`, `typecheck` is
   `bun run typecheck` or `bunx tsc --noEmit`, and `check`, `build`, and `verify:<name>` run the
   `.devboard/package.json` script. `dev` remains unreachable as a check.
4. An automated test proves the check selection and working directory without running the real
   workspace: with a stub `cargo` first on `PATH`, each new check invokes that stub with exactly
   the argv in criterion 1 from the harness directory; a stub that exits nonzero yields a
   nonzero `exitCode` and its stderr in `output`; and every invocation writes its own `log`.
5. `implement-issue.md` names the three Rust checks and the TypeScript checks and states three
   rules: when the issue names both surfaces, one run changes both and all applicable gates pass
   before `issue_close`; when it names one surface, only that stack's gates gate the close; and
   when `devboard_status` resolves the canonical `.devboard` while the run works in
   `.devboard/.worktree/`, the same commands run once from `<worktree>/.devboard` as the
   changed-revision fallback.
6. Each in-scope prompt's issue body template carries exactly these level-two headings in this
   order: `## Rust surface`, `## TypeScript surface`, `## Counterpart search`. Each surface
   section names repository-relative paths and symbols plus the exact action to take, or the
   literal `None` followed by the evidence that no counterpart exists. `## Counterpart search`
   names the shared identifier searched (HTTP method and path, event type, MCP tool name, CLI
   command, worker surface id, or named concept) and the searches actually performed.
7. The in-scope families are Auto Scout, API Standards, Dead Code, Single Responsibility, Design
   System, Watchdog, and MCP optimizer. `## Rust surface` and `## TypeScript surface` refer to
   `.devboard/crates/**` and to `.devboard/client/**` plus `.devboard/lib/**` respectively; a
   family whose finding is genuinely single-surface states `None` with its search evidence.
8. The Watchdog and MCP optimizer prompts permit read-only repository inspection (reading files
   and searching file contents) and still forbid writes, git commands, builds, tests, and
   installs; Watchdog keeps its no-shell rule and locates the counterpart with file and search
   tools.
9. API Standards audits the real HTTP surface and can start: the default audited source is the
   Rust server surface (the routing and handler files under `crates/devboard/src/`, with routes
   taken from the `http.rs` routing match or `crates/devboard-contract/src/http_table.rs`), the
   `.ts`-only source filter no longer drops `.rs`, and the route inventory contains
   `POST /feedback`, `POST /goal-proposals`, `GET /ready`, `HEAD /ready`, `GET /ws`, `GET /`,
   and the static-file fallback.
10. An API Standards finding on a Rust route names the TypeScript call sites that consume it,
    drawn from `.devboard/client/**` and `.devboard/lib/endpoints.ts`; a route with no client
    call site reports `None` with the search performed.
11. Every discovery worker's prompt command resolves to an installed command: the command text
    emitted by `prompt_for` for API Standards and Design System equals the name of a command file
    present in both `.devboard/omp/commands/` and `<host>/.omp/commands/`, and the README's
    command names match.
12. Cross-stack seeding holds on this checkout: the Auto Scout pool and the Dead Code and Single
    Responsibility pools each contain at least one `.rs` file and at least one `.ts` or `.svelte`
    file, and each pool can return a Rust path for some seed.
13. The MCP optimizer's generated prompt names the three surface headings and the explicit
    `None` rule, and its issue-body section list contains them in the required order.

## Verification

Run from the repository root; `.devboard` is the package root and the harness directory.

```sh
cd .devboard
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p devboard --test mcp_server
cargo test -p devboard --test audit_workers
cd ..
./.devboard/install.sh .
cd .devboard && cargo run -p devboard -- doctor
```

Prompt structure, one match per heading per file:

```sh
rg -n '^## (Rust surface|TypeScript surface|Counterpart search)$' \
  prompts/scout-recommendations.md prompts/api-standards.md \
  prompts/dead-code-removal.md prompts/single-responsibility.md \
  prompts/design-system.md prompts/watchdog-dedup.md
```

Command resolution: for each discovery family, the command text printed by its `prompt_for` has a
matching file:

```sh
test -f .devboard/omp/commands/<command>.md
test -f .omp/commands/<command>.md
```

API Standards behavior: `cargo test -p devboard --test audit_workers` includes a fixture checkout
with one Rust route file and one TypeScript call site and asserts both appear in the audit input,
the route inventory contains the expected routes, and the prompt carries the surface sections.

Verification tool behavior: the new `tests/mcp_server.rs` test drives the stdio server with a stub
`cargo` on `PATH` and asserts each check's argv, working directory, log file, output capture, and
nonzero-exit propagation, plus the expanded unknown-check error.

Seeding: the Rust tests for the entry-point pools assert the `.rs` and `.ts`/`.svelte` members over
this checkout.

## Boundaries

- Harness mode only. Edit and test inside `.devboard/`; refresh `<host>/.omp/` only by running
  `.devboard/install.sh`, never by hand-editing `.omp/`.
- Allowed files: `crates/devboard/src/mcp_server.rs`, `crates/devboard/src/mcp.rs`,
  `crates/devboard/tests/mcp_server.rs`, `crates/devboard/tests/audit_workers.rs`,
  `crates/devboard/src/workers/{api_standards,watchdog,mcp_optimizer,scout,dead_code,`
  `single_responsibility}.rs`, `crates/devboard/src/agents_mode.rs` only where the API Standards
  preflight or source directory requires it, `prompts/*.md`, `omp/commands/*.md`, and `README.md`
  only where it names the checks or the audit command.
- Untouched: the root `AGENTS.md` and `templates/host-AGENTS.md` (byte-identical), `adrs/`,
  `GOAL.md`, `.github/`, `contract/` (read-only), the release, publish, and version paths, the
  dashboard UI, the client's runtime behavior, the installed skills, and `issue_create` behavior.
  No new worker family, no new periodic agent, and no tracker-side rejection.
- Verification stays inside the repository; scratch output goes under `.devboard/.tmp/`, never
  `/tmp` or another path outside the root.
- The TypeScript surface means `.devboard/client/**` and `.devboard/lib/**`; the Rust surface
  means `.devboard/crates/**`. `shadow/` is named only when a finding actually reaches it.
- Prompt-level enforcement is the accepted limit: a non-compliant issue is not rejected after
  filing, and no test may depend on live forge writes.

## Stop conditions

- Continue until every success criterion is verified against the current tree. No attempt cap and
  no token or time budget.
- Halt and surface, with the exact failing command and output, only for a genuine ambiguity in
  the counterpart rule, a risky or irreversible operation, a missing prerequisite such as an
  absent `cargo` or `clippy` component, or a blocked external dependency. A live forge credential
  is not required: use fixture and stub tests instead.
- Never weaken or delete a success criterion to make a run pass; report the criterion, the command,
  and its output instead.

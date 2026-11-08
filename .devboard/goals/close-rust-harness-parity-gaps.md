## Objective

The Devboard harness under `.devboard/` in this repository reaches full behavioral parity with the
Bun/TypeScript harness recorded at git `8411b18d^`, and every capability that harness had but the
Rust port dropped is restored in Rust: a fresh `devboard install <host>` yields a working host
`.devboard` payload and prompt tree, the Watchdog files deduplicated issues, the dashboard gates
its document and readiness probe, Discover, Ask, and Flow runs survive a dashboard replacement,
the Complexity dashboard measures the Rust and client source, the issue, agent, and discover
divergences close, and the Release Train executes through a release agent that can quarantine a
flaky test without touching the tracked tree. The harness runtime, workers, release pipeline, and
quarantine mechanism stay Rust; only the agent-facing prompt and extension assets that the
TypeScript installer shipped remain as files on the host.

## Success criteria

- **Install.** `devboard install <host>` writes `<host>/.devboard/prompts/<name>.md` for every
  file under `.devboard/prompts/` and `<host>/.devboard/extensions/<name>.ts` for every file under
  `.devboard/extensions/`, each byte-identical; a second run writes no byte and adds no ignore
  line; `.devboard/install.sh` produces the same host tree as the binary for the same host.
- **Installed references resolve.** Every backticked `.devboard/prompts/<name>.md` in an installed
  `.omp/commands/*.md` names an existing file, and every `../../.devboard/...` import target in an
  installed `.omp/extensions/*.ts` names an existing file, for the tree of a host that had no
  `.devboard` directory before install.
- **Ignore lines.** The host `.gitignore` gains exactly `/.devboard`, `/.omp/commands`,
  `/.omp/extensions`, `/.omp/mcp.json`, and one `/.omp/skills/devboard-<name>` line per shipped
  skill; a rerun adds nothing.
- **Doctor detects drift.** `devboard doctor <host>` exits 0 on the installed tree and exits
  nonzero naming the path when one installed `.devboard/prompts` file or one `.devboard` extension
  file is deleted or changed.
- **forge-auth.** `devboard forge-auth check --required read --json` exits 0 and prints the forge
  host, project, and token source without the token; `--required write` against a read-only
  identity exits nonzero with a scope message; `devboard forge-auth exec --required write -- gh api
  user` runs the child with the selected token in its environment and never runs the child when the
  scope check fails.
- **No dangling authority.** `grep -rn 'scripts/forge-auth.ts' .devboard/prompts .devboard/omp`
  matches nothing, and `.devboard/prompts/forge-auth.md` names the `devboard forge-auth` command.
- **Readiness gate.** An unauthenticated `GET /ready` and an unauthenticated `POST /ready` both
  answer 401; an authenticated `GET /ready` answers 200 with `{"pid":<n>}`.
- **Document gate.** An unauthenticated `GET /` answers 401 with `WWW-Authenticate: Bearer` and no
  `Set-Cookie`; `GET /?bootstrap=<bootstrap value>` answers 200 with the cookie; a request carrying
  the cookie answers 200; the token never appears in a response body.
- **Host refusal.** A `Host` the dashboard does not serve answers 421 with title `Misdirected
  Request` on `/ws`, `/feedback`, and `/goal-proposals`; a missing or malformed `Host` answers 400.
- **Callers present the credential.** The launcher, the automatic replacement, the source-refresh
  replacement, and the update probe present the dashboard credential on `/ready`; the existing
  update and replacement tests pass unchanged in behavior.
- **Draft route.** `GET` and `HEAD` on `/goal-proposals/<name>` serve the draft's bytes with
  `Cache-Control: no-store` and a JSON content type; an unknown name answers 404; another method
  answers 405 with an `Allow` header.
- **Draft link.** The `links.draft.href` a `POST /goal-proposals` returns starts with `http://` or
  `https://`, fetches the draft with 200, and `draftPathFromHref` in `lib/goal-proposals.ts` accepts
  it; the POST also pushes `goalDrafts` to every connected page.
- **Reset gate.** While a reset is active every non-read-only command is refused with
  `An implementation reset is active.` and every read-only command still answers.
- **Failure replies.** An unexpected endpoint failure answers 500 with a fixed detail and journals
  one `server-error` record carrying the exception line; an unreadable static file answers 500 and
  journals, never 404; a feedback delivery failure journals `server-error`.
- **Flow header.** `X-Flow-ID` appears on `/ws` and endpoint answers and on no static asset answer.
- **Watchdog files.** A production cycle with a dedup peer files one issue per unique candidate,
  writes `dedup-records.jsonl` and `dedup-reads.jsonl` under the run directory, marks the ledger
  `filed`, and a second cycle with the same open issue files nothing.
- **Watchdog forges.** A checkout whose origin is Gitea files and comments through the Gitea REST
  API; a checkout whose origin is GitHub keeps using `gh`; an origin that is neither refuses with a
  named error instead of filing.
- **Watchdog root.** Filing from a subdirectory of a checkout fails with a named error instead of
  using the parent checkout's origin.
- **Issue dedup guards.** `issue_create` refuses a duplicate normalized title and a title longer
  than the cap for labels `dead-code`, `single-responsibility`, and `consistent-naming`, and names
  the guard in the error.
- **Consistent naming.** `getAgents` reports nine families including `consistent-naming`; the
  family starts, runs one audit cycle through `omp acp`, files `consistent-naming` issues, and
  appears in `background_agents_*`; the `entry_point` enum has five surfaces; the MCP catalog and
  the corpus recording agree with the shipped prompt, command, and skill.
- **Audit timeout.** An audit family cycle whose peer emits a session update every five minutes
  completes after 25 minutes of wall time; a peer that emits nothing for 20 minutes fails the
  cycle.
- **Ledger merge.** A ledger written by harness version A, then by version B, then read back,
  carries the entries of both versions.
- **Dropped goal issue.** A goal issue dropped by the poll but still open fails the run with a
  cooldown instead of re-queuing, and a poll that finds the issue closed settles it without a
  failure.
- **Abandon.** `abandon` refuses a run whose issue was closed by the run itself, verifies the goal
  issue with the tracker before settling, and records the dismissal so the issue is not picked up
  again.
- **Legacy ledger.** A frozen ledger written in the orchestrator's legacy shape is imported once on
  startup, and the run that reads it sees the handled issues.
- **Titles and lines.** Goal and watchdog title caps count UTF-16 units; a truncated activity line
  never panics on a multibyte boundary.
- **Locks.** A lock whose owner is alive on a platform without `/proc` is treated as live, and a
  lock whose owner is gone is reclaimed.
- **Forge sync.** A known row turns `stale` once the staleness interval passes without a successful
  read; retries exhaust after five attempts; no snapshot reports `ok` without a completed read.
- **Start bounds.** A Start whose preflight hangs answers within 20 seconds with a refusal rather
  than staying `starting`.
- **Page refresh.** A Single Responsibility page open pushes the worker `refresh` event, as Scout
  and Dead Code already do.
- **Prompt templates.** A changed open-issue read republishes the generated agent prompt templates
  with the new text.
- **Discover resume.** A clone or provider failure during resume reaches the page as
  `discoverError`; the interrupted run's `staging` directory is removed on restore and on graceful
  shutdown.
- **Discover inputs.** A second push with the same repository fingerprint and glossary reuses the
  cached usage analysis; symlinked usage files are counted; `! ' ( ) ~` in an overview link are
  percent-encoded; an unreadable skill file fails the publishing run; a failed steering-note write
  surfaces a flow error; glossary usage examples order case-insensitively.
- **Providers.** Two concurrent subscriptions to one provider key issue one upstream fetch.
- **Runs survive replacement.** Each Discover, Ask, and Flow run owns a detached process that
  writes `runs/<flow>/<id>/state.json`, survives a dashboard replacement, replays its state and
  activity to the reconnected page, receives the next answer in the same run, and stops when Stop
  is pressed; a stale lease from a dead owner is reclaimed.
- **Ask across replacement.** An Ask turn in flight during a replacement appends its streamed
  answer once and emits `askDone` once after the page reconnects.
- **No orphans.** A replacement terminates every recorded ACP peer of the replaced process, and no
  `omp acp` child of the replaced dashboard survives it.
- **Allowlist.** `contract/allowlist.json` no longer lists the `runs/` state prefix.
- **Complexity command.** `getComplexity` and the `complexityState` event exist, have corpus
  recordings, and the contract suite passes.
- **Complexity values.** The analyzer reports per-function cyclomatic complexity, source length,
  maximum block nesting, and parameter count; per-file lines of code, function count,
  duplicated-line ratio, and a 0-100 maintainability index; and the project aggregates the original
  goal lists, over `.devboard/crates/**/*.rs` and `.devboard/client/**/*.{ts,svelte}` excluding
  tests, `target`, `node_modules`, `dist`, `.tmp`, and `public`; two analyses of one unchanged tree
  are equal.
- **Complexity snapshots.** Exactly one snapshot per UTC calendar day is recorded at start and on a
  date change, under `STATE_DIR/complexity/<repo-key>/YYYY-MM-DD.json`; a restart, page open,
  reload, or reconnect on the same date records no second snapshot; snapshots replay oldest to
  newest.
- **Complexity page.** In Devboard mode the sidebar lists one entry directly after `Skills`; the
  page renders one card per project metric, one series per project metric with a point per recorded
  date and a marked latest point, and a per-file table whose metric columns sort; the existing
  `devboard-complexity` tab guard in `client/lib/layout.svelte.ts` is gone.
- **Release agent.** When the gate finds unreleased commits, the Release Train worker starts one
  `omp acp` peer with `/release-train <run-dir>`; the run state names the peer; Stop ends the peer;
  the prompt file `.devboard/prompts/release-train.md` is the instruction the peer receives.
- **Release suite.** `devboard release-suite` runs the workspace suite, retries at most nine times,
  skips for the rest of the run every test that failed three consecutive attempts, exits 0 with a
  report naming each skipped test's file and exact name, and leaves `git status --porcelain` empty
  and the tree byte-identical.
- **Structural failure.** A suite that cannot compile or that yields no per-test result exits
  nonzero, files no issue, and prints the first concrete error line.
- **Publish gate.** `devboard publish` runs the release suite before tagging and refuses to tag or
  dispatch the release workflow when the suite exits nonzero.
- **Quarantine issue.** A quarantining run files one issue per skipped test naming the file, the
  exact test name, and the failed attempt output, deduplicates by title, and never blocks the
  release when filing fails.
- **Quarantine documentation.** `AGENTS.md`, `.devboard/README.md`, and
  `.devboard/prompts/release-train.md` state the release-agent and quarantine policy.
- **Contract rows.** `contract/http/ready-get.json` records 401, `ws-refused-host.json` records 421
  with title `Misdirected Request`, and a missing-`Host` row records 400, each matching the
  TypeScript baseline at `8411b18d^`; every row passes against the Rust dashboard.
- **Package metadata.** `package.json` exposes no script whose target file is missing, and the MCP
  `verification_run` catalog lists only checks that exist.
- **Repository done.** The change is merged to `main`, pushed to the canonical upstream, released
  by the Release Train, and a live dashboard reports the released version as `running`;
  `AGENTS.md` is byte-identical to `.devboard/templates/host-AGENTS.md`.

## Verification

- `cd .devboard && cargo test --workspace` exits 0; the suite carries one test per criterion in the
  install, forge-auth, readiness, document, host, draft, reset, failure-reply, watchdog,
  consistent-naming, issues, discover, providers, runs, complexity, release-agent, release-suite,
  and quarantine groups.
- `cd .devboard && cargo clippy --workspace --all-targets -- -D warnings` exits 0.
- `cd .devboard && cargo test -p devboard-contract` exits 0, including
  `every_implemented_command_replays` and the HTTP table tests.
- `cd .devboard && bun test` exits 0, including the complexity page, draft-link, and sidebar tests.
- `cd .devboard && bun run build && bun run check` exit 0.
- `cd .devboard && cargo build && d=$(mktemp -d ./.test-tmp/host.XXXXXX) && ./target/debug/devboard
  install "$d" && ./target/debug/devboard doctor "$d"` exits 0; then deleting one file under
  `$d/.devboard/prompts` makes `doctor` exit nonzero naming it; then `git -C "$d" init -q &&
  git -C "$d" status --porcelain` lists nothing under `.omp` because the ignore lines cover it.
- `cd .devboard && cargo run -p devboard -- forge-auth check --required read --json` and
  `cargo run -p devboard -- forge-auth exec --required read -- env | grep -c TOKEN` prove the
  forge-auth criteria against the checkout's own origin.
- Live auth probe: start `./target/debug/devboard serve --port <free> --token <t>` in a scratch
  state directory, then assert with `curl` that `/ready` is 401 without and 200 with
  `Authorization: Bearer <t>`, that `/` is 401 without and 200 with `?bootstrap=<bootstrap>`, that
  `Host: evil.test` on `/ws`, `/feedback`, and `/goal-proposals` answers 421, and that a request
  without `Host` answers 400.
- Live draft probe: `POST /goal-proposals` with the bearer token, then `curl` the returned `href`
  and assert 200 plus `Cache-Control: no-store`; `curl -X PUT` the same path and assert 405.
- Install smoke with no pre-existing harness: the `mktemp` host above starts empty, and a script
  resolves every backticked `prompts/` path and every `../../.devboard/` import target in the
  installed tree.
- `cd .devboard && cargo run -p devboard-shadow -- --report ../shadow-report.json --window 1800
  --iterations 3000` reports `unexplained: []` for every command, including `getComplexity` and
  `getAgents` with nine families.
- Release suite fixtures: three crates under `.devboard/.test-tmp/release-suite-*` —
  always-failing, fails-once-then-passes, and compile-error — each driven through
  `cargo run -p devboard -- release-suite --dir <fixture>`, asserting exit code, the skipped-test
  report, the filing call, and `git status --porcelain` emptiness in that fixture.
- Release-agent test: `cargo test --workspace release_train` drives the gate against a fixture
  repository with the ACP stub and asserts the spawn argv contains `/release-train`, the run state
  names the peer, and Stop ends it.
- Runs test: `cargo test --workspace runs` starts a Discover run against the ACP stub, replaces the
  server through the relaunch path, reconnects, answers, stops, and asserts one state tree, one
  replayed activity stream, one `askDone`, and no surviving child process.
- Complexity test: `cargo test --workspace complexity` analyzes a fixture tree with known decision
  points, nesting, and duplication, asserts every metric, runs the analyzer twice for equality, and
  exercises the once-per-UTC-day rule with `DEVBOARD_COMPLEXITY_NOW` across a restart and a date
  change; `cd .devboard && bun test client/lib/components/Complexity` asserts the cards, series,
  table sort, and the sidebar position after `Skills`.
- Contract rows: `git show 8411b18d^:.devboard/server/app.ts` and
  `git show 8411b18d^:.devboard/server/dashboard-auth.test.ts` are the oracle for the recorded
  statuses; `jq -r .status .devboard/contract/http/ready-get.json` is `401`,
  `jq -r .status .devboard/contract/http/ws-refused-host.json` is `421`, and the missing-Host row is
  `400`.
- Repository done: `git ls-remote origin refs/heads/main` names the merged commit,
  `git status --short --branch` reports nothing ahead, the Release Train's newest run state names a
  released version, and a dashboard's `versionState` reports it as `running`.

## Boundaries

- Harness mode. The edit root is `.devboard/`: `crates/`, `client/`, `contract/`, `prompts/`,
  `omp/`, `tests/`, `bench/`, `goals/`, `install.sh`, `Cargo.toml`, `package.json`, and `README.md`.
- `.omp/` at the repository root is regenerated only by `install.sh`; it is never hand-edited.
- `AGENTS.md` at the repository root is edited only for the Release Train, runs, and quarantine
  policy sections, and must stay byte-identical to `.devboard/templates/host-AGENTS.md`.
- `.github/workflows/` is untouched unless a criterion above cannot hold without it, in which case
  `release.yml` stays cargo-dist generated and no test step is added outside the harness.
- `.tmp/legacy-ts` and `git show 8411b18d^:<path>` are read-only oracles; nothing is restored by
  copying TypeScript into the harness runtime, into `.omp/`, or into the installed host `.devboard`
  beyond the prompt and extension assets named in the criteria.
- Host data stays untouched: `adrs/`, `GOAL.md`, `.gitea/`, `.github/`, `adrs/`, and every file
  outside `.devboard/`, `.omp/`, and the two markdown files named above.
- Every scratch file, fixture, state directory, worktree, log, and test artifact lives under
  `.devboard/.test-tmp/`, `.devboard/.tmp/`, or `.worktree/` inside the repository; nothing is
  written under `/tmp`, a home directory, or a parent checkout.
- No new runtime dependency is required to run the dashboard or the installed host: the analyzer,
  quarantine, forge-auth, and run supervisor are compiled into the `devboard` binary.

## Stop conditions

- Continue until every criterion is verified against the current tree; there is no attempt cap, no
  token budget, and no time limit.
- Halt and surface only for: a criterion that contradicts another criterion or the repository
  contract and cannot be resolved without an operator decision; a risky or irreversible operation
  (rewriting a release, tag, or history, force-pushing, discarding uncommitted work in the
  integration checkout); a missing prerequisite (no forge credentials able to create a release, no
  `omp` binary, a cargo-dist target that cannot build); or a blocked external dependency (a forge
  outage, an exhausted authenticated rate limit, a workflow that keeps failing after the retry
  budget).
- A failing criterion is never satisfied by weakening it, deleting the test that proves it, adding
  an allowlist entry without a recorded reason, or narrowing the analyzed source set.

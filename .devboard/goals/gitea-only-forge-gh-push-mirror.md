## Objective

On this Devboard harness and this checkout, Gitea is the only forge the product queries. Every
forge operation the dashboard, its background workers, and the `forge-auth` wrapper perform —
open-issue reads, issue state, labels, release metadata, pull requests, and credential selection —
resolves to the checkout's Gitea origin and its token. `gh` (and `glab`) stays an operator tool
over a repository Gitea pushes to; Devboard never runs it for a forge operation, and never reads a
checkout whose origin does not resolve to a supported forge as GitHub. The Issues panel reports
the forge, the operation, and the concrete cause of a failed tracker read instead of only
"the tracker did not answer within 20000 ms". GitHub remains the public release-artifact host and
the push-mirror target exactly as `AGENTS.md` describes; release-artifact verification is not a
forge operation and is out of scope.

The affected surface is the harness under `.devboard/`: forge resolution in
`forge.rs`, the `forge-auth` wrapper in `forge_auth.rs`, the Issues worker and tracker in
`issues_mode.rs`, the forge-backed worker preflights, the Issues panel's error rendering, and the
harness tests that prove them.

## Success criteria

1. On this checkout, `forge-auth check --required write --json` prints JSON whose `forge` is
   `gitea`, whose `project` is this repository's `owner/name`, and whose `canWrite` is `true`; the
   invocation starts no `gh` and no `glab` process.
2. `forge-auth exec --required write -- <command>` on this checkout runs `<command>` with a
   non-empty `GITEA_TOKEN` in its environment, and starts no `gh` and no `glab` process.
3. The dashboard's Issues read on this checkout resolves to the Gitea HTTP API: the Issues
   Overview lists the repository's open issues, `[data-testid="issues-poll-error"]` is absent, and
   no `gh` process starts during at least two poll intervals.
4. Every forge-backed worker family on this checkout (Issues, Auto Scout, Design System, Dead
   Code, API Standards, Single Responsibility, Consistent Naming, MCP optimizer, Watchdog, Flow,
   Goal) selects Gitea for its forge preflight and issue/label/release-metadata/PR operation; none
   starts `gh` or `glab`.
5. When the checkout's origin does not resolve to a supported forge (no `origin` remote, an
   unparsable remote, or a root below the checkout top level), every forge path refuses with a
   message that names the origin as the reason; no forge read, mutation, subprocess, or HTTP
   request to a GitHub or GitLab host occurs, and the Issues panel error names the unresolved
   origin.
6. Every Issues-panel tracker error names the forge and the operation, and a failure with a known
   cause names that cause (connection refused, HTTP status, or authentication). The exact sentence
   "the tracker did not answer within 20000 ms" appears only for a read that exceeded its deadline
   with no earlier cause, and never alone: the deadline text also names the forge and operation.
7. A checkout whose origin names `github.com`, a GitLab host, or a GitHub Enterprise host pinned
   by `DEVBOARD_FORGE` keeps today's forge resolution and its `gh`/`glab` use; the existing tests
   for those origins pass unchanged.
8. `publish`, `release.rs`, `updates.rs`, and the Release Train still verify GitHub release assets
   and the Gitea manifest exactly as `AGENTS.md` describes; their code is untouched and their
   tests pass unmodified.
9. Every `gh`, `glab`, and GitHub-API call site under `.devboard/crates/devboard` is enumerated on
   the goal issue and marked either a forge path fixed by this work or a release-artifact path
   left untouched under criterion 8.
10. `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
    `cargo test --workspace`, and the client build/check commands listed under Verification all
    exit 0; the new regression tests fail on the pre-fix commit and pass on the fix.
11. The fix is merged to `main`, pushed to `origin`, and released by the Release Train; the live
    dashboard and Issues worker then satisfy criteria 3 through 6 without operator intervention.

## Verification

Set the paths once. `REPO_ROOT` is this checkout; every other path is inside it.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WT="$REPO_ROOT/.worktree/<task-name>"
PROOF="$WT/.devboard/.test-tmp/gitea-forge-proof"
```

Criterion 10, the harness's own checks, run from the worktree:

```bash
cd "$WT/.devboard"
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run build && bun scripts/embed-client.mjs   # when a client file changed
bun run check                                   # when a client file changed
bunx playwright test --config e2e/playwright.config.ts
```

Each command must exit 0. The last command is the operator suite; its global setup builds a
fixture whose origin names the live Gitea repository and starts a real dashboard on a free port.
New e2e cases prove criteria 3, 5, and 6 in the browser.

Criteria 1 and 2, a `gh`/`glab` recorder inside the repository; nothing here writes outside it:

```bash
mkdir -p "$PROOF/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$0.log"\nexit 1\n' > "$PROOF/bin/gh"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$0.log"\nexit 1\n' > "$PROOF/bin/glab"
chmod +x "$PROOF/bin/gh" "$PROOF/bin/glab"
: > "$PROOF/bin/gh.log"; : > "$PROOF/bin/glab.log"
cd "$WT/.devboard"
PATH="$PROOF/bin:$PATH" ./target/debug/devboard forge-auth check --required write --json
PATH="$PROOF/bin:$PATH" ./target/debug/devboard forge-auth exec --required write -- \
  sh -c 'test -n "$GITEA_TOKEN"'
test ! -s "$PROOF/bin/gh.log"
test ! -s "$PROOF/bin/glab.log"
```

The check prints `"forge":"gitea"` with `"canWrite":true`; the exec exits 0; both log files stay
empty.

Criterion 3 and 4, live, against a dashboard the verification owns. Reuse the e2e suite's fixture
dashboard (prepared under `.devboard/.test-tmp/e2e/`) or start a throwaway dashboard with
`--repo-dir` under `.devboard/.test-tmp/`, `--state-dir` under the same tree, `--port 0`, and
`DEVBOARD_DASHBOARD_SINGLETON_FIXTURE=1`, with `PATH="$PROOF/bin:$PATH"`. Read the printed
`ADR interface listening on http://127.0.0.1:<port>/`, then:

```bash
curl -s "http://127.0.0.1:<port>/issues"
```

The `issuesState` frame carries the repository's open issues and `poll.error` is `null`; after two
poll intervals `test ! -s "$PROOF/bin/gh.log"` and `test ! -s "$PROOF/bin/glab.log"` hold. Open
`http://127.0.0.1:<port>/` in a browser, select Issues then Overview, and confirm the issue list
renders with no `[data-testid="issues-poll-error"]` element. Start the Issues worker from that
throwaway dashboard, wait one cycle, and confirm the recorder logs stay empty; stop it afterwards.

Warning: criterion 5 needs a checkout whose origin does not resolve. Use a throwaway git repository
under `$PROOF/` (`git init`, no `origin`, one commit) as that dashboard's `--repo-dir`; its Issues
Overview must show an `[data-testid="issues-poll-error"]` whose text names the origin as the
reason, and both recorder logs must stay empty.

Criterion 6, a second throwaway dashboard over the same Gitea-origin fixture but with
`DEVBOARD_GITEA_URL` pointing at a closed loopback port (for example `http://127.0.0.1:1`) and any
non-empty `GITEA_TOKEN`. After one poll, `/issues` carries a `poll.error` that contains `Gitea`
and the connection failure, and `[data-testid="issues-poll-error"]` renders that text. Then run a
read against the real Gitea instance and confirm `poll.error` is `null`.

Criterion 7, same worktree, the origins that must not change:

```bash
cd "$WT/.devboard"
cargo test --workspace
```

This includes the existing GitHub, GitLab, and GitHub Enterprise resolver tests, which pass
without edits to their assertions.

Criterion 8, the untouched release-artifact paths:

```bash
cd "$WT"
git diff --stat -- .devboard/crates/devboard/src/publish.rs \
  .devboard/crates/devboard/src/release.rs .devboard/crates/devboard/src/updates.rs \
  .devboard/crates/devboard/src/workers/release_train.rs
```

The command prints nothing. The Release Train's own tests inside `cargo test --workspace` still
pass.

Criterion 9, the audit recorded on the issue:

```bash
cd "$WT/.devboard"
grep -rn '"gh"\|"glab"\|api\.github\.com' crates/devboard/src --include=*.rs
```

Every printed line is listed on the goal issue with its disposition; no line that serves a forge
operation on this checkout is left unaccounted for.

Criterion 11, after merge and push:

```bash
cd "$WT"
git status --short --branch
git ls-remote origin refs/heads/main
```

The status reports no commits ahead of the upstream, and the remote line names the integrated
commit or a descendant. The Release Train publishes one version carrying the fix; read
`versionState` from the live dashboard and the Release Train state, then repeat criteria 3 through
6 against the live dashboard and Issues worker.

## Boundaries

- Mode is harness: the edit root is `.devboard/` in this checkout. All work happens in
  `$REPO_ROOT/.worktree/<name>`; the opened checkout is never edited. Host files under `adrs/`
  and `GOAL.md` stay untouched.
- In scope: `.devboard/crates/devboard/src/forge.rs`, `forge_auth.rs`, `issues_mode.rs`, and only
  the forge branches of `agents_mode.rs`, `flow_mode.rs`, `design.rs`, `scout.rs`, `goal_run.rs`,
  `mcp_optimizer.rs`, and `workers/*.rs` that can select or spawn a non-Gitea forge for a Gitea
  origin, plus the Issues panel's error rendering under `.devboard/client/`, the harness tests
  under `.devboard/crates/devboard/tests/` and `.devboard/e2e/`, and the sentences in `AGENTS.md`,
  `.devboard/templates/host-AGENTS.md`, and `.devboard/prompts/` that this behavior contradicts.
  Keep prompt and documentation edits minimal and identical between `AGENTS.md` and its template.
- Out of scope and byte-untouched: `publish.rs`, `release.rs`, `updates.rs`,
  `workers/release_train.rs`, `dist-workspace.toml`, `.github/workflows/release.yml`, and every
  `.devboard/goals/` file other than this spec. Do not change the GitHub release asset contract,
  the update fallback, or the push-mirror configuration.
- Preserve GitHub and GitLab support for checkouts that name those origins, including GitHub
  Enterprise hosts pinned by `DEVBOARD_FORGE`; do not remove a forge from the product, only the
  incorrect selection of a non-Gitea forge for this checkout's Gitea origin.
- Never hardcode this host's absolute paths, Gitea URL, token, or project name in
  `.devboard/crates`. Take every host fact from the origin remote, the environment, or arguments,
  as the code does today.
- No new Rust or client dependency. Do not drop, skip, filter, or retry an existing test to make
  the change pass; the new regression tests must fail on the pre-fix commit.
- Never call `gh` or `glab` by hand to drive this repository's forge work, never run
  `devboard publish` by hand, and never dispatch the release workflow by hand; the Release Train
  is the only releaser. Never kill, spawn, or relaunch the live dashboard by hand.
- Never force-push, rewrite published history, push with `--no-verify`, mutate the live
  dashboard's state or resource settings, or write outside the repository root. Throwaway
  dashboards and fixtures live under `.devboard/.test-tmp/` and are removed by the verification.

## Stop conditions

- There is no attempt cap, no token budget, and no time limit: continue until every criterion is
  verified against current state.
- Halt and report genuine ambiguity only: a forge path whose classification as a forge operation
  or a release-artifact read the criteria cannot decide, or two criteria demanding incompatible
  behavior.
- Halt and report a missing prerequisite: no Gitea instance or write credential for the live
  verification, a `forge-auth` selection that cannot write this repository, or a harness binary
  that cannot be built or run.
- Halt and report a blocked external dependency: an unreachable Gitea API needed for the live
  proof, or a live Release Train run that never concludes; name its run id and step and complete
  every reachable criterion first.
- Halt before an irreversible or risky operation not authorized here: force push, tag deletion,
  history rewrite, publishing by hand, or hand-killing a dashboard, worker, or agent peer.
- A narrower feature, a scaffold, a mock, a reduced criterion, or a local-only commit never
  substitutes for a success criterion.

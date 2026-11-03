## Objective

A goal-issue run that closes its own issue finishes `succeeded`, and the Issues overview shows no
`Issue #<n> was closed on the tracker; its run was stopped.` notice for that completion. An
operator who closes a goal issue keeps the current behaviour: the run stops and the same notice
is shown. The affected surface is the `/implement-goal-issue` command and the Issues worker state
that the Issues mode renders. The recurring notice's root cause is identified and removed.

## Success criteria

- A goal-issue run that closes its own issue leaves its peer running on a poll that drops the
  issue, keeps `notice` null, and finishes `succeeded` with its handled ledger entry and no
  cooldown entry for that issue.
- A goal issue closed without a record naming its run still stops that run: the run is recorded
  `stopped`, `notice` is the exact `Issue #<n> was closed on the tracker; its run was stopped.`
  text, and the issue gets no handled entry and no cooldown.
- The `/implement-goal-issue` prompt emitted for a GitHub origin and for a Gitea origin instructs
  the run to close the issue through the Devboard MCP `issue_close` tool with that issue number
  and `reason` `completed`.
- No `/implement-goal-issue` prompt contains a `gh issue close`, `glab issue close`, `curl`,
  `PATCH`, or `forge-auth.ts` close instruction.
- `.devboard/README.md`'s `/implement-goal-issue` paragraph names `issue_close` as the close path
  and states that it records the closing run; it no longer says GitHub closes through `gh` or
  Gitea through an API `PATCH`.
- The commit that lands the fix has a body naming the root cause: the goal close used the raw
  forge CLI or API and wrote no `closed-by-run` record, so a worker poll classified every finished
  goal run as an operator cancellation. The body contains both `closed-by-run` and `issue_close`.
- This goal's issue is closed through `issue_close`; its run is then recorded `succeeded` and the
  live Issues state's `notice` is null.
- `cd .devboard && bun test` exits 0, including new cases for the two goal-run settlement
  outcomes and for the emitted close instruction on both forges.
- `cd .devboard && bun run check` exits 0 and `cd .devboard && bun run build` exits 0.
- The work is merged to `main` and pushed, and `git ls-remote origin refs/heads/main` names the
  integrated commit while `git status --short --branch` reports no commits ahead.
- The Release Train publishes a version, and that version's npm tarball contains
  `package/extensions/implement-goal-issue.ts` with `issue_close` and without `gh issue close`,
  `glab issue close`, `curl`, or `PATCH`.

## Verification

Run every step inside the worktree `<REPO_DIR>/.worktree/<name>`, then repeat the repository
checks on `main` after the merge and push.

- `cd .devboard && bun test tests/implement-goal-issue.test.ts tests/issues.test.ts` exits 0. The
  run lists the added case names in its report: one for a goal run whose own recorded close
  settles it `succeeded` with a null notice, one for an operator close that still stops it, and
  one for each forge's prompt naming `issue_close`.
- `cd .devboard && bun test` exits 0.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run build` exits 0.
- Prompt source proof, from the worktree root:
  `grep -n "issue_close" .devboard/extensions/implement-goal-issue.ts` prints at least one line,
  `grep -nE "gh issue close|glab issue close" .devboard/extensions/implement-goal-issue.ts`
  and `grep -nE "curl|PATCH" .devboard/extensions/implement-goal-issue.ts` both print nothing.
- Documentation proof:
  `grep -n "goal label keeps its goal-mode" -A6 .devboard/README.md` shows `issue_close` and the
  closing-run record in that paragraph, and the paragraph contains no `gh` or `PATCH` close
  sentence.
- Commit-body proof, on `main` after the merge:
  `git log -1 --format=%B -- .devboard/extensions/implement-goal-issue.ts` contains
  `closed-by-run` and `issue_close`.
- Push proof: `git fetch origin main`, then `git ls-remote origin refs/heads/main` names
  `git rev-parse HEAD`, and `git status --short --branch` shows no `ahead` marker.
- Self-close end-to-end proof, after this goal's issue is closed with `issue_close` and its turn
  ends:
  ```
  cd <REPO_DIR> && python3 - <<'PY'
  import glob, json, os
  paths = glob.glob('.devboard/.tmp/issues/*/workers/*/state.json') + \
          glob.glob('.devboard/.tmp/issues/*/state.json')
  path = max(paths, key=os.path.getmtime)
  state = json.load(open(path))
  runs = [r for r in state.get('runs', []) if <ISSUE_NUMBER> in (r.get('issueNumbers') or [])]
  print(path, 'notice=', state.get('notice'), 'statuses=', [r.get('status') for r in runs])
  PY
  ```
  prints `notice= None` and `'succeeded'` among the statuses.
- Release proof after the Release Train publishes:
  ```
  cd <REPO_DIR> && v=$(npm view @dsdenes/devboard version) && mkdir -p .devboard/.tmp/pack &&
  npm pack "@dsdenes/devboard@$v" --pack-destination .devboard/.tmp/pack &&
  tar xOf ".devboard/.tmp/pack/dsdenes-devboard-$v.tgz" package/extensions/implement-goal-issue.ts
  ```
  prints a file containing `issue_close` and no close through `gh`, `glab`, `curl`, or `PATCH`;
  remove `.devboard/.tmp/pack` afterwards.

## Boundaries

- Do all work in `.worktree/<name>` inside the repository root; never edit the opened checkout.
  Every fixture, pack destination, and temporary file lives under the worktree or
  `.devboard/.tmp/`.
- In scope: `.devboard/extensions/implement-goal-issue.ts`,
  `.devboard/tests/implement-goal-issue.test.ts`, `.devboard/tests/issues.test.ts`,
  `.devboard/README.md`, and `.devboard/tests/implement-gitea-close.test.ts` (delete it or
  replace its assertions, because its raw-API close no longer exists).
- The prompt must not construct, embed, or mention a tracker write command other than the
  `issue_close` tool call. Remove parameters and imports that only the old close command used.
- Untouched: `.devboard/issues/worker.ts` classification rules, `.devboard/issues/self-close.ts`,
  `.devboard/mcp/issues.ts`, `.devboard/prompts/**`, `.devboard/omp/**` unless a canonical change
  requires its mirror copy, `.omp/**` except through `.devboard/install.sh`, `adrs/`, `GOAL.md`,
  `.devboard/dist/`, and `node_modules/`.
- The operator-close behaviour is a contract, not something to relax: a close no run recorded
  must keep stopping the run and showing the notice.
- Every tracker write goes through the Devboard MCP tools; no direct `gh`, `glab`, or Gitea API
  close from the goal prompt or from the implementing agent.
- No new dependency, no force-push, no rewriting published history, no hand-run
  `bun run publish` or release-workflow dispatch, and no hand-edit of an installed harness.
  The Release Train owns the release.
- Another goal's work must keep its own behaviour; do not rename, rewrite, or retire unrelated
  Issues-worker tests to make this change pass.

## Stop conditions

Halt and surface a blocker only for genuine ambiguity the repository cannot resolve, a missing
prerequisite (`bun`, `git`, npm, the Gitea forge with write access, or a dashboard serving this
checkout), a blocked external dependency (an origin push rejected by a permission the repository
cannot grant, or npm or Gitea rejecting the release artifact), or a risky irreversible operation
this goal does not authorize (force-push, published-history rewrite, or a tracker write outside
`issue_close`). There is no attempt cap, no token budget, and no time limit. A failed attempt is
never reported as a satisfied criterion, and a narrower feature, a scaffold, a mock, or a
local-only commit never substitutes for a criterion.

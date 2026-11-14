---
description: Implement exactly one open issue, integrate it into the canonical line, and close it only after the push is verified.
---

## Manifesto

Your goal is to deliver exactly one open issue end to end, and the observable result is the issue
implemented, integrated into the canonical line, pushed, and closed after the push is verified.

The argument must be exactly one positive integer issue number. If it is missing, non-numeric, or
carries more than one token, refuse before changing anything: write the refusal to stderr, exit
nonzero, and stop. Never guess an issue number and never accept a range, a list, or a URL.

This run serves one issue. After the single `devboard_status` host-resolution call in *Inputs and
paths*, read exactly that one issue with `issue_get` — the first tracker tool call, and the one
place an unusable forge credential surfaces — and never fetch, survey, or build a dependency graph
for the rest of the backlog. You may read other issues and code for context, but you never edit,
comment on, close, or reopen another issue.

## Inputs and paths

- **MCP routes.** A Devboard MCP tool mounts as `xd://mcp__devboard_` plus its catalog name with
  any leading `devboard_` dropped — `devboard_status` is `xd://mcp__devboard_status` — so never
  write `xd://<name>` and never repeat the prefix as `xd://mcp__devboard_devboard_<name>`. Copy
  each mount from the device list; never infer it. A `write` carries the whole device route in
  `path` and nothing else: a selector suffix such as `:raw` is a `read` spelling, never part of a
  device route, so `xd://mcp__devboard_mcp_optimizer_proposal_skip:raw` is not a tool either. A
  write that answers `No such tool` gets exactly one corrected attempt: copy a name from the
  `Mounted devices:` list in that same error or recompose it by this rule, and change nothing
  else. Never re-issue the identical call and never retry a variant whose `i` text is the only
  difference.
- Resolve the session's host and checkout state exactly once, before any forge read or write: make
  one argument-free `devboard_status` MCP call. Take `<REPO_DIR>` from its `repositoryRoot` — the
  checkout's worktree path — along with `harnessDirectory`, `stateDirectory`, and its `git`
  object: `git.branch` is the checked-out branch, `git.upstream` its canonical upstream, and
  `git.ahead`/`git.behind` its divergence from that upstream. That one result is the whole
  checkout-orientation step, and the canonical checkout is `<REPO_DIR>` itself. Do not rebuild
  that answer from shell output, and never fetch to refresh it: this result and a bare
  `git status --short --branch` already name the branch, its upstream, and its divergence, so a
  fetch to refresh either is the defect *Landing budget* removes. The landing verdict is the
  `remote ... verified` line `devboard land` prints, and no
  `git rev-list --left-right --count` may confirm a branch, worktree, or divergence either reports.
  A ref the result does not name — a task branch that is not that upstream — is never counted
  either: the one `git status --short --branch` of the checkout that has that branch checked out
  reports it, and the same count is never re-run between steps. Issue the call before the first
  tracker read below. Never issue more than one `devboard_status` call in a turn, except for the
  one read immediately after a dashboard reload that confirms the newly running version; never poll
  it before each step or between successive forge reads and writes.
- Read every Devboard fact through the registered MCP tools — `devboard_status`, `issue_get`,
  `issues_list`, `issue_close`, `verification_run`, `goal_get`, `journal_search`, and
  `agent_sessions_list` — never by spawning the harness's `call-tool` bridge or any other
  subprocess that wraps them: the bridge starts a second Bun process and duplicates a capability
  the session already has. Never reach for that bridge for a Devboard state read.
- Before the first write of a turn, check each route against the mounted devices: a `write` whose
  `path` is not a listed device route — `conflict://1`, for example — is never a probe. Fix the
  route and issue the call once.
- Never orient the session with a shell probe, and never chain orientation probes: no
  `git remote get-url origin` or `git remote get-url github`, no `git config --get
  remote.origin.url`, no `git rev-parse --show-toplevel`, no `ls` of `.devboard`'s scripts
  directory, no `env | grep`, and no credential-preflight command. The `devboard_status`
  result covers the roots, the checkout's `origin` names the forge, and a tracker tool answers
  the project it read; none of them is re-derived to orient the run.
- Fall back to a shell probe only for a field neither the `devboard_status` result nor a tracker
  tool call reports, and then at most one probe, run alone: never a chained discovery line, never
  `git remote get-url origin`, and never a probe that merely confirms a value one of them already
  reported.
- Worktree root: `<REPO_DIR>/.worktree/`. Cut the worktree from `origin/main` as the checkout
  already holds it — the cut fetches nothing (see *Landing budget*):
  `git worktree add --track -b issue-<number> .worktree/issue-<number> origin/main`, and never
  refetch it afterward; `--track` makes the task branch's upstream the integration ref, so one
  `git status --short --branch` line reports its divergence. Create and work in exactly one
  worktree there, named for the issue, for example `<REPO_DIR>/.worktree/issue-<number>`. Never
  push from the worktree: `devboard land` performs the one push, from the canonical checkout. Never
  work in the canonical checkout, never use another agent's worktree, and write nothing outside
  `<REPO_DIR>` — no temporary file, log, cache, or build output elsewhere, and never `/tmp/x`.
- Scratch files and command logs live under `<REPO_DIR>/.devboard/.tmp/` and nowhere else. Create
  that directory once per session with a standalone `mkdir -p .devboard/.tmp` from the repository
  root; a scratch log that has to be kept names it, for example
  `> .devboard/.tmp/check.log 2>&1`.
  Never create or use a repo-root `.tmp`: no `mkdir -p .tmp` prefix, no
  `ls -d .tmp || mkdir -p .tmp` guard, and no `> .tmp/<name>.log 2>&1` redirect.
- The worktree cut is the whole worktree sync and never refetches after creation: `git worktree
  add --track -b issue-<number> .worktree/issue-<number> origin/main` places the task branch on
  the integration ref the checkout already holds, and the cut makes no network call at all. No
  rebase runs before the first edit.
  The only rebase in this task is the one `devboard land` performs when the branch's base
  advanced, and the one you finish by hand when that rebase reports a conflict; neither is entered
  from the task start, from re-verification, or from re-checking state.
- A branch being rebased holds no unstaged change when that rebase starts. `error: cannot rebase:
  You have unstaged changes.` is answered by committing the worktree's own work first — `git add
  -A`, then one commit whose subject is a Conventional Commit describing the change — and then
  running that same rebase line once. Never `git stash`, never leave the worktree stashed or
  mid-rebase, and never answer the refusal with a `wip` subject the pre-push commit gate rejects.
- A `CONFLICT (content)` is part of the rebase that raised it, never a reason to abandon it: for
  each file the conflict line names, edit the conflicted hunks, `git add <file>`, and continue
  with `git rebase --continue`, repeating until the rebase completes. Never `git rebase --abort`
  and never `git rebase --skip` in a worktree: the task branch is unpublished, so every conflict
  is resolved in place. The recurring case is a harness file both sides re-authored —
  `.devboard/prompts/implement-issue.md` first, and a `.devboard/scripts/*` file whose change main
  already carries. When the target ref's copy already holds the branch's intended text, resolve
  that duplicate in favor of it — `git checkout origin/main -- <file>` for a rebase onto
  `origin/main`, `git checkout main -- <file>` for the landing rebase onto the canonical
  checkout's `main` — `git add` the file, and continue with `git rebase --continue`; never take
  `--theirs`, which in a rebase is the branch commit being replayed, while `--ours` is that
  target ref's side. A branch change that ref does not carry is a real change: resolve it hunk
  by hunk instead of discarding it. Never commit a fresh copy of a prompt-doc change that
  already landed on main under a new hash — a `docs(prompt)` commit whose text main already
  carries is that duplicate, not a fix. After a resolved conflict, continue until the rebase
  completes and never re-run the rebase to re-check state.
- Forge access arrives with the session: never resolve it with a preflight command. The dashboard
  selects the forge, host, project, and credential from the checkout's `origin` and hands that
  selection to every tracker tool, so this run invokes no credential preflight, resolves no
  harness binary for a credential, and never probes a forge endpoint. The first tracker tool call
  — the `issue_get` read below — is where an unusable credential surfaces: the tool answers an
  error naming the forge, the operation it attempted, and the concrete cause, so stop, report
  that text verbatim as the blocker, and write nothing to the forge. Never retry the call to look
  for a different answer, never switch host or account by hand, and never fall back to `curl` or
  another forge API probe.
- A Devboard MCP call that times out at the transport gets at most one retry of that exact call.
  A second timeout ends that tool path for the rest of the run: finish through the path that
  still answers, or report the timeout as the blocker, and never probe the same server through
  `journal_search`, `issues_list`, or `issue_get` as a liveness check. Never read one issue
  number more than twice.
- Never discover forge or registry configuration from the environment or a credential file: no
  `env | grep`, `printenv`, `cat .env`, `cat ~/.npmrc`, `git config --get-regexp 'url\..*'`, or
  any other sweep of the process environment or a credential file, and no invocation of a
  harness credential wrapper to learn the host, project, or token scope.
  `DEVBOARD_GITEA_URL` is supplied by the host at run time: use it exactly as supplied,
  verbatim, with no derived or default port, so never hardcode it or fall back to a guessed base
  such as `http://localhost:2223`. Never probe a forge endpoint such as `/api/v1/version` to
  confirm the base URL or the credential. Never pipe `env` or `printenv` into `grep` (an
  `env | grep` probe) for `gitea`, `forge`, `github`, `gitlab`, or `token`: the tool shell
  carries an exported `MATCH` variable holding a token-bearing grep match
  (`MATCH='GITEA_TOKEN=…'`), so an echoed `MATCH=` line re-leaks the value. Emit a
  credential only as `<set>` or `<redacted>`, never as a value or a prefix of one; when a
  variable must be checked, print only a boolean, `[ -n "$GITEA_TOKEN" ] && echo set`. A
  diagnostic line that must name a variable rather than discover configuration strips every
  value on every line with `sed -E 's/=.*/=<set>/'`; never mask only a name list with
  `sed -E 's/(TOKEN|SECRET|PASSWORD)=.*/\1=<redacted>/'` or a variant, because that leaves a
  differently named value such as `GITHUB_APM_PAT` in the transcript.
- Read the issue before changing anything, using the `repositoryRoot`, `harnessDirectory`, and
  `stateDirectory` the `devboard_status` call above resolved; reuse those values instead of
  calling `devboard_status` again. `issue_get` with `{"number": <number>}` returns that issue's
  title, body, labels, state, and URL on whichever forge the repository uses. Use `issues_list`
  only to confirm the state of a referenced prerequisite, never to survey the backlog.
- Forge state — issues, labels, releases, and workflow runs or jobs — MUST be read and mutated
  through the `devboard` MCP tools: `issue_get` and `issues_list` for reads, `issue_close` for
  the one close, and `verification_run` for an allowlisted check. NEVER source `.env` (including
  `set -a; . ./.env; set +a`) or call `curl` with `$GITEA_TOKEN` or `$DEVBOARD_GITEA_URL` to read
  or write an issue, label, run, job, or release.
  Never call `gh` or `glab` for a tracker read or mutation. This run never releases and never
  verifies a release: the Release Train publishes on its own schedule after the push, so do not
  inspect or wait for a release workflow.

## Landing budget

Repository state — the checked-out branch, its upstream, and its ahead/behind count — comes from
the one `devboard_status` result and a bare `git status --short --branch`. `git status --short
--branch` reads local state: it never needs a preceding fetch, and neither call needs the network.

The run issues no `git fetch`, no `git merge`, no `git rebase`, no `git push`, and no
`git ls-remote`: one `devboard land <branch>` call owns the whole landing and its proof, as
*Landing* states. It fetches the integration branch's upstream itself, integrates a tip that moved,
rebases the task branch onto the integration tip when its base advanced, fast-forwards the
integration checkout without a merge commit, pushes it, and reads the remote tip back. Nothing in
the run needs the remote tip before that call: the worktree is cut from `origin/main` as the
checkout already holds it, and a read, edit, build, test, typecheck, or `verification_run` check
never needs fresher refs. A session that only reads tracked files therefore touches the network not
at all, and a fetch is never a session's first command.

A landing the command refuses is terminal for the run: put its first stderr line in the final
response as the failure, leave the worktree and its committed branch in place, and never answer it
with a `git fetch`, `git merge --ff-only`, `git push`, `git ls-remote`, or a rerun of the same
command. The one cause the run finishes by hand is a rebase that does not apply cleanly, which the
command aborts and reports; *Landing* states that resolution.

## Dependencies

The package root that owns the lockfile is `.devboard/`: `<worktree>/.devboard` inside your worktree
and `<REPO_DIR>/.devboard` in the canonical checkout. Run every harness `bun`/`bunx` command with
that package root as the working directory: `bun install --frozen-lockfile`, `bun run build`,
`bun run test`, and `bun run test:client`, each as its own invocation. The typecheck is not a
bare `bunx tsc --noEmit` shell call: run it through `verification_run` with
`{"check": "typecheck"}` once per verification pass, as *Typecheck* below requires. The repository
root has no `package.json`, so a root-level `bun install --frozen-lockfile` exits nonzero with
"Bun could not find a package.json file to install from", and a root-level `bun run build` fails
with `error: Script not found "build"`.

- Run `bun install --frozen-lockfile` only from the package root that owns the lockfile: the tool's
  `cwd` is `.devboard/` in the canonical checkout, or `<worktree>/.devboard/` in a task worktree.
  Never run it from the repository root, and never prefix it with `cd <path> &&` because the
  working directory was not already correct — set `cwd` instead. Always pass `--frozen-lockfile`:
  never a plain `bun install`, which may rewrite `bun.lock`.
- Run `bun install --frozen-lockfile` at most once per session, and only when the package root's
  `node_modules` is absent or `bun.lock` is newer than it. From the package root, the probe
  `[ -d node_modules ] && [ ! bun.lock -nt node_modules ] && echo current || echo install-needed`
  answers that: when it prints `current`, skip the install entirely and go straight to the build,
  typecheck, or check step. A fresh worktree has no `node_modules`, so its one install is expected;
  after it the frozen lockfile and materialized `node_modules` make any later install in that
  session redundant, including after source edits. Installing is a precondition, never a
  verification step, and it never repeats before each build, check, test, or verify step.
- Let the install's output through whole: never pipe it to `tail`, `head`, or any other consumer,
  never redirect it to `/dev/null` or any other file, and never append an
  `echo "EXIT:$?"` or `echo "..._EXIT:$?"` status probe. It prints one summary
  line on success and the full error on failure, and a nonzero exit already reports the failure.
- Run it as its own command and never chain it with `&&` into `bun run build`, `bun run check`,
  `bunx tsc --noEmit`, a test, or a verification check: one failed stage must stay attributable.
  Never re-run it to re-inspect output a consumer truncated. Run a build or test gate only when the
  change touches it.
- `verification_run` runs one allowlisted check from the `.devboard/` that the `devboard_status`
  result reports as `harnessDirectory`, and it is the preferred entry point for every check:
  `{"check": "build"}`, `{"check": "check"}`, `{"check": "typecheck"}`, `{"check": "test"}`,
  `{"check": "rust:fmt"}`, `{"check": "rust:clippy"}`, and `{"check": "rust:test"}`. Its result
  carries `exitCode`, `output`, and the complete `log` in one read. When it resolves the
  canonical package root while you work in a worktree, it checks the pre-change revision; run the
  changed revision once from `<worktree>/.devboard/` as *Verification checks* below requires.
- Run the build, the typecheck, the tests, and each verification check as separate invocations,
  never chained into one command, never behind a `mkdir -p .tmp` prefix, and never behind a
  `> .tmp/<name>.log 2>&1` redirect, as *Shell calls* states. When one fails, name the failing
  stage and quote the last 20 lines of its output in the session transcript; a bare `exit code 1`
  or an empty `(no output)` is never a report.

## Typecheck

The typecheck has exactly one entry point: the `verification_run` MCP tool with
`{"check": "typecheck"}`. The tool runs the package root's typecheck (`bunx tsc --noEmit`, or its
`typecheck` script when one exists) from the resolved `harnessDirectory`, keeps at most 16 KiB of
captured output, writes the complete output to the returned `log`, and returns `check`, `exitCode`,
`output`, `truncated`, and `log` in one result.

- Run it once per verification pass: after the batch of edits that can break types, never after
  every single edit. One `verification_run` call with `{"check": "typecheck"}` covers the pass;
  `{"check": "check"}` runs the client's `bun run check` as the pass-level gate, not a second
  typecheck.
- Repeat it only after a further type-affecting edit: two identical typecheck runs separated only
  by non-type edits never happen. The typecheck reads the working tree, so an unchanged tree yields
  unchanged output and a second run carries no new information.
- A bare `bunx tsc --noEmit` shell invocation is not the typecheck path, and repeating it after
  unchanged code is never required. One `verification_run` call is the whole typecheck; never rerun
  it to re-read the same empty output.
- Run an extra gate only when the change touches it: `{"check": "build"}` after a change to what
  the build produces, and `{"check": "test", "paths": [...]}` for the tests whose subject the
  change touched. Never run more than one gate in a single command.

## Verification checks

Verification is the Rust workspace suite, the contract corpus, the client's build, typecheck,
and unit tests, and the CLI and HTTP smoke checks below. Browser coverage lives in one operator
suite under `.devboard/e2e/`, run by hand with
`bunx playwright test --config e2e/playwright.config.ts` from `.devboard`; it is an operator tool,
not a CI gate, and it is the only place a browser test belongs. Add no `verify-*` script and wire
no browser step into a workflow.

- The Rust checks have exact entry points through `verification_run`, all from the resolved
  `harnessDirectory`: `{"check": "rust:fmt"}` runs `cargo fmt --check --all` and
  `{"check": "rust:clippy"}` runs `cargo clippy --workspace --all-targets -- -D warnings`.
- The local Rust test gate is focused: `{"check": "rust:test", "packages": ["devboard"]}` runs
  `cargo test -p devboard`, and adding `"tests": ["http_surface"]` runs
  `cargo test -p devboard --test http_surface`. Name the packages and test targets the change can
  break, at most 16 of each. `tests` requires `packages`; an empty list, a non-string entry, and a
  name that could read as a cargo flag are refused.
- The full workspace suite is not every change's local gate: the Gitea CI Test step runs it on
  every push and the Release Train runs it before any tag, so iterating never needs it. A
  `{"check": "rust:test"}` with neither argument still runs the full runner when one check must
  reproduce a suite failure.
- The client checks keep their existing entry points: `{"check": "build"}` runs the client build,
  `{"check": "check"}` runs its typecheck, `{"check": "typecheck"}` is the raw typecheck, and
  `{"check": "test"}` runs the client unit suite (optionally with `paths`).
- `{"check": "verify:<name>"}` runs only a `verify:<name>` script that `.devboard/package.json`
  actually declares; the current package declares none, so do not name one.
- Run each check as its own invocation. Never chain a build, check, test, or Rust gate into one
  shell command, and never redirect a check's output to a file: the tool returns the complete
  output and its `log` path, and a result is never taken from a log an earlier run wrote.
- `truncated: true` means the 16 KiB bound cut the returned `output`; the `log` file still holds
  the complete output, and `exitCode` is still the verdict. A result ending
  `[timed out after 900000 ms]` is a failed verification.
- Run the gates the change can break: `rust:fmt` and `rust:clippy` for Rust edits, a `rust:test`
  naming the `packages` the change can break (with `tests` when one test target is the subject)
  for behavior changes, and `build`, `check`, and `test` for client edits. A client edit lands with
  the `crates/devboard/assets` copy `bun run build` refreshes, so commit that rewritten tree with
  the change. When one fails, quote its first error line and the failing command in the session
  transcript; a bare exit code or an empty `(no output)` is never a report.
- Reproduce a failure once before you touch code, name the failing check, and fix the cause. Never
  rerun an identical failing check more than twice: once for the changed revision and once for the
  base revision when one is needed to classify a pre-existing failure.
- When `verification_run` itself errors, report the tool's error text verbatim together with the
  `exitCode`, `output`, and `log` it returned. A tool error is evidence to report, not a reason to
  retry the same check unchanged.

## Prerequisites

If the issue declares an open prerequisite — a `depends on` or `blocked by` line, or a task-list
issue reference whose issue is still open — do not implement the issue. Write `blocked: #<prerequisite>`
as the first stderr line, exit nonzero, and leave the issue open and unhandled. Never implement
the prerequisite in another agent's place.

## Edit calls

- Before an `edit` on a file, confirm the path exists with `read` — a missing file reports
  `File not found` — and `read` the exact line range you are changing. Never edit a section you
  have not read in this run; if the file changed since that read, read it again before acting.
- Every `edit` call passes a `path`. Omitting it fails validation with
  `path must be a string (was missing)`; the tool does not infer the file from the content.
- Choose an `old_string` that occurs exactly once in the target file: quote enough surrounding
  lines — the enclosing function signature plus its first body line, or the whole block — that
  the anchor cannot match a second site. When one replacement must genuinely hit every
  occurrence, pass `replace_all: true` deliberately; never guess it.
- Never send `new_string` identical to `old_string`: that is a no-op that fails with
  `Edits to <path> resulted in no changes being made`. State the real change instead.
- Retry a failed `edit` only with different input. After `Found N occurrences`, re-read the file
  at each reported line, extend the anchor with unique context, or pass `replace_all: true` when
  every hit belongs to the change. After `resulted in no changes being made` or `File not found`,
  re-read the target or its path, state the real change, and retry with a different anchor. Never
  repeat an `edit` whose path, anchor, and replacement are unchanged.
- Never leave temporary instrumentation in an edited file. Diagnostic `MARK` lines, probe logging,
  and staging comments belong in a scratch file or a reverted edit; remove every one before the
  work lands and never commit it.

## Shell calls

- Every shell call must carry a substantive command. A bare `true`, a `cd <root> && true` prefix, or
  a `|| true`/`; true`/`&& true` tail is never a valid call: it burns a round trip, records no
  evidence, and turns a real failure into a passing result. Each call must answer the question it
  was made for, and its output must be read; an exit-status placeholder is not a diagnostic.
- Never neutralize a probe's exit status. `|| true`, `; true`, `&& true`, and `true` as a command's
  only effect are forbidden: they hide a missing worktree, an empty match, or a failed fetch behind
  a zero exit. Run the probe alone and read its nonzero status and stderr; a command whose failure
  matters must be allowed to fail.
- A probe whose target may legitimately be absent must print an explicit empty-result marker, never
  silent output. Append `|| echo none` to the probe
  (`git worktree list | grep -E 'issue-807' || echo none`); for a command that exits 0 on an empty
  result, such as `git branch --list`, print `none` when its output is empty. The `none` or `absent`
  marker separates "the target is absent" from "the command failed".
- To confirm the working directory, run `pwd`; to confirm a path exists, run `ls <path>`. Never
  stand in for either with `cd <root> && true`.
- Keep a worktree, branch, stash, or remote-tip probe in one command and accept its nonzero exit as
  the answer. Do not pad it with a guard tail.
- Run build, test, and Rust gates bare through `verification_run`, with no `mkdir -p .tmp` prefix
  and no `> .tmp/<name>.log 2>&1` redirect. The harness already returns the failing output inline;
  a redirect replaces it with `(no output)` or a bare `exit code 1` and forces the same command to
  be re-run instead of read.

## Contract

- Change only that issue's implementation, tests, and documentation. Follow the repository's
  existing conventions and keep the change limited to the issue's scope.
- The run is non-interactive: no `question` tool, no confirmation prompt, no interactive editor,
  no login prompt, and no waiting for an operator. Decide from the repository evidence.
- Complete the work: no stubs, placeholders, disabled checks, or unfinished branches of behavior.
- Verify the changed surface by running it, then run the checks the change could break. The
  typecheck is one `verification_run` call with `{"check": "typecheck"}` per verification pass,
  repeated only after a further type-affecting edit, as *Typecheck* above states.
- Before landing, read the worktree's `git status --short --branch` line; never fetch for it. An
  unmarked `## issue-<number>...origin/main` line is the synced state, and a marker changes
  nothing either: `devboard land` integrates a moved upstream and rebases the task branch itself,
  and the task branch is unpublished until it lands, so that rebase is safe. Never rebase, merge,
  fetch, or push by hand before the call.
- Land with exactly one `devboard land <branch>` call, run from the canonical checkout whose
  working directory is already set: never a `cd` prefix, never a `| tail` or `| head`, and never a
  trailing `; echo "..._EXIT:$?"`, whose status belongs to the filter rather than the call. Its
  own exit status is the landing verdict, and the `remote <upstream> <sha> verified` line it prints
  is the push proof. Never `--no-ff`, never a forced merge, and never a merge that writes a merge
  commit: the command merges `--ff-only` or refuses.
- A `cannot lock ref 'HEAD'` refusal from a concurrent landing is retried inside the command with
  bounded backoff, and the commit that won is the `merged` line it prints; never recover the lock
  by hand and never rerun the call to look for a different answer.
- A rejected push is retried inside the command after it integrates the new tip: report the refusal
  line it prints as-is, and never re-push, force-push, or rewrite published history.
- Close the issue only after that proof and the required checks pass.
  Use `issue_close` with `{"number": <number>, "reason": "completed"}`; it is the only forge
  mutation in this run. Do not post a tracker comment — no comment tool is exposed — and put the
  revision and the verification evidence in the final response instead.
- A proven duplicate, invalid, or already-fixed issue is closed with `issue_close` and the
  evidence, using reason `not planned` when no work is delivered, and without committing unrelated
  work.
- On success, remove only the worktree and branch you created. On failure or block, leave your
  worktree in place and report its path.

## Landing

Every commit subject MUST be a Conventional Commit, `<type>[(<scope>)][!]: <description>`, with
`<type>` one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. `prompt` is not an allowed type: `prompt:` and `prompt(implement-issue):` are
rejected by the pre-push commit gate, which names each offending `<sha> <subject>` and the rule it
broke and adds no ref. Reword a rejected commit before landing — `git commit --amend` for the tip,
an interactive rebase for earlier commits — and run `devboard land` again. Never pass `--no-verify`
and never edit or remove an installed hook. Surface a commit-gate rejection and a
`! [rejected] … (non-fast-forward)` rejection unmodified: report their exact lines and resolve the
cause they name before retrying, and never trim the rejection with `tail`, `head`, `grep`, or any
other consumer.

The commit that lands MUST also name this issue by ending its subject with `(#<number>)`, for
example `fix(agents): resolve a shipped version from the landed commit (#989)`. Use that reference,
not a closing keyword: the forge links it in the issue timeline without closing the issue, and the
link is what lets the dashboard report the release that shipped the work. A commit subject without
the reference still lands, but its issue shows no shipped version.

Commit in the worktree on the run's own task branch, then land it with one call, from the
repository root — the canonical checkout's working directory, where the session's shell already
starts:

```sh
devboard land issue-<number>
```

In a source checkout where `devboard` is not on `PATH`, the same call is
`cargo run --manifest-path .devboard/Cargo.toml -p devboard -- land issue-<number>`. Never pass a
`cd <checkout> &&` prefix and never name a path: the command resolves the integration checkout
from the harness's own repository.

That one call is the whole landing and its proof. It fetches the integration branch's upstream,
fast-forwards the integration checkout to it, rebases the task branch onto the integration tip when
its base advanced, merges the branch with `--ff-only` — never a merge commit — pushes the
integration branch, and reads the remote tip back. It prints:

```
landed issue-<number> into main
merged <sha>
remote origin/main <sha> verified
ahead 0 behind 0
```

`merged <sha>` is the landing commit, and `remote origin/main <sha> verified` is the push proof:
the remote tip equals it. `ahead 0 behind 0` says neither side holds a commit the other lacks. A
`rebased issue-<number> onto main` line appears only when the base had advanced, and
`retried N HEAD lock(s)` only when a concurrent landing held `HEAD` and the command retried it.

The command's own exit status is the verdict, and a nonzero exit names its cause on the first
stderr line — a refused fetch, a refused push, a rebase that does not apply cleanly, or a remote
tip that names another commit. Put that line in the final response, leave the worktree and its
committed branch in place, and never answer it with a `git fetch`, `git merge --ff-only`,
`git rebase`, `git push`, `git ls-remote`, or a rerun of the same command.

A rebase that does not apply cleanly is the one landing step this run finishes by hand: the command
aborts its own rebase and names the conflicting paths, so rebase the task branch onto `main` inside
the worktree (`git rebase main`), resolve every conflicted hunk in place, `git add <file>`, and
`git rebase --continue` until it completes, then call `devboard land` once more. Never
`git rebase --abort` or `git rebase --skip` there: the task branch is unpublished, so every
conflict is resolved in place. A `rebased` line means the branch landed on a base it was not
verified against: rerun the checks the change needs once and report their verdict beside the
landing.

A short hash, when one is needed, comes from one `git rev-parse --short=12 <rev>` call per
revision: passing two revisions to one `--short` call exits 128 with `fatal: Needed a single
revision`, and that message never means the branches diverged.

Never create a pull request or merge request, never force-push, and never rewrite published
history.

Never delete the worktree or its branch until `devboard land` printed the `remote ... verified`
line naming the commit its `merged` line named: a worktree whose branch is unproven on the remote
stays in place, and a local-only merge, or a deleted worktree before that proof, is a failed task.

Never publish: the Release Train releases the pushed commit on its own schedule.

After that proof, close the issue with `issue_close` and report. Do not release, and do not wait
for a release workflow: the Release Train releases later.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify a commit, and `devboard land` never refuses them. This run adds none of them: every scratch
file — issue or comment JSON, command capture, a verifier log — goes under `.devboard`'s `.tmp/`,
never the harness root. Never create `.devboard/.issue-<N>.json`,
`.devboard/.comment-<N>.json`, or `.devboard/.close-<N>.out` at the harness root; the legacy files
of those shapes still sitting there are noise from earlier runs, and the run never rewrites or
commits them. Replace `origin` and `main` when the repository names another canonical remote or
branch.

## CI waits

CI waiting in this run covers only the checks the change itself needs: the one sanctioned
foreground `verification_run` per check, and one long-lived background watcher for a local check
process, started with `async: true` and `timeout: 0`. After it starts, end the turn.

Never wait for the release workflow: this run releases nothing, and the Release Train dispatches
and verifies `devboard-release.yml` later on its own schedule. Never poll a workflow run with a
hand-rolled `for i in $(seq 1 60)` loop over `/actions/runs/<id>`, never background a poll of the
Gitea API, and never read `/actions/runs/<id>`, `/commits/<sha>/status`, a statuses feed, or a
"count busy runs" page. The forge rule above already requires run reads through the `devboard` MCP
tools, never `curl`.

## Release

This run never releases. Close the issue with `issue_close` after `devboard land` proved the push
and the required checks pass. Never invoke the publish entry point, never dispatch a workflow,
never call npm or the Gitea release API, and never wait for a release tag. The Release Train
collects every unreleased `main` commit, publishes one version for the range, and records the
version and release URL itself; a separate release from this run would collide with it.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

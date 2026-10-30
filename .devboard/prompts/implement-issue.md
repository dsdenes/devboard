---
description: Implement exactly one open issue, integrate it into the canonical line, and close it only after the push is verified.
---

`/implement-issue <number>`: implement exactly one open issue end to end.

The argument must be exactly one positive integer issue number. If it is missing, non-numeric, or
carries more than one token, refuse before changing anything: write the refusal to stderr, exit
nonzero, and stop. Never guess an issue number and never accept a range, a list, or a URL.

This run serves one issue. Read exactly that one issue with `issue_get` and never fetch, survey, or
build a dependency graph for the rest of the backlog. You may read other issues and code for
context, but you never edit, comment on, close, or reopen another issue.

## Inputs and paths

- `<REPO_DIR>` is the checkout root: `git rev-parse --show-toplevel` in the repository. The
  canonical checkout is `<REPO_DIR>` itself.
- Worktree root: `<REPO_DIR>/.worktree/`. Create and work in exactly one worktree there, named for
  the issue, for example `<REPO_DIR>/.worktree/issue-<number>`. Never work in the canonical
  checkout, never use another agent's worktree, and write nothing outside `<REPO_DIR>` — no
  temporary file, log, cache, or build output elsewhere. A scratch file that is genuinely
  required belongs inside `<REPO_DIR>/.devboard/` and is removed after use; never write `/tmp/x`
  or any other path outside the repository root.
- Before the first forge read or write, run the auth check exactly once per session, from the
  repository root, and run it verbatim:

  ```sh
  bun .devboard/scripts/forge-auth.ts check --required write --json
  ```

  This single canonical preflight is the only auth probe and the only auth invocation of the run.
  It resolves the forge, host, project, and identity from the environment and the `origin` remote,
  so never pass `--host` or `--project`, and never derive either with `sed`, `git remote get-url`,
  or any other shell substitution. Never prefix it with `cd <path>`, never append `echo $?`,
  `echo "EXIT:$?"`, or `echo "exit=$?"`, and never pipe the output through `head`, `tail`, or any
  other consumer. The credentialed target is `DEVBOARD_GITEA_URL` with `GITEA_TOKEN`; a host is a
  label only, so never pass `origin`, `github.com`, a bare IP, or a bare port. Exit status is
  authoritative and `--json` carries the selected identity: zero means write access. On a nonzero
  exit, stop and report the printed reason; when the origin is Gitea, name `--forge gitea` as the
  only permitted adjustment. Never retry by cycling host literals such as
  `localhost:2223`, `localhost:3001`, `127.0.0.1`, `origin`, or `ds@localhost:2223`, and do not
  rerun the check in the same session. That JSON line, plus the resolution fields
  `devboard_status` returns, is the only supported way to learn the forge host, project, or
  credential state: both report presence and resolution without exposing a value, so an
  environment sweep answers nothing they do not. Never enumerate the process environment or hunt
  for credential files: `.devboard/prompts/forge-auth.md` holds that rule in full. In particular,
  never pipe `env` or `printenv` into `grep` (an `env | grep` probe) for `gitea`, `forge`,
  `github`, `gitlab`, or `token`, and never treat `sed`-based masking as redaction: the tool shell
  carries an exported `MATCH` variable holding a token-bearing grep match
  (`MATCH='GITEA_TOKEN=…'`), so a later sweep reprints the token on a line no substitution
  rewrote. When a variable must be checked, print only a boolean,
  `[ -n "$GITEA_TOKEN" ] && echo set`, and never its value or a prefix of it.
- Resolve the checkout and read the issue before changing anything. `devboard_status` returns the
  resolved `repositoryRoot`, `harnessDirectory`, and `stateDirectory`; use it instead of guessing
  roots. `issue_get` with `{"number": <number>}` returns that issue's title, body, labels, state,
  and URL on whichever forge the repository uses. Use `issues_list` only to confirm the state of a
  referenced prerequisite, never to survey the backlog.
- Forge state — issues, labels, releases, and workflow runs or jobs — MUST be read and mutated
  through the `devboard` MCP tools: `issue_get` and `issues_list` for reads, `issue_close` for the
  one close, and `verification_run` for an allowlisted check. NEVER source `.env` (including
  `set -a; . ./.env; set +a`) or call `curl` with `$GITEA_TOKEN` or `$DEVBOARD_GITEA_URL` to read
  or write an issue, label, run, job, or release. Never call `gh` or `glab` for a tracker read or
  mutation. Release and workflow verification goes through `bun run publish` as specified below,
  never through a forge API.

## Dependencies

The package root that owns the lockfile is `.devboard/`: `<worktree>/.devboard` inside your worktree
and `<REPO_DIR>/.devboard` in the canonical checkout. Run every harness `bun`/`bunx` command with
that package root as the working directory — `cd .devboard && bun install --frozen-lockfile`,
`cd .devboard && bun run build`, `cd .devboard && bun test`, and
`cd .devboard && bunx tsc --noEmit`. The repository root has no `package.json`, so a root-level
`bun install --frozen-lockfile` exits nonzero with "Bun could not find a package.json file to
install from", and a root-level `bun run build` fails with `error: Script not found "build"`.

- Run the install only from the package root: `cd .devboard && bun install --frozen-lockfile` in the
  repo root, or the same command from the worktree root. Never run `bun install` from the repository
  root itself.
- Skip the install when the package root (`.devboard/`) already has `node_modules` and `bun.lock`
  has not changed since that install. Run it at most once per session: installing is a precondition,
  never a verification step, and it never repeats before each build, typecheck, or test.
- Never pipe the install into `tail` and never chain it with `bun run build`, `bunx tsc --noEmit`,
  or `bun test` in one shell line. It prints one summary line on success and the full error on
  failure; truncation hides lockfile errors. Run it once, check its exit status, then run the build,
  typecheck, and tests as separate commands.
- `verification_run` runs an allowlisted check from the `.devboard/` that `devboard_status` reports
  as `harnessDirectory`. Use it for `bun run verify:interface`, as *Interface verification* below
  requires. When it resolves the canonical package root while you work in a worktree, run that
  same check from `<worktree>/.devboard/` so the changed revision is what executes.

## Interface verification

`bun run verify:interface` builds the client, starts a source dashboard, drives headless Chrome,
and throws the whole assertion message plus its JSON evidence object on the first failure. A lost
assertion therefore costs a full rerun, so interface verification has its own rule.

Run it through `verification_run` with `{"check": "verify:interface"}`. The tool executes the
`verify:interface` script from `.devboard/package.json` with the resolved `harnessDirectory` as its
working directory, kills the check's whole process group at its 900-second bound, and returns
`check`, `exitCode`, `output`, and `truncated` in one result.

- Read `repositoryRoot` and `harnessDirectory` from `devboard_status` first. When
  `harnessDirectory` is the `.devboard/` you changed, the tool verifies the changed revision and is
  the only way to run the check.
- When `devboard_status` reports the canonical `<REPO_DIR>/.devboard` while you work in a worktree,
  `verification_run` would verify the pre-change revision. Run `bun run verify:interface` once, in
  the foreground, from `<worktree>/.devboard` instead.
- Never background `verify:interface`, never kill or restart it, and never pipe it through `tail`,
  `head`, `grep`, or another consumer. A backgrounded job ends the turn without its verdict, a
  killed job loses the assertion, and a pipe keeps only the lines the filter matched.
- Never redirect the check into a log (`> .tmp/verify-interface.log 2>&1`, `2>&1 | tee`) and never
  take a verdict from a log an earlier run wrote. The verdict belongs to the turn that started it.
- `truncated: true` means the 16 KiB capture bound cut the run and `output` holds only its
  beginning: `exitCode` is still the verdict, and a truncated result is never a pass. A result
  ending `[timed out after 900000 ms]` is a failed verification, not a reason to background the
  check.
- On failure, read the complete `verify:interface: <assertion>: <evidence>` line before editing:
  the assertion names the control, and the evidence object carries the measured and expected
  values it compared. A partial read hides which side mismatched.

## Prerequisites

If the issue declares an open prerequisite — a `depends on` or `blocked by` line, or a task-list
issue reference whose issue is still open — do not implement the issue. Write `blocked: #<prerequisite>`
as the first stderr line, exit nonzero, and leave the issue open and unhandled. Never implement
the prerequisite in another agent's place.

## Edit calls

- Before the first `edit` on a file, `read` that file and the exact line range you are changing.
  Never edit a section you have not read in this run; if the file changed since that read, read
  it again before acting.
- Every `edit` call passes a `path`. Omitting it fails validation with
  `path must be a string (was missing)`; the tool does not infer the file from the content.
- Choose an `old_string` that occurs exactly once in the target file: quote enough surrounding
  lines — the enclosing function signature plus its first body line, or the whole block — that
  the anchor cannot match a second site. When one replacement must genuinely hit every
  occurrence, pass `replace_all: true` deliberately; never guess it.
- Never send `new_string` identical to `old_string`: that is a no-op that fails with
  `Edits to <path> resulted in no changes being made`. State the real change instead.
- After a `Found N occurrences` error, do not retry the same anchor: re-read the file at each
  reported line, extend the anchor with unique context, or pass `replace_all: true` when every
  hit belongs to the change.

## Shell calls

- Never emit a bare `true`, a `cd <repo> && true` prefix, or an `&& true`/`; true` suffix. Each call
  must answer the question it was made for, and its output must be read; an exit-status placeholder
  is not a diagnostic.
- `|| true` is permitted only where an absent match is the expected result, such as a `grep` or `ls`
  probe whose empty output you then read; never use it to hide a failure whose exit status matters.
- Keep a worktree, branch, stash, or remote-tip probe in one command and accept its nonzero exit as
  the answer. Do not pad it with a guard tail.

## Contract

- Change only that issue's implementation, tests, and documentation. Follow the repository's
  existing conventions and keep the change limited to the issue's scope.
- The run is non-interactive: no `question` tool, no confirmation prompt, no interactive editor,
  no login prompt, and no waiting for an operator. Decide from the repository evidence.
- Complete the work: no stubs, placeholders, disabled checks, or unfinished branches of behavior.
- Verify the changed surface by running it, then run the checks the change could break.
- Before landing, fetch the canonical integration line (`main` unless the repository names another),
  fast-forward `main` to it, and rebase the run's task branch onto it inside the worktree when it
  has moved. Resolve every conflict yourself and rerun every check the integration invalidates. The
  task branch is unpublished until it lands, so rebasing it is safe. Never answer "Not possible to
  fast-forward" by repeating the same `git merge --ff-only <task-branch>`.
- Land through the one sequence below. Never create a pull request or merge request, never
  force-push, and never rewrite published history.
- When a push is rejected, fetch the new tip, rebase the task branch onto it inside the worktree,
  rerun the invalidated checks, and repeat the landing sequence and push block once per rejection.
  Never bypass the rejection.
- Close the issue only after the push block below proves the push and the required checks pass.
  Use `issue_close` with `{"number": <number>, "reason": "completed"}`; it is the only forge
  mutation in this run. Do not post a tracker comment — no comment tool is exposed — and put the
  revision and the verification evidence in the final response instead.
- A proven duplicate, invalid, or already-fixed issue is closed with `issue_close` and the
  evidence, using reason `not planned` when no work is delivered, and without committing unrelated
  work.
- On success, remove only the worktree and branch you created. On failure or block, leave your
  worktree in place and report its path.

## Landing

Commit in the worktree on the run's own task branch. When `main` has moved since the branch was
cut, rebase the task branch onto `origin/main` inside the worktree and rerun the checks the rebase
invalidates before landing; a rebase that reports the branch is up to date is the normal case.

Read the worktree's sync state with the task branch's `HEAD` in one combined probe, run in the
worktree after the fetch required before landing:

```sh
git rev-parse --verify HEAD
git rev-parse --verify origin/main
git rev-parse --short HEAD
git rev-parse --short origin/main
git rev-list --left-right --count HEAD...origin/main
git merge-base --is-ancestor HEAD origin/main; echo "ancestor=$?"
```

`git rev-list --left-right --count A...B` prints `<A-only> <B-only>` in ref order: the left number
counts the commits only `HEAD` has and the right number counts the commits only `origin/main`
has. `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B and 1 when it is not;
any other exit status, such as 128 with `fatal: Not a valid object name`, means a ref is missing or
the command itself failed, never that the commit is unrelated. A missing ref also makes
`git rev-parse --verify <ref>` print `fatal: Needed a single revision`; when either appears,
verify each ref on its own with `git rev-parse --verify HEAD` or
`git rev-parse --verify origin/main`, fetch `origin main`, and read the probe again before
concluding anything.

Then land it with this one canonical sequence from the canonical checkout, on `main`:

```sh
git fetch origin main
git merge --ff-only origin/main
git merge --ff-only <task-branch>
```

The fetch names the tip, the first merge fast-forwards `main` to it, and the second adds the task
branch. Run the sequence once per landing attempt: no `&&` chain between its lines, no `tail`
pipe, and no `PIPESTATUS` probe. Never create a pull request or merge request.

Push and prove the push with this one block, run verbatim once after the sequence, in the
canonical checkout and read as-is:

```sh
git fetch origin -q && git status --short --branch && git push origin main; echo "PUSH_EXIT:$?"; printf 'local  %s\nremote %s\n' "$(git rev-parse HEAD)" "$(git ls-remote origin refs/heads/main | cut -f1)"
```

It is one push invocation, its exit status on the `PUSH_EXIT:` line, and the local and remote
commits printed by the same command. The push is verified only when `PUSH_EXIT:0` prints and the
two SHAs are identical; `git status --short --branch` must show no ahead/behind marker. Never pipe
`git push` into `tail`, `head`, or any other consumer: the `tail -3`, `tail -4`, `tail -5`,
`tail -8`, and `tail -10` variants discard the rejection text and the exit status. Never use
`git log` or a trimmed merge output as the push proof, and run the block once per landing
attempt: it is the only post-push readback, and this prompt excludes any other `git ls-remote`,
`git log`, and a second `git status` readback.

Equal tips prove the landing commit is the canonical tip, so the `ls-remote` in the block replaces
every post-push sync probe: never repeat `git rev-list --left-right --count` or
`git merge-base --is-ancestor` after the push and never confirm the remote tip with rev-list. The
block's `&&` chain is deliberate — the status read must succeed before the push runs — so never
split it into separate commands, drop the leading fetch, reorder it, or rerun it to reconfirm
output it already printed; a nonzero exit from it is evidence to read. Fetch at most twice in a
session, and fetch again only after a push, merge, or rebase happened since the previous fetch.

`Diverging branches can't be fast-forwarded` or "Not possible to fast-forward" is a diagnosis,
not an instruction to repeat the merge. Never rerun the same `--ff-only` command, and never fall
back to `--no-ff` silently. Name which side is ahead with exactly one
`git rev-list --left-right --count HEAD...origin/main` after the refused merge: the left count is
the commits only `HEAD` has and the right count is the commits only `origin/main` has. Never
chain that probe with `&&`. Integrate `origin/main` into the task branch — rebase it inside the
worktree onto `origin/main` and rerun the checks the rebase invalidates — then repeat the sequence
and the push block from the start.

A `CONFLICT (content)` is resolved in the merge that raised it: edit the conflicted files, stage
them, commit the result, and rerun the checks the conflict invalidates. `git merge --abort`
followed by an unchanged retry is not acceptable; only an integration that removes the conflict
may follow an abort.

A nonzero `PUSH_EXIT` or differing local and remote commits is a rejected or unproven push: fetch
the new tip, rebase the task branch onto `origin/main` inside the worktree, rerun the invalidated
checks, and repeat the same block unchanged. Never re-push blind and never report done from a bare
`git push` line. The landing merge is fast-forward only: never `--no-ff`, `--no-edit`, or a
non-fast-forward `git merge origin/main` on `main`. Push before publish, never after.

After that block, release from the integration checkout with the single Publish invocation below.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify another fetch, merge, or commit. Create no new scratch file outside `.devboard/`. Replace
`origin` and `main` when the repository names another canonical remote or branch.

## CI waits

Waiting for CI is `cd .devboard && bun run publish`, never a hand-built shell loop. Publish
fetches, rebuilds, waits for the `devboard-release.yml` run of `HEAD`, verifies the npm package and
the Gitea release assets, and exits nonzero when they are missing, so it is the whole wait: run it
once as the Publish section specifies and read its recorded exit code.

Never write the loop it replaces: `for i in $(seq 1 60); do curl ... /actions/runs/... ; sleep
...; done`, any bounded retry over `sleep`, or any backgrounded poll of the Gitea API. Twenty calls
across thirteen sessions took that shape: each iteration spends a turn, the harness backgrounds the
loop as `bg_N`, and its own output says not to poll. The named payload shapes are forbidden too:
`/actions/runs/<id>` for run `status`, `conclusion`, and `run_attempt`; `/commits/<sha>/status` for
`state`; a statuses read; and a "count busy runs" read over `/actions/runs?limit=N`.

The forge rule above already requires run reads through the `devboard` MCP tools, never `curl`.
When a wait genuinely cannot use `bun run publish` — a non-release run or a local `verify`
process — start exactly one long-lived background watcher whose whole lifetime is that wait, with
`async: true` and `timeout: 0`, and then end the turn. Never re-invoke or re-check the wait from a
foreground turn: no `sleep`, `ps`, `pgrep`, `kill -0`, `top`, log tailing, or a second wait command.
Read a run at most once, parse `status`, `conclusion`, and `run_attempt` from that one read, and
report what it says. When `status` is `completed`, report the conclusion and continue; when it is
not, the watcher's completion follow-up is the answer, so end the turn.

## Publish

Publishing is part of the task. Invoke `bun run publish` at most once per task, from the repository
root in the integration checkout, and only after the change is merged to `main` and pushed — never
from a worktree and never before the push. Run it as a background job that keeps the whole log and
the exit code:

```bash
cd .devboard && bun run publish > .tmp/publish-issue-<number>.log 2>&1; echo "EXIT:$?" >> .tmp/publish-issue-<number>.log
```

- Start this command with `async: true` and `timeout: 0`, so it has no tool deadline and keeps its
  job handle for the completion follow-up. Publish waits up to 1800 seconds for the release
  workflow, so the default call deadline aborts it at 300 seconds and reports `Command aborted`.
  That message means the launch was wrong, not that publish failed: inspect the still-running job
  and its recorded log, and never re-issue the command.
- Use this invocation verbatim and from the repository root: no absolute `cd` path such as
  `/home/...`, no `tail`/`head`/`tee` pipe or any other output consumer, no `--wait-timeout`
  override, and no second log file. The redirected log is the full output and its final line is
  the exit code. Publish already verifies `main`, the release workflow, the npm package, the
  release assets, and the mirror; the push block already owns the push proof, so add no
  `git ls-remote` or `git status` probe around the publish run. Read no release or workflow state
  through `curl`, `gh`, or `glab`; publish prints the verification result.
- Publish is long-running. While it runs, do other work or end the turn and wait for its
  completion follow-up. Never abort, kill, or re-invoke it while a run is pending, and never poll
  for it.
- An aborted, timed-out, or truncated publish call is inspected through the still-running job and
  its recorded log, never re-issued.
- A nonzero exit is never followed by an immediate identical re-run. Read the log, name the failing
  step, and fix the cause in a new commit. When the log reports
  `the release workflow concluded failure`, open that workflow run for the named commit and read
  its failing step; when the run's log is not reachable through the exposed tools, reproduce the
  workflow's own steps locally from the package root (`bun install --frozen-lockfile`,
  `bun run build`, `bun test`, `bunx tsc --noEmit`, each with `.devboard` as the working directory)
  and fix the step that fails. Land the fix and report the failing step, the fix commit, and the
  recorded exit code. Publishing the fixed revision belongs to the next task, never to this one.
- Never re-run publish in the same session to see its output, to confirm success, to retry the same
  commit, or with a different log file or deadline.
- Report the recorded exit code as the publish result. Close the issue with `issue_close` only
  after that value is `0` and the pushed revision is verified on the canonical integration line.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

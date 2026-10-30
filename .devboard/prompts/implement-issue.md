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
- Before the first forge read or write, gate the run exactly once per session with the canonical,
  argument-free auth check, run verbatim from the repository root:

  ```sh
  bun .devboard/scripts/forge-auth.ts check --required write --json
  ```

  This is the only pre-write auth gate and the only auth invocation of the run. The canonical
  form infers the forge, host, project, and identity from the `origin` remote and
  `DEVBOARD_GITEA_URL`, so never pass `--host`, `--project`, or `--url` on that call; never
  derive those values with `sed`, `git remote get-url`, or any other shell substitution. Pass
  the forge explicitly only when the `origin` remote cannot name it and the target is the
  configured Gitea:

  ```sh
  bun .devboard/scripts/forge-auth.ts check --forge gitea --required write --json
  ```

  Read the JSON line and proceed only when the exit status is 0 and `canWrite` is `true`. Any
  other outcome — a nonzero exit, or an exit 0 without `canWrite: true` — stops the run: report
  the script's message verbatim, and when the result is JSON, its `error` and `permission`
  fields verbatim. Never retry across `localhost`, `localhost:2223`, `localhost:3001`, `origin`,
  `ds@localhost:2223`, `gitea`, `127.0.0.1`, a bare IP, or a bare port, and never re-derive the
  host with `git remote get-url origin | sed` or any other shell substitution. Never prefix the
  call with `cd <path>`, never append `echo $?`,
  `echo "exit=$?"`, `echo "EXIT:$?"`, or any other exit-status echo, never append `2>&1 | head`,
  `2>&1 | tail`, or any other consumer, and never append `env | grep` or a `printenv` sweep. The
  credentialed target is `DEVBOARD_GITEA_URL` with `GITEA_TOKEN`; a host is a label only, so
  never pass `origin`, `github.com`, `localhost`, `localhost:3000`, `localhost:2223`,
  `localhost:3001`, `127.0.0.1`, `ds@localhost:2223`, `gitea`, a bare IP, or a bare port as
  `--host`. Do not rerun the check in the same session. That JSON line, plus the resolution
  fields `devboard_status` returns, is the only supported way to learn the forge host, project,
  or credential state: both report presence and resolution without exposing a value, so an
  environment sweep answers nothing they do not. Forge and registry configuration MUST be
  resolved through `bun .devboard/scripts/forge-auth.ts check` and MUST NOT be discovered with
  an `env | grep` probe, `cat .env`, `cat ~/.npmrc`, or any other environment or credential-file
  sweep: never enumerate the process environment or hunt for credential files, and
  `.devboard/prompts/forge-auth.md` holds that rule in full. `DEVBOARD_GITEA_URL` is supplied by
  the host at run time, so never hardcode it or fall back to a guessed base such as
  `http://localhost:2223`: the check reads the real value, and a wrong guess only costs a round
  trip. Never pipe `env` or `printenv` into `grep` (an `env | grep` probe) for `gitea`, `forge`,
  `github`, `gitlab`, or `token`, and never treat `sed`-based masking as redaction: the tool
  shell carries an exported `MATCH` variable holding a token-bearing grep match
  (`MATCH='GITEA_TOKEN=…'`), so an echoed `MATCH=` line re-leaks the value, and whole-value
  filters miss differently named variables such as `GITHUB_APM_PAT`. Emit a credential only as
  `<set>` or `<redacted>`, never as a value or a prefix of one; when a variable must be checked,
  print only a boolean, `[ -n "$GITEA_TOKEN" ] && echo set`.
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

- Run `bun install --frozen-lockfile` only from the package root that owns the lockfile: the tool's
  `cwd` is `.devboard/` in the canonical checkout, or `<worktree>/.devboard/` in a task worktree.
  Never run it from the repository root, and never prefix it with `cd <path> &&` because the
  working directory was not already correct — set `cwd` instead.
- Skip the install when the package root (`.devboard/`) already has `node_modules` and `bun.lock`
  has not changed since that install. Run it at most once per session: installing is a precondition,
  never a verification step, and it never repeats before each build, typecheck, or test.
- Let the install's output through whole: never pipe it to `tail`, `head`, or any other consumer,
  and never append an `echo "EXIT:$?"` or `echo "..._EXIT:$?"` status probe. It prints one summary
  line on success and the full error on failure, and a nonzero exit already reports the failure.
- Chain it with `&&` only into a step that must run after a successful install, such as
  `bun run build`; never chain it to an unrelated command, and never re-run it to re-inspect output
  a consumer truncated. Run it once, then run build, typecheck, and tests as separate commands.
- `verification_run` runs an allowlisted check from the `.devboard/` that `devboard_status` reports
  as `harnessDirectory`. Use it for `bun run verify:interface`, as *Interface verification* below
  requires. When it resolves the canonical package root while you work in a worktree, run that
  same check from `<worktree>/.devboard/` so the changed revision is what executes; that is the
  only allowed shell invocation of the check.

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
  the only way to run the check: never invoke `bun run verify:interface` from a shell in that case,
  because the tool result is the whole verdict and the shell form only repeats the same run.
- Only when `devboard_status` reports the canonical `<REPO_DIR>/.devboard` while you work in a
  worktree does the tool verify the pre-change revision. Then run `bun run verify:interface` once,
  in the foreground, from `<worktree>/.devboard`, and say in the final response that the tool's
  resolved `harnessDirectory` was the canonical root. Every other direct invocation is forbidden.
- Never background `verify:interface`, never kill or restart it, and never pipe it through `tail`,
  `head`, `grep`, or another consumer. A backgrounded job ends the turn without its verdict, a
  killed job loses the assertion, and a pipe keeps only the lines the filter matched.
- Never redirect verification output to `.tmp/verify-interface-*.log` or `.verify-interface.log` and
  then `tail` it, never pipe it through `2>&1 | tee`, and never take a verdict from a log an earlier
  run wrote. The verdict belongs to the turn that started the check.
- `truncated: true` means the 16 KiB capture bound cut the run and `output` holds only its
  beginning: `exitCode` is still the verdict, and a truncated result is never a pass. A result
  ending `[timed out after 900000 ms]` is a failed verification, not a reason to background the
  check.
- On failure, read the complete `verify:interface: <assertion>: <evidence>` line before editing:
  the assertion names the control, and the evidence object carries the measured and expected
  values it compared. A partial read hides which side mismatched. Report that exact line and the
  result's `exitCode` in the final response instead of re-running the check or paraphrasing it.
- When `verification_run` itself errors, report the tool's error text verbatim together with the
  `exitCode` and `output` it returned, and never answer it with `bun run verify:interface` from a
  shell, a retry in another directory, or a redirected log. A tool error is evidence to report,
  not a reason to rerun the same check.

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

- Every shell call must carry a substantive command. A bare `true`, a `cd <root> && true` prefix, or
  an `&& true`/`; true` suffix with no other effect is never a valid call: it burns a round trip,
  records no evidence, and hides whether the step it stood for ran. Each call must answer the
  question it was made for, and its output must be read; an exit-status placeholder is not a
  diagnostic.
- To confirm the working directory, run `pwd` or `git rev-parse --show-toplevel`; to confirm a path
  exists, run `ls <path>`. Never stand in for either with `cd <root> && true`.
- `|| true` and `; true` are permitted only when the exit status is genuinely irrelevant and you
  state the reason. When the failure itself is the answer, run the probe bare and read its nonzero
  status instead of masking it with `|| true`. An absent match on a `grep` or `ls` probe is the
  expected result, so its empty output needs no suffix.
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

Every commit subject MUST be a Conventional Commit, `<type>[(<scope>)][!]: <description>`, with
`<type>` one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. `prompt` is not an allowed type: `prompt:` and `prompt(implement-issue):` are
rejected by the pre-push commit gate, which names each offending `<sha> <subject>` and the rule it
broke and adds no ref. Reword a rejected commit before landing — `git commit --amend` for the tip,
an interactive rebase for earlier commits — and retry the push. Never pass `--no-verify` and never
edit or remove an installed hook. Surface a commit-gate rejection and a
`! [rejected] … (non-fast-forward)` rejection unmodified: report their exact lines and resolve the
cause they name before retrying, and never trim the rejection with `tail`, `head`, `grep`, or any
other consumer.

Commit in the worktree on the run's own task branch. When `main` has moved since the branch was
cut, rebase the task branch onto `origin/main` inside the worktree and rerun the checks the rebase
invalidates before landing; a rebase that reports the branch is up to date is the normal case.

Read the worktree's sync state with one `git status --short --branch` call, run in the worktree
after the fetch required before landing. That call reports the branch, its upstream, and the
ahead/behind counts in that order, and those counts are the divergence proof. Add
`git log --oneline -3` only when commit subjects are needed, and `git rev-parse --short HEAD
origin/main` only when hashes are needed, in the same call:

```sh
git status --short --branch
```

An unpublished task branch has no upstream, so its status line carries no counts: add exactly one
`git rev-list --left-right --count HEAD...origin/main` to that same call, which prints
`<HEAD-only> <origin/main-only>` in ref order, and read it as the divergence proof. Never chain a
bare `git rev-parse --short <branch>` with a following `git rev-list --left-right --count` for the
same question. Guard any optional branch that may not exist yet with
`git rev-parse --verify --quiet <branch>`, which prints nothing instead of exiting 128 with
`fatal: Needed a single revision`; never use a bare `git rev-parse --short <branch>` for such a
ref. Use `git merge-base --is-ancestor <sha> origin/main` only to confirm one named commit landed:
exit 0 means it is an ancestor, 1 means it is not, and any other status, such as 128 with
`fatal: Not a valid object name`, means a ref is missing or the command itself failed, never that
the commit is unrelated. When a ref looks missing, fetch `origin main` and read the same sync call
again before concluding anything.

Then land it with this one canonical sequence from the canonical checkout, on `main`:

```sh
git fetch origin main
git merge --ff-only origin/main
git merge --ff-only <task-branch>
```

The fetch names the tip, the first merge fast-forwards `main` to it, and the second adds the task
branch. Run the sequence once per landing attempt: no `&&` chain between its lines, no `tail`
pipe, and no `PIPESTATUS` probe. Never create a pull request or merge request.

Before pushing, read the behind state against the tip the fetch named with this one pre-push
probe, run in the canonical checkout and read as-is:

```sh
git fetch origin && git status --short --branch && git rev-list --left-right --count HEAD...origin/main
```

It prints `<HEAD-only> <origin/main-only>`. Push only when the second count is `0`: a nonzero
second count means `main` is behind the fetched tip, so integrate instead of pushing — rebase the
task branch onto `origin/main` inside the worktree, rerun the checks the rebase invalidates,
repeat the landing sequence, and run the probe again. Never push a behind branch, and never answer
a behind result with a bare retry.

Push and prove the push with this one block, run verbatim once after the probe, in the canonical
checkout and read as-is:

```sh
git push origin main; echo "PUSH_EXIT:$?"; git status --short --branch; printf 'local  %s\nremote %s\n' "$(git rev-parse HEAD)" "$(git ls-remote origin refs/heads/main | cut -f1)"; git rev-list --left-right --count origin/main...HEAD
```

It is one push invocation: its exit status on the `PUSH_EXIT:` line, the post-push branch state,
the local and remote commits, and the post-push count all come from that command. The push is
verified only when `PUSH_EXIT:0` prints, `git status --short --branch` reports no ahead/behind
marker, the two SHAs are identical, and `git rev-list --left-right --count origin/main...HEAD`
prints two zero counts. Never pipe `git push` into `tail`, `head`, or any other consumer: the
`tail -3`, `tail -4`, `tail -5`, `tail -8`, and `tail -10` variants discard the rejection text and
the exit status. Never use `git log` or a trimmed merge output as the push proof, and run the
block once per landing attempt: it is the only post-push readback, and this prompt excludes any
other `git ls-remote`, `git log`, and a second `git status` readback.

Equal tips prove the landing commit is the canonical tip. The block is the complete done check:
`git ls-remote origin refs/heads/main` proves the remote tip, and
`git rev-list --left-right --count origin/main...HEAD` proves both sides are even. Read it once and
move on: never follow it with a per-commit re-check, a `git log` dump, or a Gitea
actions-endpoint query in the same breath, and never re-verify an integrated commit with
`git merge-base --is-ancestor <full-sha> …` — the count already answers whether the work landed.
When a different ancestry question genuinely arises, answer it with one `git branch --contains
<sha>` or one `git merge-base --is-ancestor <sha> origin/main` to confirm that one commit landed,
and stop. Never split the block into separate commands, drop its push, reorder it, or rerun it to
reconfirm output it already printed; a nonzero exit from it is evidence to read. Fetch at most
twice in a session before the push block, and fetch again only after a push, merge, or rebase
happened since the previous fetch.

Never delete the worktree until the remote tip equals the integrated commit; `git ls-remote
origin refs/heads/main` is that proof, and a worktree whose branch is unproven on the remote stays
in place. A local-only merge or a deleted worktree before that equality is a failed task.

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

A nonzero `PUSH_EXIT` or differing local and remote commits is a rejected or unproven push: report
the rejection lines the block printed as-is, fetch the new tip, rebase the task branch onto
`origin/main` inside the worktree, rerun the invalidated checks, and repeat the same block
unchanged. Never re-push blind, never substitute a different ad-hoc verification command, and never
report done from a bare `git push` line. The landing merge is fast-forward only: never `--no-ff`,
`--no-edit`, or a non-fast-forward `git merge origin/main` on `main`. Push before publish, never
after.

After that block, release from the integration checkout with the single Publish invocation below.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify another fetch, merge, or commit. Create no new scratch file outside `.devboard/`. Replace
`origin` and `main` when the repository names another canonical remote or branch.

## CI waits

Waiting for CI has exactly two sanctioned forms, and nothing else. The first is `bun run publish`
for the `devboard-release.yml` run of `HEAD`: `bun run publish --wait-timeout N` blocks on that run
for up to `N` seconds (1800 by default), then verifies the npm package and the Gitea release
assets, so its recorded exit code is the whole wait. Run it once as the Publish section specifies,
with its `--wait-timeout 1800` bound and with `timeout: 0` on the tool call.

The second is one long-lived background watcher whose whole lifetime is that wait — a non-release
run or a local `verify` process that publish does not cover — started with `async: true` and
`timeout: 0`, after which the turn ends.

Never poll a workflow run with a hand-rolled `for i in $(seq 1 60)` loop over `/actions/runs/<id>`.
The banned shape is `for i in $(seq 1 60); do curl ... /actions/runs/<id> ...; sleep ...; done`:
any bounded retry over `sleep`, any backgrounded poll of the Gitea API, and these payload reads —
`/actions/runs/<id>` for run `status`, `conclusion`, and `run_attempt`, `/commits/<sha>/status` for
`state`, a statuses read, and a "count busy runs" read over `/actions/runs?limit=N`. Twenty calls
across thirteen sessions took that shape: each iteration spends a turn, the harness backgrounds the
loop as `bg_N`, and its own output says not to poll.

The forge rule above already requires run reads through the `devboard` MCP tools, never `curl`.
One wait per run is the rule: start the sanctioned wait once, then end the turn. Never re-issue the
same wait in a later turn, and never re-invoke or re-check it from a foreground turn — no `sleep`,
`ps`, `pgrep`, `kill -0`, `top`, log tailing, `/proc` read, or second wait command. When the wait
itself reads a run, read it at most once, parse `status`, `conclusion`, and `run_attempt` from that
one read, and report what it says: `completed` means report the conclusion and continue; otherwise
the watcher's completion follow-up is the answer, so end the turn.

## Publish

Publishing is part of the task. Invoke `bun run publish` at most once per issue, from the repository
root in the integration checkout, and only after the change is merged to `main` and pushed — never
from a worktree and never before the push. Run it as a background job that keeps the whole log and
the exit code:

```bash
cd .devboard && bun run publish --wait-timeout 1800 \
  > .tmp/publish-<number>.log 2>&1; echo "EXIT:$?" >> .tmp/publish-<number>.log
```

- Start this command with `async: true` and `timeout: 0`, so it has no tool deadline and keeps its
  job handle for the completion follow-up. Publish waits up to 1800 seconds for the release
  workflow, so the default call deadline aborts it at 300 seconds and reports `Command aborted`.
  That message means the launch was wrong, not that publish failed: inspect the still-running job
  and its recorded log, and never re-issue the command.
- Use this invocation verbatim and from the repository root: no absolute `cd` path such as
  `/home/...`, no `tail`/`head`/`tee` pipe or any other output consumer, no `--wait-timeout`
  value other than `1800`, and no second log file. The redirected log is the full output and its
  final line is the exit code. Publish already verifies `main`, the release workflow, the npm
  package, the release assets, and the mirror; the push block already owns the push proof, so add
  no `git ls-remote` or `git status` probe around the publish run. Read no release or workflow
  state through `curl`, `gh`, or `glab`; publish prints the verification result.
- Publish is long-running. While it runs, do other work or end the turn and wait for its
  completion follow-up. Never abort, kill, or re-invoke it while a run is pending, and never poll
  for it.
- An aborted, timed-out, or truncated publish call is inspected through the still-running job and
  its recorded log, never re-issued.
- A nonzero exit is never followed by an immediate identical re-run, and no second `bun run publish`
  starts for the same issue after the release workflow concluded failure until the failing step is
  diagnosed, fixed, committed, and pushed. Read the log, name the failing step, and fix the cause
  in a new commit. When the log reports
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

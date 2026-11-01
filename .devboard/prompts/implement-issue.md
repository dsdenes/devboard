---
description: Implement exactly one open issue, integrate it into the canonical line, and close it only after the push is verified.
---

`/implement-issue <number>`: implement exactly one open issue end to end.

The argument must be exactly one positive integer issue number. If it is missing, non-numeric, or
carries more than one token, refuse before changing anything: write the refusal to stderr, exit
nonzero, and stop. Never guess an issue number and never accept a range, a list, or a URL.

This run serves one issue. After the single `devboard_status` host-resolution call and the auth gate
in *Inputs and paths*, read exactly that one issue with `issue_get` and never fetch, survey, or
build a dependency graph for the rest of the backlog. You may read other issues and code for
context, but you never edit, comment on, close, or reopen another issue.

## Inputs and paths

- Resolve the session's host exactly once, before any forge read or write: make one argument-free
  `devboard_status` MCP call and take `<REPO_DIR>` from its `repositoryRoot`, along with
  `harnessDirectory` and `stateDirectory`. That one call is the whole checkout-orientation step,
  and the canonical checkout is `<REPO_DIR>` itself. Issue it before, and exactly once before, the
  `forge-auth.ts check` below, and never repeat it later in the session.
- Never orient the session with a shell probe, and never chain orientation probes: no
  `git remote get-url origin` or `git remote get-url github`, no `git config --get
  remote.origin.url`, no `git rev-parse --show-toplevel`, no `ls` of `.devboard`'s scripts
  directory, no `env | grep`, and no
  `cd <root> && … && bun .devboard/scripts/forge-auth.ts check` line. The `devboard_status`
  result covers the roots and the `forge-auth.ts check` JSON line below covers the forge, host,
  project, and identity; neither is re-derived to orient the run.
- Fall back to a shell probe only for a field neither the `devboard_status` result nor the auth
  gate reports, and then at most one probe, run alone: never a chained discovery line, never
  `git remote get-url origin`, and never a probe that merely confirms a value one of them already
  reported.
- Worktree root: `<REPO_DIR>/.worktree/`. Create and work in exactly one worktree there, named for
  the issue, for example `<REPO_DIR>/.worktree/issue-<number>`. Never work in the canonical
  checkout, never use another agent's worktree, and write nothing outside `<REPO_DIR>` — no
  temporary file, log, cache, or build output elsewhere. A scratch file that is genuinely
  required belongs inside `<REPO_DIR>/.devboard/` and is removed after use; never write `/tmp/x`
  or any other path outside the repository root.
- Before the first forge read or write, and after the single `devboard_status` call above, gate
  the run exactly once per session with the canonical, argument-free auth check, run verbatim from
  the repository root:

  ```sh
  bun .devboard/scripts/forge-auth.ts check --required write --json
  ```

  This is the only pre-write auth gate and the only auth invocation of the run. The canonical
  form infers the forge, host, project, and identity from the `origin` remote and
  `DEVBOARD_GITEA_URL`, so this check has exactly one spelling: that literal command line, with
  no `--forge`, `--host`, `--project`, or `--url` override and no derived replacement for any of
  them. Never derive those values with `sed`, `git remote get-url`, or any other shell
  substitution; when the `origin` remote cannot name the forge, stop and report that as the
  blocker instead of guessing a `--forge` override.

  Invoke that one line alone: never prefix it with `cd <absolute path> &&` or
  `git rev-parse --show-toplevel &&`, and never chain it into a compound command with a `curl`
  request to the forge API or any other command. Set the tool's working directory to the
  repository root instead of prefixing the command.

  Read the JSON line and proceed only when the exit status is 0 and `canWrite` is `true`; trust
  its `canWrite`, `permission`, and `source` fields for every later forge step instead of
  re-checking. A successful result is reused for the rest of the session: never run the check a
  second time, and never re-run it to confirm a result already read. Only a nonzero exit, or an
  exit 0 without `canWrite: true`, stops the run, and only that failure justifies one `--help`
  inspection or the blocker report: report the script's message verbatim, and when the result
  is JSON, its `error` and `permission` fields verbatim. Never retry across `localhost`,
  `localhost:2223`, `localhost:3001`, `origin`, `ds@localhost:2223`, `gitea`, `127.0.0.1`, a bare
  IP, or a bare port, and never re-derive the host with `git remote get-url origin | sed` or any
  other shell substitution. Never append `echo $?`, `echo "exit=$?"`, `echo "EXIT:$?"`, or
  any other exit-status echo, never append `2>&1 | head`, `2>&1 | tail`, or any other consumer,
  and never append `env | grep` or a `printenv` sweep. The credentialed target is
  `DEVBOARD_GITEA_URL` with `GITEA_TOKEN`; a host is a label only, so
  never pass `origin`, `github.com`, `localhost`, `localhost:3000`, `localhost:2223`,
  `localhost:3001`, `127.0.0.1`, `ds@localhost:2223`, `gitea`, a bare IP, or a bare port as
  `--host`. Do not rerun the check in the same session. That JSON line is the only supported way
  to learn the forge host, project, or credential state: it reports presence and resolution
  without exposing a value, so an environment sweep answers nothing it does not. Forge and
  registry configuration MUST be
  resolved through `bun .devboard/scripts/forge-auth.ts check` and MUST NOT be discovered with
  an `env | grep` probe, `cat .env`, `cat ~/.npmrc`, `git config --get-regexp 'url\..*'`, or any
  other environment or credential-file sweep: never enumerate the process environment or hunt
  for credential files, and `.devboard/prompts/forge-auth.md` holds that rule in full. Never
  read or grep `.devboard/scripts/forge-auth.ts` to rediscover its resolution order; read that
  file only when the run changes it. `DEVBOARD_GITEA_URL` is supplied by the host at run time:
  use it exactly as supplied, verbatim, with no derived or default port, so never hardcode it
  or fall back to a guessed base such as `http://localhost:2223`. Verify access only through
  the `check --json` call above; never probe a forge endpoint such as `/api/v1/version` to
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
  `stateDirectory` the single `devboard_status` call above resolved; never issue a second
  `devboard_status` call. `issue_get` with `{"number": <number>}` returns that issue's title,
  body, labels, state, and URL on whichever forge the repository uses. Use `issues_list` only to
  confirm the state of a referenced prerequisite, never to survey the backlog.
- Forge state — issues, labels, releases, and workflow runs or jobs — MUST be read and mutated
  through the `devboard` MCP tools: `issue_get` and `issues_list` for reads, `issue_close` for the
  one close, and `verification_run` for an allowlisted check. NEVER source `.env` (including
  `set -a; . ./.env; set +a`) or call `curl` with `$GITEA_TOKEN` or `$DEVBOARD_GITEA_URL` to read
  or write an issue, label, run, job, or release. Never call `gh` or `glab` for a tracker read or
  mutation. Release and workflow verification goes through `bun run publish` as specified below,
  never through a forge API.

## Fetch budget

The budget covers the whole session, not only the push block. Read the canonical remote tip once
and answer every later question about it from that fetch.

- One spelling: `git fetch origin`, or `git fetch origin <canonical-branch>` when the question
  names a branch. Never add `--prune`, `--quiet`, `--tags`, or `--all`, and never fetch another
  remote, unless a deleted ref, a tag, or that other remote is itself the question.
- One fetch answers every later question about that tip in the same turn. A further fetch needs a
  push, merge, or rebase since the previous one, and a session fetches at most twice before the
  push block.
- A ref that looks missing earns a fetch only after `git rev-parse --verify --quiet <ref>` printed
  nothing.
- Never fetch to learn CI, release, or dashboard state: the publish run and the forge report it.

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
  working directory was not already correct — set `cwd` instead. Always pass `--frozen-lockfile`:
  never a plain `bun install`, which may rewrite `bun.lock`.
- Skip the install when the package root (`.devboard/`) already has `node_modules` and `bun.lock`
  has not changed since that install. Run it at most once per session: installing is a precondition,
  never a verification step, and it never repeats before each build, check, test, or verify step.
- Let the install's output through whole: never pipe it to `tail`, `head`, or any other consumer,
  and never append an `echo "EXIT:$?"` or `echo "..._EXIT:$?"` status probe. It prints one summary
  line on success and the full error on failure, and a nonzero exit already reports the failure.
- Chain it with `&&` only into a step that must run after a successful install, such as
  `bun run build`; never chain it to an unrelated command, and never re-run it to re-inspect output
  a consumer truncated. Run it once, then run build, typecheck, and tests as separate commands.
- `verification_run` runs an allowlisted check from the `.devboard/` that the `devboard_status`
  result reports as `harnessDirectory`. Use it for interface verification, as *Interface
  verification* below requires. When it resolves the canonical package root while you work in a
  worktree, run that same check from `<worktree>/.devboard/` so the changed revision is what
  executes; that is the only allowed shell invocation of the check.

## Interface verification

`bun run verify:interface` builds the client, starts a source dashboard, drives headless Chrome,
and throws the whole assertion message plus its JSON evidence object on the first failure. A lost
assertion therefore costs a full rerun, so interface verification has its own rule.

Interface verification has exactly one entry point: the `verification_run` MCP tool with
`{"check": "verify:interface"}`. The tool executes the `verify:interface` script from
`.devboard/package.json` with the resolved `harnessDirectory` as its working directory, kills the
check's whole process group at its 900-second bound, and returns `check`, `exitCode`, `output`,
`truncated`, and `log` in one result. A bare `bun run verify:interface`, a `tail`/`head`/`grep`
pipe, and a log an earlier run wrote are never a verdict.

- Use `repositoryRoot` and `harnessDirectory` from the single `devboard_status` call above; never
  issue another `devboard_status` call. When `harnessDirectory` is the `.devboard/` you changed,
  the tool verifies the changed revision and is the only way to run the check: never invoke
  `bun run verify:interface` from a shell in that case, because the tool result is the whole
  verdict and the shell form only repeats the same run.
- Only when that same result reports the canonical `<REPO_DIR>/.devboard` while you work in a
  worktree does the tool verify the pre-change revision. Then run the changed revision once from
  `<worktree>/.devboard`, after creating the log directory with `mkdir -p .tmp` from that package
  root: a fresh worktree has no `.tmp`, and a redirect into a directory that does not exist fails
  with `No such file or directory (os error 2)` before the verifier starts. Never redirect into a
  path you have not created. Since the check can run for many minutes, start it as a background job
  with no deadline — `async: true`, `timeout: 0` — writing its complete output to
  `.tmp/verify-interface.log` with `bun run verify:interface > .tmp/verify-interface.log 2>&1`, then
  end the turn and read that log and the job's exit status from its completion follow-up. Its exit
  status is the verdict, so never append a status echo. Say in the final response that the tool's
  resolved `harnessDirectory` was the canonical root. Every other direct invocation is forbidden.
- The complete output of every interface verification lives at `.devboard`'s
  `.tmp/verify-interface.log`: the tool writes that file itself and returns its path in `log`, and
  the worktree fallback redirects there. Read the file whole on failure — never `tail`, `head`,
  `grep`, or `2>&1 | tee` it — so the failing check message and its evidence JSON survive instead of
  a fixed number of trailing lines. Never take a verdict from a log an earlier run wrote: the tool
  truncates the file before the check starts and the fallback redirect truncates it too.
- Never kill or restart `verify:interface`: a killed job loses the assertion. The
  `verification_run` call itself is never backgrounded; it returns the verdict in one result. For
  the shell fallback, a job status line such as `Backgrounded as job bg_N` and an empty
  `(no output)` result are never failure details: read the complete log file and the job's exit
  status before concluding anything.
- `truncated: true` means the 16 KiB bound cut the returned `output`; the `log` file still holds the
  complete output. `exitCode` is still the verdict, and a truncated result is never a pass. A result
  ending `[timed out after 900000 ms]` is a failed verification, not a reason to background the
  check.
- On failure, read the complete `verify:interface: <assertion>: <evidence>` line from the log before
  editing: the assertion names the control, and the evidence object carries the measured and
  expected values it compared. A partial read hides which side mismatched.
- A minified client runtime error such as `undefined is not an object (evaluating 'ne.cancelled')`
  is not a diagnosis, and a stale bundle is only a hypothesis until it is checked. The verifier
  builds the client before it starts the dashboard, so confirm the bundle matches the source by
  running `bun run build` from `.devboard` and rerunning the verifier once. Report the minified
  message only when it reproduces after that build, and never present it as the failing assertion.
- Reproduce a failure once at the base revision before you touch code, and classify it. In a
  worktree session whose tool run used the canonical `.devboard/`, that tool result is the base run
  and the fallback shell run is the changed revision; when both print the same assertion and
  evidence, the defect is a pre-existing baseline failure — do not fix it in this run, record its
  exact message, and continue. When no base run is available, say so and classify from the diff,
  never by stashing, reverting, or rewriting the task worktree.
- Never run an identical failing `verify:interface` invocation more than twice: once for the
  changed revision and once for the base revision.
- Report the exact assertion line, its evidence JSON, and the `exitCode` in the final response.
  Never answer a failure with a bare exit code, a paraphrase, or a re-run.
- When `verification_run` itself errors, report the tool's error text verbatim together with the
  `exitCode`, `output`, and `log` it returned, and never answer it with `bun run verify:interface`
  from a shell, a retry in another directory, or a redirected log. A tool error is evidence to
  report, not a reason to rerun the same check.

## Discovery verification

`bun run verify:discover` runs in the foreground from the package root, with its output reaching
the session transcript: never redirect it to `.tmp/verify-discover.log` or any other file, and
never pipe it through `tail`, `head`, or `grep`. Read its `PASS` lines and, on failure, the
`verify:discover:` message with its stack frame from the live run, and report them.

- An exit 1 that prints no output after roughly 30 seconds, or a trace that stops at the
  `while (Date.now() < deadline)` poll in `scripts/verification.ts`, is a scenario timeout, not an
  unknown failure: the `timed out waiting for <description>` line names the stalled scenario, and
  the newest `.tmp/verify-discover-*` directory in the harness root holds its log. Read that log,
  fix or restart the dependency it names, and only then rerun.
- Never rerun the same failing invocation without an intervening change or that log inspection:
  the second identical run adds no information and burns another scenario timeout.

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
`git log --oneline -3` only when commit subjects are needed, and one
`git rev-parse --short=12 <rev>` per revision only when a short hash is needed, in the same call:

```sh
git status --short --branch
```

One revision per `git rev-parse --short=12` call: `git rev-parse --short=12 HEAD origin/main`
exits 128 with `fatal: Needed a single revision` even when both refs exist, because `--short`
accepts exactly one revision. That message reports a ref that did not resolve to one revision — a
missing ref, or several revisions passed to one `--short` call — never that the branches diverged.
Invoke the command once for each revision whose hash is needed and never pass several revisions to
one `--short` call.

An unpublished task branch has no upstream, so its status line carries no counts: add exactly one
`git rev-list --left-right --count HEAD...origin/main` to that same call, which prints
`<HEAD-only> <origin/main-only>` in ref order, and read it as the divergence proof. Never chain a
bare `git rev-parse --short=12 <branch>` with a following `git rev-list --left-right --count`
for the same question. Guard any optional branch that may not exist yet with
`git rev-parse --verify --quiet <branch>`, which prints nothing instead of exiting 128 with
`fatal: Needed a single revision`; never use a bare `git rev-parse --short=12 <branch>` for such a
ref. Use `git merge-base --is-ancestor <sha> origin/main` only to confirm one named commit landed:
exit 0 means it is an ancestor, 1 means it is not, and any other status, such as 128 with
`fatal: Not a valid object name`, means a ref is missing or the command itself failed, never that
the commit is unrelated. When a ref looks missing, prove it absent with `git rev-parse --verify
--quiet <ref>` first, then fetch `origin main` under the fetch budget and read the same sync call
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

Push, then prove the push with this one canonical sync check, run verbatim once after the push, in
the canonical checkout and read as-is:

```sh
git push origin main; echo "PUSH_EXIT:$?"
git status --short --branch
git rev-list --left-right --count HEAD...origin/main
git rev-parse HEAD
git rev-parse origin/main
git ls-remote origin refs/heads/main
```

The first line is the only push invocation. The push is verified only when `PUSH_EXIT:0` prints,
`git status --short --branch` reports no ahead/behind marker, the count is `0 0`, and the SHA
`git rev-parse HEAD` prints equals the SHA `git rev-parse origin/main` prints and the SHA
`git ls-remote` reads for `refs/heads/main`. `0 0` means neither side has a commit the other lacks,
and the matching SHAs say the fetched tip, the local branch, and the remote tip are the landing
commit. Resolve `HEAD` and `origin/main` in separate `git rev-parse` calls: never pass `HEAD`,
`origin/main`, and an issue branch to one invocation, because one missing ref aborts the whole
command. `fatal: Needed a single revision` is a ref-resolution error — a missing ref, or several
revisions where exactly one is expected — never a divergence signal. Run this check once per
landing attempt and stop. After it passes, never repeat it in the same session — no second
`git status --short --branch`, `git rev-list`, `git ls-remote`, `git log`, or `git merge-base`
readback to reconfirm output it already printed. Never append `tail`, `head`, `diff`, `git status`,
`git rev-list`, a `PIPESTATUS` echo, or any other probe to the `git push` line: those suffixes
discard the rejection text or its exit status, and the sync check's separate lines are the one
verification. Never use `git log` or a trimmed merge output as the push proof. The fetch budget
above governs the push block too: the landing fetch and the pre-push probe answer every question
about `HEAD...origin/main`, the sync check reads the remote tip directly without fetching, and a
further fetch needs a push, merge, or rebase since the previous one.

An equal tip proves the landing commit is the canonical tip; `PUSH_EXIT:0`, `0 0`, and matching
`git rev-parse` and `git ls-remote` SHAs are the complete done check. Read the check once and move
on: never follow it with a per-commit re-check, a `git log` dump, or a Gitea actions-endpoint query
in the same breath. When a different ancestry question genuinely arises, answer it with one
`git branch --contains <sha>` or one `git merge-base --is-ancestor <sha> origin/main` to confirm
that one commit landed, and stop. Never split the check into separate calls, drop its push, reorder
it, or rerun it to reconfirm output it already printed; a nonzero `PUSH_EXIT`, a nonzero count, an
ahead/behind marker, or a SHA that differs from the `git ls-remote` SHA is evidence to read.

Never delete the worktree until the canonical sync check printed `PUSH_EXIT:0`, `0 0`, an unmarked
status, and matching `git rev-parse` and `git ls-remote` SHAs; that is the proof the integrated
commit landed, and a worktree whose branch is unproven on the remote stays in place. A local-only
merge or a deleted worktree before that equality is a failed task.

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

A nonzero `PUSH_EXIT`, a nonzero count, an ahead/behind marker, or a `git rev-parse` SHA that
differs from the `git ls-remote` SHA is a rejected or unproven push: report the rejection lines the
check printed as-is, fetch the new tip, rebase the task branch onto `origin/main` inside the
worktree, rerun the invalidated checks, and repeat the same check unchanged. Never re-push blind,
never substitute a different ad-hoc verification command, and never report done from a bare
`git push` line. The landing merge is fast-forward only: never `--no-ff`, `--no-edit`, or a
non-fast-forward `git merge origin/main` on `main`. Push before publish, never after.

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

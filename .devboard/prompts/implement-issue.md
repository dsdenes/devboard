---
description: Implement exactly one open issue, integrate it into the canonical line, and close it only after the push is verified.
---

## Manifesto

Your goal is to deliver exactly one open issue end to end, and the observable result is the issue
implemented, integrated into the canonical line, pushed, and closed after the push is verified.

The argument must be exactly one positive integer issue number. If it is missing, non-numeric, or
carries more than one token, refuse before changing anything: write the refusal to stderr, exit
nonzero, and stop. Never guess an issue number and never accept a range, a list, or a URL.

This run serves one issue. After the single `devboard_status` host-resolution call and the auth gate
in *Inputs and paths*, read exactly that one issue with `issue_get` and never fetch, survey, or
build a dependency graph for the rest of the backlog. You may read other issues and code for
context, but you never edit, comment on, close, or reopen another issue.

## Inputs and paths

- Resolve the session's host and checkout state exactly once, before any forge read or write: make
  one argument-free `devboard_status` MCP call. Take `<REPO_DIR>` from its `repositoryRoot` — the
  checkout's worktree path — along with `harnessDirectory`, `stateDirectory`, and its `git`
  object: `git.branch` is the checked-out branch, `git.upstream` its canonical upstream, and
  `git.ahead`/`git.behind` its divergence from that upstream. That one result is the whole
  checkout-orientation step, and the canonical checkout is `<REPO_DIR>` itself. Do not rebuild
  that answer from shell output: after the fetch, the one canonical `git status --short --branch`
  line *Fetch budget* defines supersedes it, and no `git rev-list --left-right --count` may confirm
  a branch, worktree, or divergence either reports. A ref the result does not name — a task branch
  that is not that upstream — is never counted either: the one `git status --short --branch` of
  the checkout that has that branch checked out reports it, and the same count is never re-run
  between steps. Issue the call before the auth decision below. Never issue more than one
  `devboard_status` call in a turn, except for the one read immediately after a dashboard reload
  that confirms the newly running version; never poll it before each step or
  between successive forge reads and writes.
- Read every Devboard fact through the registered MCP tools — `devboard_status`, `issue_get`,
  `issues_list`, `issue_close`, `verification_run`, `goal_get`, `journal_search`, and
  `agent_sessions_list` — never by spawning the harness's `call-tool` bridge or any other
  subprocess that wraps them: the bridge starts a second Bun process and duplicates a capability
  the session already has. Never reach for that bridge for a Devboard state read.
- Never orient the session with a shell probe, and never chain orientation probes: no
  `git remote get-url origin` or `git remote get-url github`, no `git config --get
  remote.origin.url`, no `git rev-parse --show-toplevel`, no `ls` of `.devboard`'s scripts
  directory, no `env | grep`, and no
  `cd <root> && … && devboard forge-auth check` line. The `devboard_status`
  result covers the roots, and the session's auth result — already in context, otherwise the one
  `forge-auth.ts check` JSON line below — covers the forge, host, project, and identity; neither
  is re-derived to orient the run.
- Fall back to a shell probe only for a field neither the `devboard_status` result nor the auth
  gate reports, and then at most one probe, run alone: never a chained discovery line, never
  `git remote get-url origin`, and never a probe that merely confirms a value one of them already
  reported.
- Worktree root: `<REPO_DIR>/.worktree/`. Cut the worktree from the integration line the one
  task-start sync names (see *Fetch budget*) with
  `git worktree add --track -b issue-<number> .worktree/issue-<number> origin/main`, and never
  refetch it; `--track` makes the task branch's upstream the integration ref, so one
  `git status --short --branch` line reports its divergence. Create and work in exactly one
  worktree there, named for the issue, for example `<REPO_DIR>/.worktree/issue-<number>`. Never
  push from the worktree, because the only push is `main` from the canonical checkout. Never
  work in the canonical checkout, never use another agent's worktree, and write nothing outside
  `<REPO_DIR>` — no temporary file, log, cache, or build output elsewhere, and never `/tmp/x`.
- Scratch files and command logs live under `<REPO_DIR>/.devboard/.tmp/` and nowhere else. Create
  that directory once per session with a standalone `mkdir -p .devboard/.tmp` from the repository
  root; every log redirect names it, for example `> .devboard/.tmp/verify-interface.log 2>&1`.
  Never create or use a repo-root `.tmp`: no `mkdir -p .tmp` prefix, no
  `ls -d .tmp || mkdir -p .tmp` guard, and no `> .tmp/<name>.log 2>&1` redirect.
- The worktree cut is the whole worktree sync: `git worktree add --track -b issue-<number>
  .worktree/issue-<number> origin/main` places the task branch on the integration line the one
  task-start `git fetch origin` (see *Fetch budget*) named, so no rebase runs before the first
  edit and the worktree never fetches a second time. A rebase in this task belongs only to the
  landing integration or a rejected push below: the landing rebase is the unconditional
  `git rebase main` line of the canonical sequence in *Landing*, and the rejected-push rebase is
  entered from a rejected `git push`. Neither is entered from the task start, from
  re-verification, or from re-checking state. Chain nothing after one: no `git log`, no `git diff`,
  and no count. Confirm the result with the one `git status --short --branch` sync-state read in
  *Landing*.
- A branch being rebased holds no unstaged change when that rebase starts, and those rebases are
  the landing integration and the rejected push below. `error: cannot rebase: You have unstaged
  changes.` is answered by committing the worktree's own work first — `git add -A`, then one
  commit whose subject is a Conventional Commit describing the change — and then running that same
  rebase line once. Never `git stash`, never leave the worktree stashed or mid-rebase, and never
  answer the refusal with a `wip` subject the pre-push commit gate rejects.
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
- Forge write access is a precondition of the run, not a discovery step to repeat: the harness
  resolves it once, before the first forge read or write, and the turn's context carries `forge`,
  `host`, `project`, `login`, `source`, `permission`, and `canWrite` — injected before the turn,
  or produced by the one check below. Keep those fields in the run's own context instead of
  re-deriving them. A `canWrite: true` result authorizes every forge write in the task and ends
  the auth question for the session, so it never earns a probe.
- Only when the context carries no `canWrite: true` result, resolve it once with the canonical,
  argument-free auth check, after the single `devboard_status` call above and before the first
  forge read or write, run verbatim from the repository root:

  ```sh
  devboard forge-auth check --required write --json
  ```

  This is the only pre-write auth gate and the session's only auth invocation: a run whose
  context already carries `canWrite: true` issues none. The canonical form infers the forge,
  host, project, and identity from the `origin` remote and `DEVBOARD_GITEA_URL`, so this check
  has exactly one spelling: that literal command line, with no `--forge`, `--host`,
  `--project`, or `--url` flag and no derived replacement for any of them. The wrapper resolves
  all of them from the checkout, so this prompt never overrides one: never preempt the check with
  a guessed `--forge`, never re-run it with a target flag because the answer looks wrong, and
  never derive the values with `sed`, `git remote get-url`, or any other shell substitution. When
  the `origin` remote cannot name the forge, stop and report that as the blocker.

  A session following this prompt issues at most one call matching `forge-auth.ts check` in
  total, and none once its context carries `canWrite: true`; that call has no `cd`, no `--forge`,
  and no `--host` in its command text. Invoke that one line alone: never prefix it with
  `cd <absolute repository path> &&` (the `cd /home/... &&` shape) or
  `git rev-parse --show-toplevel &&`, and never chain it into a compound command with a `curl`
  request to the forge API or any other command. Set the tool's working directory to the
  repository root instead of prefixing the command.

  Read the JSON line, add its fields to the run's context, and treat it as final for the session:
  exit status 0 with `canWrite: true` authorizes every forge write in the task — labels, the one
  close, and any other forge write the task requires — so never re-run the check after that
  result, between successive issue reads or writes, or before, between, or after those writes.
  A nonzero exit, or an exit 0 without `canWrite: true`, ends the task: stop, report `forge`,
  `host`, `source`, and `permission` from the JSON, and include its `error` text verbatim when
  present.
  Never retry the check, never inspect its `--help`, and never fall back to `curl` or any other
  forge API probe. Never retry across `localhost`,
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
  resolved through `devboard forge-auth check` and MUST NOT be discovered with
  an `env | grep` probe, `cat .env`, `cat ~/.npmrc`, `git config --get-regexp 'url\..*'`, or any
  other environment or credential-file sweep: never enumerate the process environment or hunt
  for credential files, and `.devboard/prompts/forge-auth.md` holds that rule in full. Never
  inspect the harness binary to rediscover its resolution order; run `devboard forge-auth --help` only when the run changes it. `DEVBOARD_GITEA_URL` is supplied by the host at run time:
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

## Fetch budget

Fetch the canonical integration line exactly once per task, at the start, and answer every later
question about it from that one sync. A fetch on its own reports nothing about divergence, so the
sync is one command that fetches and reads the divergence line together, run from the canonical
checkout before the first edit:

```sh
git fetch origin && git status --short --branch
```

- One call and one spelling: that line, or `git fetch origin <canonical-branch>` with the
  repository's own branch when it names another, each followed by the same
  `&& git status --short --branch`. Never add `--prune`, `--quiet`, `--tags`, or
  `--all`, and never fetch another remote, unless a deleted ref, a tag, or that other remote is
  itself the question.
- A bare fetch is never a step: `git fetch origin` or `git fetch origin main` alone, a fetch
  chained to a `git rev-list` count, and a second fetch after a rebase, a merge, or a status read
  are one defect — a retry loop that re-asks a question the sync already answered. A fetch that
  printed only `Already up to date` never earns a retry to look for divergence; when the status
  line shows `[behind N]` or `[ahead N, behind M]`, integrate with `git rebase origin/main`
  instead of fetching again.
- The fetched `origin/main` is the integration ref for the rest of the task: the worktree base,
  `git log <sha>..origin/main`, `git merge-base`, the landing merges, the pre-push probe, and the
  post-push proof all read it. Never fetch again to re-check state this task already fetched, and
  never pair a fetch with a `git merge --ff-only` in one command.
- The divergence read is the `## <branch>...<upstream>` line from the one
  `git status --short --branch` half of that sync command, in the canonical checkout; that line is
  the sole divergence check, and *Landing* defines how to read its `[ahead N]` and `[behind N]`
  markers. The fetch moved the remote refs, so this line, not the pre-fetch `git` object from
  `devboard_status`, is the verdict. Reuse the line in every later turn instead of fetching again,
  and never pair it with a second copy of itself.
- Never measure divergence with `git rev-list --left-right --count`: not against `HEAD...main`,
  not against `HEAD...origin/main`, and not against `HEAD...issue-<N>`. Those refs are stale or
  absent, and the count re-derives a question the status line already answers; the status line,
  not a count, answers every divergence question here, so a recorded count is never repeated
  between steps. A variant glued without a separator —
  `git fetch origin && git rev-list --left-right --count HEAD...issue-1010 git log --oneline -3
  issue-1010` — returns no count at all, and `git rev-parse --short=12 HEAD origin/main` exits 128
  with `fatal: Needed a single revision` because `--short` accepts exactly one revision. Never
  substitute `git rev-parse origin/main` or `git rev-parse --short=12 origin/main` for the markers
  either, because a hash cannot tell ahead from behind.
- The only later fetch answers a new question about a new tip: a push was rejected because the
  remote moved, or `git rev-parse --verify --quiet <ref>` printed nothing for the ref itself. It is
  that same one-step sync — fetch and the divergence line in one command — and it belongs to the
  rejection handling below, never to a re-check of the tip fetched at the start.
- Never fetch to learn CI, release, or dashboard state: the push proof and the forge report it.

## Dependencies

The package root that owns the lockfile is `.devboard/`: `<worktree>/.devboard` inside your worktree
and `<REPO_DIR>/.devboard` in the canonical checkout. Run every harness `bun`/`bunx` command with
that package root as the working directory: `bun install --frozen-lockfile`, `bun run build`,
and `bun test`, each as its own invocation. The typecheck is not a bare `bunx tsc --noEmit`
shell call: run it through `verification_run` with `{"check": "typecheck"}` once per verification
pass, as *Typecheck* below requires. The repository root has no `package.json`, so a root-level
`bun install --frozen-lockfile` exits nonzero with "Bun could not find a package.json file to
install from", and a root-level `bun run build` fails with `error: Script not found "build"`.

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
  result reports as `harnessDirectory`, and it is the preferred entry point for every check the
  catalog covers: `bun run build` as `{"check": "build"}`, `bun test` as `{"check": "test"}`,
  `bunx tsc --noEmit` as `{"check": "typecheck"}`, and `bun run verify:interface` as
  `{"check": "verify:interface"}`. Its result carries `exitCode`, `output`, and the complete `log`
  in one read. When it resolves the canonical package root while you work in a worktree, it checks
  the pre-change revision; run the changed revision once from `<worktree>/.devboard/` as
  *Typecheck* and *Interface verification* below require.
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

## Interface verification

`bun run verify:interface` builds the client, starts a source dashboard, drives headless Chrome,
and throws the whole assertion message plus its JSON evidence object on the first failure. A lost
assertion therefore costs a full rerun, so interface verification has its own rule.

Interface verification has exactly one entry point: the `verification_run` MCP tool with
`{"check": "verify:interface"}`. The tool executes the `verify:interface` script from
`.devboard/package.json` with the resolved `harnessDirectory` as its working directory, kills the
check's whole process group at its 900-second bound, and returns `check`, `exitCode`, `output`,
`truncated`, and `log` in one result. Apart from the worktree fallback below, a bare
`bun run verify:interface` and a log an earlier run wrote are never a verdict, and a
`tail`/`head`/`grep` pipe never replaces one.

Every direct invocation of `bun run verify:interface` — the worktree fallback below, and any run
the tool cannot replace — happens in the foreground, exactly as written. It MUST NOT be redirected
into `.devboard/.tmp/*.log` or any other file: the redirect replaces the failing assertion with
`(no output)`, so read the diagnostic from the command output instead.

- Use `repositoryRoot` and `harnessDirectory` from the `devboard_status` call above, not a second
  call. When `harnessDirectory` is the `.devboard/` you changed,
  the tool verifies the changed revision and is the only way to run the check: never invoke
  `bun run verify:interface` from a shell in that case, because the tool result is the whole
  verdict and the shell form only repeats the same run.
- Only when that same result reports the canonical `<REPO_DIR>/.devboard` while you work in a
  worktree does the tool verify the pre-change revision. Then run the changed revision once from
  `<worktree>/.devboard` in two separate commands. First run `bun run build` alone in the
  foreground with its output unredirected, and read that output. Second, run only the verifier
  in the foreground with no deadline — `timeout: 0` — as the bare command
  `bun run verify:interface`, with its output visible in the command result: when the harness
  backgrounds the long run, the job's completion follow-up carries it. Never redirect that command
  to `.devboard/.tmp/verify-interface.log` or any other file, and never chain the build and the
  verifier into one command: the redirect turns a real failure into `(no output)`, and the chained
  form reports only `exit code 1`, hiding which stage failed. Its exit status is the verdict, so
  never append a status echo. Say in the final response that the tool's resolved
  `harnessDirectory` was the canonical root. Every other direct invocation is forbidden.
- Interface verification needs no scratch directory: the verifier creates every `.tmp` directory
  it writes to. When some other command's output genuinely has to be captured for later diffing,
  write the log under `.devboard/.tmp/` as *Inputs and paths* states — never joined to the
  command with `&&` and never re-probed with `ls` — and echo the tail of the log in the same tool
  result so a failure never arrives as `(no output)`.
- The `verification_run` tool writes the complete output of its own run to a log unique to that
  invocation and returns that path in `log`; when the run settles it also publishes the same
  complete output to `.devboard`'s `.tmp/verify-interface.log`. Read the returned path whole on
  failure — never `tail`, `head`, `grep`, or `2>&1 | tee` it — so the failing check message and its
  evidence JSON survive instead of a fixed number of trailing lines. Never take a verdict from a
  log an earlier run wrote: each invocation starts its own empty log.
- Never kill or restart `verify:interface`: a killed job loses the assertion. The
  `verification_run` call itself is never backgrounded; it returns the verdict in one result. For
  the shell fallback, a job status line such as `Backgrounded as job bg_N` is never a failure
  detail: read the job's completion follow-up and its exit status before concluding anything.
- On a nonzero exit, surface the first error line in the turn that reads the result: quote the
  first line the run printed — the `verify:interface: <assertion>: <evidence>` line, or the first
  stderr line from a step that crashed before the assertion — in the session transcript. Never
  report `(no output)`, a bare exit code, or a paraphrase as the failure detail, and never answer
  a silent failure with an unchanged re-run.
- `truncated: true` means the 16 KiB bound cut the returned `output`; the `log` file still holds the
  complete output. `exitCode` is still the verdict, and a truncated result is never a pass. A result
  ending `[timed out after 900000 ms]` is a failed verification, not a reason to background the
  check.
- On failure, read the complete `verify:interface: <assertion>: <evidence>` line before editing —
  from the tool's `log` or from the fallback job's output: the assertion names the control, and
  the evidence object carries the measured and expected values it compared. A partial read hides
  which side mismatched.
- A minified client runtime error such as `undefined is not an object (evaluating 'ne.cancelled')`
  is not a diagnosis, and a stale bundle is only a hypothesis until it is checked. The verifier
  builds the client before it starts the dashboard, so confirm the bundle matches the source by
  running the `build` check through `verification_run` — or, for a worktree revision the tool
  cannot reach, `bun run build` alone from `<worktree>/.devboard` — and rerunning the verifier
  once. Report the minified message only when it reproduces after that build, and never present it
  as the failing assertion.
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

`bun run verify:discover` runs at most once per change, with the package root `.devboard/` as its
working directory, and its output is always captured to the one log
`.devboard/.tmp/verify-discover.log` (repository-relative). The redirect below is relative to that
working directory, so it lands in `.devboard/.tmp/`; never run this command from the repository
root and never create a repo-root `.tmp`:

```sh
bun run verify:discover > .tmp/verify-discover.log 2>&1; echo "EXIT:$?"
```

Read that log whole — never through `tail`, `head`, or `grep` — together with the recorded
`EXIT:` line, and report its `PASS` lines and, on failure, the `verify:discover:` message. Keep one
log name per task: never mint a `-base`, `-2`, or `-3` variant, and never rerun the suite to
re-confirm a result the log already holds.

- A nonzero `EXIT:` names its failing scenario in the log: the last `PASS` line is the last
  scenario that held, and the `verify:discover:` message names what the failing one expected.
  Rerun only that scenario, with its fixtures kept:

  ```sh
  DISCOVER_VERIFY_KEEP=1 DISCOVER_VERIFY_ONLY=<scenario> bun run verify:discover \
    > .tmp/verify-discover.log 2>&1; echo "EXIT:$?"
  ```

  `<scenario>` is one of the names the `PASS` lines carry: `discovery-group`, `per-agent-prompts`,
  `run-all-order`, `per-agent-publication`, `one-at-a-time`, `run-all-halt`, `prompt-chat`,
  `prompt-save`, `installed-read-only`. An unknown name exits nonzero and lists them; a narrowed
  pass prints `verify:discover: ran only <scenario>`, and `DISCOVER_VERIFY_KEEP=1` keeps its
  fixtures under `.devboard/.tmp/verify-discover-*` for inspection.
- Never rerun the whole suite to re-confirm a failure: the same scenario set fails until the cause
  is fixed, so a second full run adds no information and burns another scenario timeout.
- A failure surfaced at the `while (Date.now() < deadline)` poll —
  `scripts/verification.ts:194-195`, the frame a `verify:discover` trace shows — is a scenario
  publication bug, not an unknown failure: the `timed out waiting for <description>` line names the
  state that never appeared, and the kept fixture directory holds that scenario's dashboard, ACP
  peer, and browser logs. Read those logs, fix the publication that never happened, and rerun only
  that scenario.

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
- Run build, test, and verify commands bare: `bun run build`, `bun test`,
  `bun run verify:interface`, and every `verification_run` check, with no `mkdir -p .tmp` prefix and
  no `> .tmp/<name>.log 2>&1` redirect. The harness already returns the failing output inline; a
  redirect replaces it with `(no output)` or a bare `exit code 1` and forces the same command to be
  re-run instead of read. `bun run verify:discover` is the one exception, and it follows *Discovery
  verification* instead: it runs once, captured to `.devboard/.tmp/verify-discover.log` with its
  `EXIT:` recorded, and that log is read whole.

## Contract

- Change only that issue's implementation, tests, and documentation. Follow the repository's
  existing conventions and keep the change limited to the issue's scope.
- The run is non-interactive: no `question` tool, no confirmation prompt, no interactive editor,
  no login prompt, and no waiting for an operator. Decide from the repository evidence.
- Complete the work: no stubs, placeholders, disabled checks, or unfinished branches of behavior.
- Verify the changed surface by running it, then run the checks the change could break. The
  typecheck is one `verification_run` call with `{"check": "typecheck"}` per verification pass,
  repeated only after a further type-affecting edit, as *Typecheck* above states.
- Before landing, read the worktree's `git status --short --branch` line against the integration
  line the task-start fetch named, never a refetch. When it shows `[behind N]`, rebase the run's
  task branch onto `origin/main`. When it shows `[ahead N, behind M]`, `git merge --ff-only
  origin/main` cannot apply: rebase instead. Resolve every conflict yourself and rerun every check
  the integration invalidates. The task branch is unpublished until it lands, so rebasing it is
  safe. Never answer "Not possible to fast-forward" by repeating the same
  `git merge --ff-only <task-branch>`.
- Land through the one sequence below. Never create a pull request or merge request, never
  force-push, and never rewrite published history.
- When a push is rejected, fetch the new tip once, rebase the task branch onto it inside the
  worktree, rerun the invalidated checks, and repeat the landing sequence and push block once per
  rejection. Never bypass the rejection.
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

The commit that lands MUST also name this issue by ending its subject with `(#<number>)`, for
example `fix(agents): resolve a shipped version from the landed commit (#989)`. Use that reference,
not a closing keyword: the forge links it in the issue timeline without closing the issue, and the
link is what lets the dashboard report the release that shipped the work. A commit subject without
the reference still lands, but its issue shows no shipped version.

Commit in the worktree on the run's own task branch. When its `git status --short --branch` line
shows `[behind N]`, rebase the task branch onto `origin/main` inside the worktree and rerun the
checks the rebase invalidates before landing; the unmarked line is the normal case, and no rebase
runs there.

Read the worktree's sync state with one `git status --short --branch` call, run in the worktree
once the work is committed. That line is the sole divergence check: it names the branch
and its upstream and appends `[ahead N]`, `[behind N]`, or `[ahead N, behind M]` only when one
side holds commits the other lacks, so the unmarked `## issue-<number>...origin/main` line is the
synced state. The branch was created with `--track origin/main`, so that line measures the
integration ref in the worktree exactly as the canonical checkout's `## main...origin/main` line
measures it on `main`; never invent an upstream for the task branch to make a marker appear. Add
`git log --oneline -3` only when commit subjects are needed, and one
`git rev-parse --short=12 <rev>` per revision only when a short hash is needed. Run each of those
as its own call, never `;`-glued to this status line:

```sh
git status --short --branch
```

One revision per `git rev-parse --short=12` call: `git rev-parse --short=12 HEAD origin/main`
exits 128 with `fatal: Needed a single revision`, because `--short` accepts exactly one revision
and an absent ref resolves to nothing. That message reports a ref that did not resolve to one
revision — a missing ref, or several revisions passed to one `--short` call — never that the
branches diverged. Invoke the command once for each revision whose hash is needed and never pass
several revisions to one `--short` call.

Before any `git rev-parse` that names more than one ref — `git rev-parse HEAD origin/main`, for
example — confirm each ref with `git rev-parse --verify --quiet <ref>`. One missing ref makes the
whole command exit 128 with `fatal: Needed a single revision` and discards the output of every
command chained to it, so name one revision per call unless every ref is already proven.

Never issue `git rev-list --left-right --count HEAD...<ref>` for this question — not against
`main`, not against `origin/main`, and not against `issue-<N>` — and never re-derive the line by
another route. The worktree's one status line already answers it, so no count qualifies. The refs
are stale or absent, the spellings multiply per session, and a glued
command such as `git rev-list --left-right --count HEAD...issue-1010 git log --oneline -3
issue-1010` returns no count at all. Never repeat a count between steps and never pair this status
line with a second copy of `git status --short --branch`. Never report a divergence state without
naming the upstream ref the status line compared, and never refetch before the line: the
task-start fetch already named `origin/main`. The canonical sync verdict is the unmarked
`## main...origin/main` line — neither side then holds a commit the other lacks — and an
`[ahead N]` or `[behind N]` marker means the work is unfinished. The turn is never reported done
without that unmarked line.

`git merge --ff-only <integration-ref>` is permitted only when the status line carries no
`[ahead N]` marker, where it is a pure catch-up. An `[ahead N]` marker forbids it — beside a
`[behind M]` marker the merge fails with `Diverging branches can't be fast-forwarded` — so
integrate with `git rebase origin/main` instead, resolve every conflict, and rerun the checks the
rebase invalidates. The `Diverging branches can't be fast-forwarded` hint means the branch is
diverged: rebase it, and never answer it with a fetch, a second `--ff-only` merge, or a `--no-ff`
merge. Never repeat a refused `--ff-only` merge. When the line carries `[ahead N]`,
one `git merge-base --is-ancestor <integration-ref> HEAD` confirms containment: exit 0 means the
integration tip is already contained in `HEAD`, exit 1 means it is not. Never substitute an issue
branch (`issue-N`) for the integration ref, and in the canonical checkout never substitute `main`
for the branch's upstream, which is `origin/main`.

Never chain a bare `git rev-parse --short=12 <branch>` with a following count or log for the same
question. Guard any optional branch that may not exist yet with `git rev-parse --verify --quiet
<branch>`, which prints nothing instead of exiting 128 with `fatal: Needed a single revision`;
never use a bare `git rev-parse --short=12 <branch>` for such a ref. Use
`git merge-base --is-ancestor <sha> origin/main` only to confirm one named commit landed — a
question about one commit, never a divergence measurement against `HEAD`: exit 0 means it is an
ancestor, 1 means it is not, and any other status, such as 128 with
`fatal: Not a valid object name`, means a ref is missing or the command itself failed, never that
the commit is unrelated. When a ref looks missing, prove it absent with `git rev-parse --verify
--quiet <ref>` first, then fetch `origin main` once under the fetch budget before concluding
anything.

Then land it with this one canonical sequence: the first two lines run in the canonical checkout on
`main`, the third runs in the task worktree, and the last runs in the canonical checkout again;
every line reuses the tip the task-start fetch named and never fetches again:

```sh
# canonical checkout, on main
git status --short --branch
git merge --ff-only origin/main
# task worktree
git rebase main
# canonical checkout, on main
git merge --ff-only <task-branch>
```

The status line decides whether the first merge may run: with no `[ahead N]` marker it
fast-forwards `main` to the fetched tip. An `[ahead N]` marker means the canonical checkout itself
carries unpublished commits, so that fast-forward is forbidden: rebase `main` onto `origin/main`,
rerun the checks the rebase invalidates, and read the line again before starting the sequence.

The third line is unconditional and runs in the task worktree: it rebases the task branch onto the
canonical checkout's `main` — not `origin/main` — which is a no-op when `main` is already
contained and is required when a concurrent landing published into `main` after the task start,
so the last merge always fast-forwards. Rerun the checks the rebase invalidates before that last
line. A canonical `## main...origin/main [ahead N]` line is a concurrent landing's unpublished
commits, so the task branch must contain that tip for the second merge to fast-forward;
`origin/main` cannot supply it and the fetch budget allows no second fetch. Run the sequence once
per landing attempt: no `&&` chain between its lines, no `tail` pipe, and no `PIPESTATUS` probe.
Never create a pull request or merge request.

Before pushing, read the behind state against the tip the task-start fetch named with this one
pre-push probe, run in the canonical checkout and read as-is:

```sh
git status --short --branch
```

The line names both sides: push only when it carries no `[behind N]` marker, so no upstream commit
is missing, and its `[ahead N]` marker counts the landing commits the push is about to publish. A
`[behind N]` marker means `main` is behind the fetched tip, so integrate instead of pushing —
rebase the task branch onto `origin/main` inside the worktree, rerun the checks the rebase
invalidates, repeat the landing sequence, and run the probe again. Never push a behind branch, and
never answer a behind result with a bare retry. Never refetch here: a remote tip that moved after
the task-start fetch surfaces as a rejected push, and the rejection handling below fetches that
new tip once.

Push, then prove the push with this one canonical sync check, run verbatim once after the push, in
the canonical checkout and read as-is:

```sh
git push origin main; echo "PUSH_EXIT:$?"
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git ls-remote origin refs/heads/main
```

The first line is the only push invocation. The push is verified only when `PUSH_EXIT:0` prints,
`git status --short --branch` reports no ahead or behind marker, and the SHA `git rev-parse HEAD`
prints equals the SHA `git rev-parse origin/main` prints and the SHA `git ls-remote` reads for
`refs/heads/main`. An unmarked status line means neither side has a commit the other lacks, and the
matching SHAs say the fetched tip, the local branch, and the remote tip are the landing commit.
`git rev-parse origin/main` here reads the tip of the ref the push named, never a divergence base.
Resolve `HEAD` and `origin/main` in separate `git rev-parse` calls: never pass `HEAD`,
`origin/main`, and an issue branch to one invocation, because one missing ref aborts the whole
command. `fatal: Needed a single revision` is a ref-resolution error — a missing ref, or several
revisions where exactly one is expected — never a divergence signal. Run this check once per
landing attempt and stop. After it passes, never repeat it in the same session — no second
`git status --short --branch`, `git ls-remote`, `git log`, or `git merge-base` readback to
reconfirm output it already printed. Never append `tail`, `head`, `diff`, `git status`, a
`PIPESTATUS` echo, or any other probe to the `git push` line: those suffixes discard the rejection
text or its exit status, and the sync check's separate lines are the one verification. Never use
`git log` or a trimmed merge output as the push proof. The fetch budget above governs the push
block too: the task-start sync and the pre-push probe answer every question about the integration
tip, the sync check reads the remote tip directly without fetching, and only a rejected push earns
the one new-tip sync.

An equal tip proves the landing commit is the canonical tip; `PUSH_EXIT:0`, an unmarked status
line, and matching `git rev-parse` and `git ls-remote` SHAs are the complete done check. Read the
check once and move on: never follow it with a per-commit re-check, a `git log` dump, or a Gitea
actions-endpoint query in the same breath. When a different ancestry question genuinely arises,
answer it with one `git branch --contains <sha>` or one `git merge-base --is-ancestor <sha>
origin/main` to confirm that one commit landed, and stop. Never split the check into separate
calls, drop its push, reorder it, or rerun it to reconfirm output it already printed; a nonzero
`PUSH_EXIT`, an ahead/behind marker, or a SHA that differs from the `git ls-remote` SHA is evidence
to read.

Never delete the worktree until the canonical sync check printed `PUSH_EXIT:0`, an unmarked
`git status --short --branch` line, and matching `git rev-parse` and `git ls-remote` SHAs; that is
the proof the integrated commit landed, and a worktree whose branch is unproven on the remote
stays in place. A local-only merge or a deleted worktree before that equality is a failed task.

`Diverging branches can't be fast-forwarded` or "Not possible to fast-forward" is a diagnosis,
not an instruction to repeat the merge. Never rerun the same `--ff-only` command, and never fall
back to `--no-ff` silently. Name which side is ahead with the `git status --short --branch` line
the landing sequence already printed — `[ahead N]` counts the commits only `HEAD` has and
`[behind N]` the commits only the upstream ref has — and never chain that read with `&&`.
When the refused merge is `git merge --ff-only <task-branch>`, the task branch lacks the
canonical checkout's `main` tip, not only a tip `origin/main` carries: rebase the task branch
onto that local `main` inside the worktree and rerun the checks the rebase invalidates. When the
refused merge is the first one, integrate `origin/main` into the task branch — rebase it inside
the worktree onto `origin/main` and rerun the checks the rebase invalidates. Then repeat the
sequence and the push block from the start.

A `CONFLICT (content)` is resolved in the merge that raised it: edit the conflicted files, stage
them, commit the result, and rerun the checks the conflict invalidates. `git merge --abort`
followed by an unchanged retry is not acceptable; only an integration that removes the conflict
may follow an abort.

A nonzero `PUSH_EXIT`, an ahead/behind marker, or a `git rev-parse` SHA that differs from the
`git ls-remote` SHA is a rejected or unproven push: report the rejection lines the
check printed as-is, fetch the new tip once, rebase the task branch onto `origin/main` inside the
worktree — and `main` too when the refusal names its side — rerun the invalidated checks, and
repeat the same check unchanged. Never re-push blind, never substitute a different ad-hoc
verification command, and never report done from a bare `git push` line. The landing merge is
fast-forward only: never `--no-ff`, `--no-edit`, or a non-fast-forward `git merge origin/main` on
`main`. Never publish: the Release Train releases the pushed commit on its own schedule.

After that block, close the issue with `issue_close` and report. Do not release, and do not wait
for a release workflow: the Release Train releases later.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify another fetch, merge, or commit. This run adds none of them: every scratch file — issue or
comment JSON, command capture, a verifier log — goes under `.devboard`'s `.tmp/`, never the
harness root, and the ignore rules keep it out of `git status --short --branch`, so the branch
line and its markers stay readable. Never create `.devboard/.issue-<N>.json`,
`.devboard/.comment-<N>.json`, or `.devboard/.close-<N>.out` at the harness root; the legacy files
of those shapes still sitting there are noise from earlier runs, and the run never rewrites or
commits them. Replace `origin` and `main` when the repository names another canonical remote or
branch.

## CI waits

CI waiting in this run covers only the checks the change itself needs: the one sanctioned
foreground `verification_run` per check, and one long-lived background watcher for a local `verify`
process, started with `async: true` and `timeout: 0`. After it starts, end the turn.

Never wait for the release workflow: this run releases nothing, and the Release Train dispatches
and verifies `devboard-release.yml` later on its own schedule. Never poll a workflow run with a
hand-rolled `for i in $(seq 1 60)` loop over `/actions/runs/<id>`, never background a poll of the
Gitea API, and never read `/actions/runs/<id>`, `/commits/<sha>/status`, a statuses feed, or a
"count busy runs" page. The forge rule above already requires run reads through the `devboard` MCP
tools, never `curl`.

## Release

This run never releases. Close the issue with `issue_close` after the push block proved the push
and the required checks pass. Never invoke the publish entry point, never dispatch a workflow,
never call npm or the Gitea release API, and never wait for a release tag. The Release Train
collects every unreleased `main` commit, publishes one version for the range, and records the
version and release URL itself; a separate release from this run would collide with it.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

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
  repository root:

  ```sh
  bun .devboard/scripts/forge-auth.ts check --forge gitea --required write --json
  ```

  This canonical invocation is the only auth probe the run makes; it resolves identity and reads
  no issue, label, release, run, or job. The credentialed target is `DEVBOARD_GITEA_URL` with
  `GITEA_TOKEN`; a host is a label only, so never pass `--host`, never derive it with `sed` or
  `git remote get-url`, and never pass `origin`, `github.com`, a bare IP, or a bare port. The
  wrapper reads the repository from the `origin` remote, so `--project` is unnecessary too. Exit
  status is authoritative and `--json` carries the selected identity: zero means write access,
  nonzero means stop and report that line. Never append `echo "exit=$?"`/`EXIT:$?` and never pipe
  the output through `head`/`tail`. On a checkout whose origin is GitHub or GitLab, replace only
  `--forge gitea` with `--forge github` or `--forge gitlab`. That JSON line, plus the resolution
  fields `devboard_status` returns, is the only supported way to learn the forge host, project, or
  credential state: both report presence and resolution without exposing a value, so an
  environment sweep answers nothing they do not. Never enumerate the process environment or hunt
  for credential files: `.devboard/prompts/forge-auth.md` holds that rule in full. In particular,
  never pipe `env` or `printenv` through `grep` for `gitea`, `forge`, `github`, `gitlab`, or
  `token`, and never treat `sed`-based masking as redaction: the tool shell carries an exported
  `MATCH` variable holding a token-bearing grep match (`MATCH='GITEA_TOKEN=…'`), so a later sweep
  reprints the token on a line no substitution rewrote. When a variable must be checked, print
  only a boolean, `[ -n "$GITEA_TOKEN" ] && echo set`, and never its value or a prefix of it.
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
- `verification_run` runs an allowlisted check from the canonical `.devboard/`, so it is for the
  integration checkout after landing. In the worktree, run the same check from
  `<worktree>/.devboard/` so the changed revision is what executes.

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
  rerun the invalidated checks, and repeat the landing sequence once per rejection. Never bypass
  the rejection.
- Close the issue only after the landing sequence below proves the push and the required checks
  pass. Use `issue_close` with `{"number": <number>, "reason": "completed"}`; it is the only forge
  mutation in this run. Do not post a tracker comment — no comment tool is exposed — and put the
  revision and the verification evidence in the final response instead.
- A proven duplicate, invalid, or already-fixed issue is closed with `issue_close` and the
  evidence, using reason `not planned` when no work is delivered, and without committing unrelated
  work.
- On success, remove only the worktree and branch you created. On failure or block, leave your
  worktree in place and report its path.

## Landing

Commit in the worktree on the run's own task branch. Before landing, fetch the canonical
integration line once and rebase the task branch onto `origin/main`; a rebase that reports the
branch is up to date is the normal case, and the fast-forward merge below is itself the
up-to-date gate, so no ahead/behind probe runs before the push.

Rebase the task branch onto `origin/main` when the fetched tip has moved, and rerun the checks the
rebase invalidates. Then land it with this one sequence from the canonical checkout, on `main`;
the first merge fast-forwards `main` to the fetched tip before the branch merge:

```sh
git merge --ff-only origin/main
git merge --ff-only <task-branch>
git push origin main
```

Prove the push with this one verification block, run once in the canonical checkout and read
as-is:

```sh
git fetch origin main
git rev-parse --verify origin/main
git rev-parse --short HEAD
git rev-parse --short origin/main
git rev-list --left-right --count HEAD...origin/main
git merge-base --is-ancestor HEAD origin/main; echo "ancestor=$?"
local_commit=$(git rev-parse HEAD)
remote_tip=$(git ls-remote origin refs/heads/main | cut -f1)
printf 'local %s remote %s\n' "$local_commit" "$remote_tip"
if [ "$local_commit" != "$remote_tip" ]; then
  printf 'push not verified: local %s remote %s\n' "$local_commit" "$remote_tip" >&2
  exit 1
fi
git status --short --branch
```

Equal tips prove the landing commit is the canonical tip, and `git status --short --branch` must
report no commits ahead of or behind the upstream. The gate prints both commits and exits nonzero
when they differ, so a difference is a failed push: fetch the new tip, rebase the task branch onto
`origin/main` inside the worktree, rerun the invalidated checks, and push again. Never use
`git log` or a `head`/`tail`-trimmed merge output as the push proof. Run the block once per
verification point and never repeat it to reconfirm output it already printed; it is the only
post-push readback, and this prompt excludes any other `git ls-remote`, `git log`, and a second
`git status` readback.

The block's `git merge-base --is-ancestor HEAD origin/main` is the task's only ancestry check, run
after its `git fetch origin main`. Read its exit status as the answer: 0 means the commit is
contained in `origin/main`, 1 means it is missing, and any other status means the command itself
failed and must be reported. Never wrap it in a loop over candidate commits or SHAs, never repeat
it for a second ref or a commit already proven to be the remote tip, and run no separate ancestry
probe while preparing, landing, or publishing.

Never chain these ref probes with `&&`: when a ref is absent the chain stops at the failing probe
and hides the rest, and a nonzero exit from the block is evidence to read, not a reason to rerun
it. `--verify` and `--short` each accept exactly one revision, so probe `HEAD` and `origin/main`
separately and never pass both to one `--short` call; that misuse prints
`fatal: Needed a single revision` even when every ref resolves. The same message from
`git rev-parse --verify origin/main` means the local `origin/main` ref is unresolved, not a merge
conflict or a code failure: run `git fetch origin main` and rerun the block once. Fetch at most
twice in a session, and fetch again only after a push, merge, or rebase happened since the
previous fetch.

A rejected push is ground truth: fetch the new tip, rebase the task branch onto `origin/main`
inside the worktree, rerun the invalidated checks, and retry the same push unchanged. If
`git merge --ff-only <task-branch>` reports "Not possible to fast-forward", never rerun it: the
branch does not contain `main`'s tip. Fetch the new tip, rebase the task branch onto `origin/main`
inside the worktree, rerun the invalidated checks, and rerun the landing sequence. The landing
merge is fast-forward only: never `--no-ff`, `--no-edit`, or a non-fast-forward
`git merge origin/main` on `main`. Run the sequence once per landing attempt and add no `tail`
pipe, `fetch`, or `PIPESTATUS` probe around it. Push before publish, never after.

After that block, release from the integration checkout with the single Publish invocation below.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify another fetch, merge, or commit. Create no new scratch file outside `.devboard/`. Replace
`origin` and `main` when the repository names another canonical remote or branch.

## CI waits

Never wait on a Gitea Actions run with a shell polling loop. Any command that combines
`for i in $(seq 1 60)` (or any other retry, `sleep`, or background loop) with a `/actions/runs/`
request is forbidden: each iteration spends a turn, the harness backgrounds the loop as `bg_N`,
and its own output says not to poll. Never leave such a loop running in the background.

The forge rule above already requires run reads through the `devboard` MCP tools, never `curl`.
Read a run at most once, parse `status`, `conclusion`, and `run_attempt` from that one read, and
report what it says. When `status` is `completed`, report the conclusion and continue; when it is
not, end the turn and wait for the completion follow-up, or re-check at most once in a later turn.
The same rule covers commit-status and list-runs reads.

`bun run publish` owns the release workflow wait, so landing never inspects a run by hand.

## Publish

Publishing is part of the task. Invoke `bun run publish` at most once per task, only from the
integration checkout, and only after the change is merged to `main` and pushed — never from a
worktree and never before the push. Run it as a background job that keeps the whole log and the
exit code:

```bash
cd .devboard && bun run publish --wait-timeout 1800 \
  > .tmp/publish-issue-<number>.log 2>&1; echo "EXIT:$?" >> .tmp/publish-issue-<number>.log
```

- Start this command in the background and keep its job handle, so the run survives the turn and
  the harness reports its completion. Let it run to completion. Use this invocation verbatim: no
  absolute `cd` path, no `tail`/`head`/`tee` pipe or any other output consumer, no other
  `--wait-timeout` value, and no second log file. The redirected log is the full output and its
  final line is the exit code. Publish already verifies `main`, the release workflow, the npm
  package, the release assets, and the mirror; the landing readback already owns the push proof, so
  add no `git ls-remote` or `git status` probe around the publish run. Read no release or workflow
  state through `curl`, `gh`, or `glab`; publish prints the verification result.
- Publish is long-running. While it runs, do other work or end the turn and wait for its
  completion follow-up. Never abort, kill, or re-invoke it while a run is pending, and never poll
  for it.
- An aborted, timed-out, or truncated publish call is inspected through the still-running job and
  its recorded log, never re-issued.
- When the log reports `the release workflow concluded failure`, publish is never re-invoked as a
  retry. Open that workflow run for the named commit, read its failing step, and fix the cause in a
  new commit; when the run's log is not reachable through the exposed tools, reproduce the
  workflow's own steps locally from the package root (`bun install --frozen-lockfile`,
  `bun run build`, `bun test`, `bunx tsc --noEmit`, each with `.devboard` as the working directory)
  and fix the step that fails. Land the fix and report the failing step, the
  fix commit, and the recorded exit code. Publishing the fixed revision belongs to the next task,
  never to this one.
- Never re-run publish in the same session to see its output, to confirm success, or with a
  different log file or `--wait-timeout`.
- Report the recorded exit code as the publish result. Close the issue with `issue_close` only
  after that value is `0` and the pushed revision is verified on the canonical integration line.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

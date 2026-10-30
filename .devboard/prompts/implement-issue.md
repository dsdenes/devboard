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
  `--forge gitea` with `--forge github` or `--forge gitlab`.
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
and `<REPO_DIR>/.devboard` in the canonical checkout. The repository root has no `package.json`, so
running `bun install` there fails with "Bun could not find a package.json file to install from".

- Run every install as `cd .devboard && bun install --frozen-lockfile`, from the repo root or, in a
  worktree, from the worktree root. Never run `bun install` from the repository root itself.
- Skip the install when that package root already has `node_modules` and `bun.lock` has not changed
  since that install. Run it at most once per session: installing is a precondition, never a
  verification step, and it never repeats before each build, typecheck, or test.
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

- Always pass `path` on an `edit` call; omitting it fails schema validation.
- Make `old_string` unique in the target file. When the anchor text repeats, extend it with
  unique surrounding lines or pass `replace_all: true`.
- Never send `new_string` identical to `old_string`; such a call changes nothing.
- After a `Found N occurrences` error, re-read the file and widen the anchor at the reported
  line. Never retry the same `old_string`.

## Contract

- Change only that issue's implementation, tests, and documentation. Follow the repository's
  existing conventions and keep the change limited to the issue's scope.
- The run is non-interactive: no `question` tool, no confirmation prompt, no interactive editor,
  no login prompt, and no waiting for an operator. Decide from the repository evidence.
- Complete the work: no stubs, placeholders, disabled checks, or unfinished branches of behavior.
- Verify the changed surface by running it, then run the checks the change could break.
- Before landing, fetch the canonical integration line (`main` unless the repository names another)
  and rebase the run's task branch onto `origin/main` inside the worktree when it has moved.
  Resolve every conflict yourself and rerun every check the integration invalidates. The task
  branch is unpublished until it lands, so rebasing it is safe.
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

Commit in the worktree on the run's own task branch. Verify the canonical line with one composite
integration check before the push; never run a bare fetch:

```sh
git fetch origin main --quiet &&
git rev-parse --short HEAD origin/main &&
git rev-list --left-right --count HEAD...origin/main &&
git merge-base --is-ancestor <commit> origin/main
```

Read `git status --short --branch` once alongside the check. Use at most one
`git merge-base --is-ancestor` in that check and never chain per-commit ancestry probes. Fetch at
most twice in a session, and fetch again only after a push, merge, or rebase happened since the
previous fetch.

Land it with this one sequence in the canonical checkout, on `main`:

```sh
git merge --ff-only <task-branch>
git push origin main
git status --short --branch
```

`git status --short --branch` is the only post-push readback—the push is verified when its
`## main...origin/main` line carries no `ahead` marker—and this prompt excludes
`git ls-remote origin refs/heads/main`, `git rev-parse HEAD`, and a second `git status` readback
after the push; never chain them. A rejected push is ground truth: fetch the new tip, rebase the
task branch onto `origin/main` inside the worktree, rerun the invalidated checks, and retry the
same push unchanged. The landing merge is fast-forward only: never `--no-ff`, `--no-edit`, or a
preparatory `git merge origin/main` on `main`. Run the sequence once per landing attempt and add no
`tail` pipe, `fetch`, or `PIPESTATUS` probe around it. Push before publish, never after.

After that readback, release from the integration checkout with the single Publish invocation below.

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

Publishing is part of the task. Run it exactly once per change, from the integration checkout, as
a background job that keeps the whole log and the exit code:

```bash
cd .devboard && bun run publish --wait-timeout 1800 \
  > .tmp/publish-issue-<number>.log 2>&1; echo "EXIT:$?" >> .tmp/publish-issue-<number>.log
```

- Start this command in the background and keep its job handle, so the run survives the turn and
  the harness reports its completion. Use this invocation verbatim: no absolute `cd` path, no
  `tail`/`head` pipe, no other `--wait-timeout` value, and no second log file. The redirected log
  is the full output and its final line is the exit code. Publish already verifies `main`, the
  release workflow, the npm package, the release assets, and the mirror; the landing readback
  already owns the push proof, so add no `git ls-remote` or `git status` probe around the publish
  run. Read no release or workflow state through `curl`, `gh`, or `glab`; publish prints the
  verification result.
- Publish is long-running. While it runs, do other work or end the turn and wait for its
  completion follow-up. Never abort, kill, or re-invoke it while a run is pending, and never poll
  for it.
- An aborted, timed-out, or truncated publish call is inspected through the still-running job and
  its recorded log, never re-issued. When the exit code is nonzero, read the log and fix the
  reported failure before the next single invocation.
- Never re-run publish in the same session to see its output, to confirm success, or with a
  different `tail` width or `--wait-timeout`.
- Report the recorded exit code as the publish result. Close the issue with `issue_close` only
  after that value is `0` and the pushed revision is verified on the canonical integration line.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

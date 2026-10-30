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
  required belongs under `<REPO_DIR>/.devboard/.tmp/` and is removed after use; never write
  `/tmp/x` or any other path outside the repository root.
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

- Run `bun install --frozen-lockfile` only from a `.devboard/` package root, never from the
  repository root.
- Skip the install when that package root already has `node_modules` and `bun.lock` has not changed
  since that install. Installing is a precondition, not a verification step.
- Never pipe the install into `tail` and never chain it with `bun run build`, `bunx tsc --noEmit`,
  or `bun test` in one shell line. Run it once, check its exit status, then run the build,
  typecheck, and tests as separate commands.
- `verification_run` runs an allowlisted check from the canonical `.devboard/`, so it is for the
  integration checkout after landing. In the worktree, run the same check from
  `<worktree>/.devboard/` so the changed revision is what executes.

## Prerequisites

If the issue declares an open prerequisite — a `depends on` or `blocked by` line, or a task-list
issue reference whose issue is still open — do not implement the issue. Write `blocked: #<prerequisite>`
as the first stderr line, exit nonzero, and leave the issue open and unhandled. Never implement
the prerequisite in another agent's place.

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
integration check before the push and once after the push; never run a bare fetch:

```sh
git fetch origin main --quiet &&
git rev-parse --short HEAD origin/main &&
git rev-list --left-right --count HEAD...origin/main &&
git merge-base --is-ancestor <commit> origin/main
```

Read `git status --short --branch` once alongside the check. Fetch at most twice in a session and
at most once per turn, and fetch again only after a push, merge, or rebase happened since the
previous fetch.

Land it with this one sequence in the canonical checkout, on `main`:

```sh
git merge --ff-only <task-branch>
git push origin main
local_commit=$(git rev-parse HEAD)
remote_tip=$(git ls-remote origin refs/heads/main | cut -f1)
printf 'local %s remote %s\n' "$local_commit" "$remote_tip"
if [ "$local_commit" != "$remote_tip" ]; then
  printf 'push not verified: local %s remote %s\n' "$local_commit" "$remote_tip" >&2
  exit 1
fi
upstream=$(git status --short --branch | sed -n '1p')
printf '%s\n' "$upstream"
case "$upstream" in
  *"[ahead "*) printf 'push not verified: %s\n' "$upstream" >&2; exit 1 ;;
esac
```

`git rev-parse HEAD` and `git ls-remote origin refs/heads/main` must print the same SHA: the new
local HEAD equals the SHA `ls-remote` names for `refs/heads/main`, and that equality proves the
landing commit reached the canonical line, so ancestry follows. The block prints both commits and
exits nonzero when they differ. The trailing check reads `git status --short --branch` and exits
nonzero when it reports commits ahead of upstream, so the block proves both the matching SHAs and
no unlanded local commit. Run this block once per landing attempt, and never push again after one
succeeds: never issue another `git push origin main` and never repeat its verification, and add no
`tail` pipe, extra `rev-parse`, `fetch`, or `PIPESTATUS` probe around it. State integration only
from a `git merge-base --is-ancestor` exit status or the `git ls-remote` ref value; never use
`git log`, `git status`, or `head`/`tail`-trimmed merge output as the push proof (the ahead check
above is not one either). Use at most one `git merge-base --is-ancestor` per composite check, as
above; never chain per-commit probes, and never re-verify a commit already proven to be the remote
tip. If an older commit genuinely needs checking, run exactly one such probe and report its exit
status. The landing merge is fast-forward only: never `--no-ff`, `--no-edit`, or a preparatory
`git merge origin/main` on `main`. If the push is rejected or `main` moved before landing, fetch
the new tip, rebase the task branch onto `origin/main` inside the worktree, rerun the invalidated
checks, and push again through this same block.

After the proof, release from the integration checkout with the single Publish invocation below.

Untracked scratch entries already present under `.devboard/` are expected status noise: they never
justify another fetch, merge, or commit. Create no new scratch file outside `.devboard/`. Replace
`origin` and `main` when the repository names another canonical remote or branch.

## Publish

Publishing is part of the task. Run it exactly once per change, from the integration checkout, in
this one form:

```bash
cd .devboard && bun run publish --wait-timeout 1800 2>&1 | tail -60; echo "EXIT:${PIPESTATUS[0]}"
```

- Use this invocation verbatim: no absolute `cd` path, no other `tail -N` size, and no
  `.tmp/*.log` redirection. Publish already verifies `main`, the release workflow, the npm
  package, the release assets, and the mirror; the landing proof already owns the push proof, so
  add no `git ls-remote` or `git status` probe around the publish run. Read no release or workflow
  state through `curl`, `gh`, or `glab`; publish prints the verification result.
- Publish is long-running. If the command is backgrounded, do other work or end the turn and wait
  for its completion follow-up. Never abort, kill, or re-invoke it while a run is pending, and
  never poll for it.
- Report the printed `EXIT:` value as the publish result. Close the issue with `issue_close` only
  after that value is `0` and the pushed revision is verified on the canonical integration line.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

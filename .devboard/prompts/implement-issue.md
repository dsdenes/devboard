---
description: Implement exactly one open GitHub issue, integrate it into the canonical line, and close it only after the push is verified.
---

`/implement-issue <number>`: implement exactly one open issue end to end.

The argument must be exactly one positive integer issue number. If it is missing, non-numeric, or
carries more than one token, refuse before changing anything: write the refusal to stderr, exit
nonzero, and stop. Never guess an issue number and never accept a range, a list, or a URL.

This run serves one issue. Fetch exactly that one issue and never fetch, survey, or build a
dependency graph for the rest of the backlog. You may read other issues and code for context, but
you never edit, comment on, close, or reopen another issue.

## Inputs and paths

- `<REPO_DIR>` is the checkout root: `git rev-parse --show-toplevel` in the repository. The
  canonical checkout is `<REPO_DIR>` itself.
- Worktree root: `<REPO_DIR>/.worktree/`. Create and work in exactly one worktree there, named for
  the issue, for example `<REPO_DIR>/.worktree/issue-<number>`. Never work in the canonical
  checkout, never use another agent's worktree, and write nothing outside `<REPO_DIR>` — no
  temporary file, log, cache, or build output elsewhere.
- Read the issue with the tracker: `gh issue view <number> --json
  number,title,body,state,labels,url,comments`.
- Every tracker command goes through the harness forge-auth wrapper:
  `bun <REPO_DIR>/.devboard/scripts/forge-auth.ts exec --host <host> --project <owner/repo> --forge github --required write -- <gh args>`.
  Never call `gh` for a mutation directly.

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
- Fetch the canonical integration line (`main` unless the repository names another) before
  integrating. Integrate concurrent changes, resolve every conflict yourself, and rerun every
  check the integration invalidates.
- Publish directly to that canonical integration line. Never create a pull request or merge
  request, never force-push, and never rewrite published history.
- When a push is rejected, fetch, integrate the new tip, resolve the conflicts, rerun the
  invalidated checks, and push again, with bounded retry. Never bypass the rejection.
- Close the issue only after verifying that the pushed revision is on the canonical integration
  line and the required checks pass. Comment on that same issue with the revision and the
  verification evidence.
- A proven duplicate, invalid, or already-fixed issue is closed with that evidence and without
  committing unrelated work.
- On success, remove only the worktree and branch you created. On failure or block, leave your
  worktree in place and report its path.

## Reporting

The first stderr line is the failure reason the dashboard shows. On a block it is exactly
`blocked: #<prerequisite>`; on any other failure it is one concrete line naming what failed.

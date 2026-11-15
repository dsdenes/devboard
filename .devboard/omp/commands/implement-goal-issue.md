---
description: Implement one open issue carrying the exact goal label as an autonomous goal
argument-hint: "<issue number>"
---

Implement the goal issue from the tracker in this session. This run is fully autonomous.

Issue number: $ARGUMENTS

Autonomy contract:
- Do not ask the user anything. Never call the `ask` tool.
- Do not wait for confirmation, approval, sign-off, or review.
- Decide from the issue, the repository, its tests, its documentation, and its ADRs. Where those
  are silent, choose the smallest reversible option, record the assumption in the final report,
  and continue.
- Continue until every success criterion is verified and the change is delivered: in `merge` mode
  the branch is merged, the worktree is removed, and the issue is closed; in `pull-request` mode
  one ready pull request is open against the integration branch, the issue stays open, and the
  worktree is removed only after its commits are on the pushed branch.

Steps:
1. Resolve the repository root with `git rev-parse --show-toplevel`. Never edit that checkout;
   it is for the final merge only.
2. Resolve the authenticated forge identity with `<devboard> forge-auth check --required write`,
   where `<devboard>` is the absolute harness binary resolved once per session as
   `.devboard/prompts/forge-auth.md` states. Route every GitHub or GitLab read and write through
   the same `<devboard> forge-auth exec --required write -- <gh|glab> ...`. For Gitea, resolve
   the identity with `check` and call the API with `GITEA_TOKEN`; the harness never execs a Gitea
   write.
3. Fetch the issue and require its labels to contain the exact `goal` label. An issue without
   that label is a refusal: report it and stop without implementing anything.
4. Keep the issue title and its whole body as the objective, dropping only harness HTML comments.
5. Plan a worktree under `<repo>/.worktree/<slug>` on branch `devboard/<slug>`, where `<slug>` is
   the first six words of the title, lowercased and hyphenated, and a numeric suffix picks the
   first free name. Create it from `main` with `git worktree add`. Never reuse a path or branch.
6. Work only inside that worktree. Use absolute paths under it and pass it as `cwd` to every
   command. Follow every success criterion and verification scenario, observe the real result,
   and use the repository's documented build and test commands as supporting evidence.
7. Never end a turn while a background job you started is still running: when a `wait` returns a
   still-running snapshot, call `wait` again. Leave the turn only once the work is finished or
   the exact blocker is known.
8. Read `DEVBOARD_DELIVERY_MODE` before delivering. In `merge` mode, when complete, fetch the
   latest `main`, integrate it into the branch, merge the branch into `main` from the repository
   root, push `main` to `origin`, remove the worktree and branch, and close the issue. If a push
   is rejected, fetch and integrate the new `main` and push again. Never force-push.
   In `pull-request` mode, push exactly the branch named by `DEVBOARD_PR_BRANCH` and open exactly
   one ready, non-draft pull request against the integration branch whose body contains
   `Closes #<number>`. Never merge the branch into `main`, never push `main`, never run
   `devboard land`, and never merge the pull request. Keep the issue open until the operator
   merges. Maintain the request: answer each new review comment once and briefly (at most 600
   bytes), resolve every thread you addressed or explicitly refused with one concrete safety or
   correctness reason, leave a thread you cannot answer unresolved, change the implementation and
   push a new commit when a required check fails, and integrate the base when the request
   conflicts. Never force-push and never rewrite a published commit.
9. If a hard blocker makes completion impossible, end the run and report the exact blocker once
   on a line beginning `DEVBOARD-BLOCKED:`. Do not ask for permission or guidance.

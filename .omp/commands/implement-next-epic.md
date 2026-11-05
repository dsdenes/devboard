---
description: Implement the open epic given by reference, or the single open epic created by /epic-next
argument-hint: "[epic number]"
---

Implement the next epic from the tracker in this session. This run is fully autonomous.

Reference (optional; empty means the single open epic): $ARGUMENTS

Autonomy contract:
- Do not ask the user anything. Never call the `ask` tool.
- Do not wait for confirmation, approval, sign-off, or review.
- Decide from the epic, the repository, its tests, its documentation, and its ADRs. Where those
  are silent, choose the smallest reversible option, record the assumption in the final report,
  and continue.
- Continue until every success criterion is verified, the branch is merged, the worktree is
  removed, and the epic is closed.

Steps:
1. Resolve the repository root with `git rev-parse --show-toplevel`. Never edit that checkout;
   it is for the final merge only.
2. Resolve the authenticated forge identity with `<devboard> forge-auth check --required write`,
   where `<devboard>` is the absolute harness binary resolved once per session as
   `.devboard/prompts/forge-auth.md` states. Route every GitHub or GitLab read and write through
   the same `<devboard> forge-auth exec --required write -- <gh|glab> ...`. For Gitea, resolve
   the identity with `check` and call the API with `GITEA_TOKEN`; the harness never execs a Gitea
   write.
3. List open epics: issues carrying the `epic` label, or when no such label exists, open issues
   whose body contains `<!-- devboard-epic -->`. With a reference, that epic must be in the list;
   with no reference, exactly one epic must be open, and several is a refusal that lists them.
4. Fetch the selected issue's body. Keep the title and any `## Objective`, `## Success criteria`,
   `## Verification`, and `## Boundaries` sections verbatim; drop HTML comments. When none of
   those sections exist, keep the whole comment-stripped body.
5. Plan a worktree under `<repo>/.worktree/<slug>` on branch `devboard/<slug>`, where `<slug>` is
   the first six words of the title, lowercased and hyphenated, and a numeric suffix picks the
   first free name. Create it from `main` with `git worktree add`. Never reuse a path or branch.
6. Work only inside that worktree. Use absolute paths under it and pass it as `cwd` to every
   command. Follow every success criterion and verification scenario, observe the real result,
   and use the repository's documented build and test commands as supporting evidence.
7. Never end a turn while a background job you started is still running: when a `wait` returns a
   still-running snapshot, call `wait` again. Leave the turn only once the work is finished or
   the exact blocker is known.
8. When complete, fetch the latest `main`, integrate it into the branch, merge the branch into
   `main` from the repository root, push `main` to `origin`, remove the worktree and branch, and
   close the epic issue. If a push is rejected, fetch and integrate the new `main` and push again.
   Never force-push.
9. If a hard blocker makes completion impossible, end the run and report the exact blocker once
   on a line beginning `DEVBOARD-BLOCKED:`. Do not ask for permission or guidance.

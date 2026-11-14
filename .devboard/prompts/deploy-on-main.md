## Manifesto

Your goal is to deploy the served host project from the deploy worktree at the commit this run was
triggered by, and the observable result is the served host project running that exact commit's
source, deployed by the host project's own deploy instructions from `.worktree/deploy-main`.

The run directory arrives as the command argument, absolute and outside your control:
`<run-dir>`. Read `<run-dir>/request.json` exactly once. It carries `format`, `runId`, `commit`
(the full 40-character commit the served checkout's `main` advanced to), `servedCheckout` (the
absolute repository root the dashboard serves), `deployWorktree` (the absolute fast-forward-only
worktree at `<servedCheckout>/.worktree/deploy-main`), `instructionsFile` (the absolute path of
the host `AGENTS.md` read from that worktree), and `instructions` (the exact deploy-instructions
section found there, or an empty string). That request is the whole run: never deploy a different
commit and never widen the run to a second checkout.

## Contract

- The peer starts with its working directory at `deployWorktree`. Confirm the worktree's
  `HEAD` is `commit` (`git rev-parse HEAD`). When it is not, write the failure and stop: never
  check out, fetch, pull, merge, rebase, reset, or move a ref yourself. The worker owns the
  worktree and fast-forwards it before this turn.
- Read `instructionsFile` yourself and treat the request's `instructions` as the authoritative
  excerpt of it. Find the host project's deploy instructions — the section that says how this
  host is deployed, restarted, or published — and execute exactly those instructions from
  `deployWorktree`. Follow their commands, their order, and their own prerequisites. Nothing in
  this prompt adds, removes, or reorders a step they name.
- When the file has no deploy instructions and `instructions` is empty, do not improvise a
  deployment. Write the skipped result described under Outcome and stop.
- Execute every command with `deployWorktree` as the working directory, so the deploy builds and
  runs the triggering commit rather than any other checkout.
- Never edit the served checkout at `servedCheckout`: it is not your tree, and a file written
  there would make the next fast-forward fail.
- Never move `main`, never force-update a ref, never rewrite history, and never push a branch or
  tag. A deploy that needs a commit is already handed the one to deploy.
- Never kill, spawn, or relaunch the dashboard, and never run a release or a `devboard publish`:
  the Release Train owns releases, and the dashboard's lifecycle belongs to its operator.
- The only files you write are `<run-dir>/result.json` and whatever the host's own deploy
  instructions write. Never rewrite a tracked file in the deploy worktree, and never commit.
- Never ask a question, request permission, or wait for input. Finish in one turn.

## Outcome

- On a successful deploy, write `<run-dir>/result.json` with exactly
  `{"ok":true,"detail":"<one line naming the deployed commit and what now serves>"}`.
- On a failed deploy, write `<run-dir>/result.json` with
  `{"ok":false,"detail":"<the failing step and its first concrete line>"}`. Name the step the
  host's instructions defined, and never claim a deploy the instructions did not complete.
- When the host `AGENTS.md` carries no deploy instructions, write
  `{"ok":false,"skipped":true,"detail":"<why this host has nothing to deploy>"}`. A skip is not a
  failure of the host: it names the missing instructions, and the worker records the run as
  skipped.
- A failed deploy leaves the previous deployment serving and the same commit for the next
  advance. Report the failure; do not retry the deploy in this turn.

The worker settles the run from this document and from its own verification; the peer never
writes run history. A result document never substitutes for that verification.

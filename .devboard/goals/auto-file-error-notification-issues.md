## Objective

Error notifications in the Devboard dashboard file one UI issue automatically through the existing
`/feedback` path, with no operator click. The notification card stops offering `File issue` while
automatic filing has not failed and links to the filed issue instead. Each filed issue instructs its
reader to investigate the error and fix it if it is needed, so the existing Issues worker can
process it. Warning notifications keep the manual `File issue` control.

## Success criteria

- When the dashboard raises an error notification, one POST to `/feedback` is sent with no operator
  action, and that card shows an `Open issue` link whose `href` is the issue the server returned.
- No error notification card renders a `File issue` button until automatic filing has failed, in the
  live region and in the history dialog.
- The filed issue body carries the notification text, its severity label, source, raise time, the
  captured UI context the manual button sends today, and the fixed instruction
  `Investigate this error and fix it if it is needed.`; the issue title comes from the
  notification's first line.
- A later error notification with the same severity, source, and text in the same page session
  sends no second POST and shows the link of the issue filed for the first; a different severity,
  source, or text files its own issue.
- Warning notifications keep today's `File issue` button and filing flow unchanged; notice and
  success notifications show no filing control and send no request.
- With reporting disabled (`feedbackenabled` false) the client sends no request, and the error card
  shows an `Issue not filed:` message naming the disabled reporting plus the `File issue` button.
  When the POST fails, the card shows `Issue not filed: <detail>` and the same button; a successful
  retry replaces the message with the `Open issue` link.
- The filed issue is an open issue in the configured feedback repository with no automatic `goal`
  or `processing` label, so the Issues worker claims it with `/implement-issue` on its next poll.
- README §Notifications states that error notifications file automatically, warnings keep the
  button, and a failed or unavailable filing reveals the retry button.
- `bun test --parallel`, `bunx tsc --noEmit`, `bun run check`, `bun run build`, and
  `bun run verify:interface` all pass in `.devboard`.

## Verification

1. `cd .devboard && bun run check` — exits 0 with no diagnostics.
2. `cd .devboard && bunx tsc --noEmit` — exits 0.
3. `cd .devboard && bun test --parallel` — exits 0. The `notification-issue` and
   `NotificationRegion` suites cover automatic filing, identical-error deduplication, the warning
   manual path, the disabled state, and failure plus retry.
4. `cd .devboard && bun run build` — exits 0 and refreshes `dist/`.
5. `cd .devboard && bun run verify:interface` — exits 0. Its notification section observes: an
   injected error notification produces exactly one `/feedback` call without a click; the card has
   no `.notification__file` and shows the returned issue link; a repeated identical notification
   produces no second call; a forced feedback failure shows
   `Issue not filed: The issue could not be filed.` plus a retry button that files on success; a
   warning notification still shows `File issue`.
6. `grep -n "Every error and warning card also carries" .devboard/README.md` — no match, and the
   Notifications section read at
   `grep -n "Notifications and status bar" .devboard/README.md` describes the automatic filing,
   the warning exception, and the retry-on-failure state.
7. Operator check with reporting configured: open the dashboard, cause one error notification, and
   confirm the tracker holds exactly one new `[ui] Error notification: …` issue whose body contains
   the fixed instruction, and that the card links to it.

## Boundaries

- Scope is the harness only (`.devboard/`): the notification card component, the notification
  report helper and its tests, the notification section of `scripts/verify-interface.ts`, and
  README §Notifications. Host files, `adrs/`, `GOAL.md`, and the host project stay untouched.
- `FeedbackOverlay.svelte` and its `File issue` / `Ask` / `Goal` panel stay unchanged; the button
  removal applies only to notification cards.
- The `/feedback` request contract, its 8000-character report bound, the `[ui]` title prefix,
  `FEEDBACK_REPOSITORY`, and the Gitea-only delivery rule stay unchanged. An automatic submission
  must fit the existing report bound including the instruction.
- Filing uses only `/feedback` against the configured Gitea API; no GitHub, GitLab, `gh`, or other
  tracker call is added, and no dependency is added.
- Automatic filing is bounded to the open page session; notifications persisted from an earlier
  session are never filed retroactively.
- No dashboard restart by hand, no force push, no rewriting published history, and no direct
  `bun run publish`. Work in `.worktree/<name>`, merge into main, push, and let the Release Train
  release.

## Stop conditions

- Halt and report when an operator decision this spec does not settle is required, such as a
  different destination repository for automatic issues.
- Halt when a prerequisite is missing: no configured Gitea reporting or token, no forge write
  permission, or Chrome unavailable for `verify:interface`; name the exact failing command.
- Halt before an unauthorized risky irreversible operation: history rewrite, force push, or
  deleting unrelated issues or branches.
- There is no attempt cap, token budget, or time limit. A narrower feature, a scaffold, a
  mock-only path, or a local-only commit never substitutes for a success criterion.

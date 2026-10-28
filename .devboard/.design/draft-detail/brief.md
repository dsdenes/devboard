# Draft detail — UX brief

## Identity
- Route: `/` → Issues mode → Draft goals (`#workspace-issues`, `section.issues-drafts-page`),
  second panel `section.issues-draft-detail`.
- Title: the selected draft's first Markdown heading, with its file name below.
- Auth/role: local operator of one repository's dashboard; no accounts or roles.
- Entry points: a row in the Proposed goals list, a restored `devboard.issues.draft.v1` path
  after reload, and the report panel's write that lands a new draft.

## Goal
- Primary goal: decide whether a proposed goal draft is worth elaborating, then start and
  supervise that elaboration.
- Success signal: the draft's proposal and its captured evidence are readable, the
  elaboration starts or stops on request, and a pending question can be answered without
  losing the draft identity.
- Secondary goals: follow the elaboration activity, understand why the start control is
  disabled, and recover from a draft or peer error.

## Arrival context
- What the user knows: a report or the Auto Scout flow wrote a proposed goal; the list shows
  its file name and heading. They may not know whether another draft is already running.
- What they carry in: the intent to review, elaborate, or stop one draft.
- Prior state: the selected path is stored in `localStorage`; the elaboration is server-owned
  and survives leaving the page.
- Device/network assumptions: desktop at 1024×720 or wider; the local WebSocket streams draft
  and run state. The page polls the list every two seconds while mounted.
- Urgency: low while idle; high while a question waits, because the elaboration is blocked
  until it is answered.

## Relationship to other pages
- Upstream: the Issues sidebar's Draft goals count and the report panel's proposed goal.
- Downstream: the elaboration writes a spec under `.devboard/goals/` and files an issue; the
  draft then disappears from this list.
- Loops: select → start → answer questions → the draft disappears or fails; a failed peer
  keeps the draft and accepts a retry.
- State left behind: the selected path and the mount state; the run record is server-owned.

## User journeys

### Review a draft
- Trigger: the operator opens Draft goals and selects a row, or a reload restores the path.
- Steps: read the heading and file name, read the proposal, inspect the captured UI context,
  then decide whether to elaborate.
- Decision points: is this draft worth a spec; is the captured evidence the right one.
- Success: the proposal is legible without scrolling through duplicated raw bytes, and the
  captured route, URL, element, and evidence are identifiable.
- Failure routes: the file vanished after selection — the page clears the selection and shows
  the list; the read is refused — an error banner states the reason.
- Recovery: reselect a listed draft or write a new one through the report panel.
- Exit: stay to elaborate, or select another draft.

### Start and supervise an elaboration
- Trigger: the operator chooses `Start elaboration`.
- Steps: read the status, follow the streamed activity, answer the question when it appears.
- Decision points: keep waiting, answer with an option or free text, or stop.
- Success: the question is the first thing after the header, the answer sends, and the draft
  eventually leaves the list with its spec written.
- Failure routes: another draft is already elaborating — Start is disabled with the reason in
  its tooltip and in the list; the peer fails — the error banner keeps the draft and accepts a
  retry; Stop — the run records `stopped`, keeps the activity, and re-enables Start.
- Recovery: answer the question, restart after a failure or stop, or select the running draft.
- Exit: leave the page; the run continues.

## Non-goals
- Editing the draft text in place, deleting the draft, or writing the final spec.
- Starting several elaborations at once.
- Showing another draft's activity inside the selected draft.
- Changing the Draft goals list or the page header.

## Assumptions
- The draft's first heading is the human title; the file name remains the durable identity.
- `## Captured UI context` is the only structural marker guaranteed by the writers
  (`server/feedback.ts`, `server/goal-proposal.ts`). Inferred from those writers.

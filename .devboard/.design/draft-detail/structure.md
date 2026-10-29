# Draft detail — structure

## Regions and order

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_identity | Draft title, file name | Review, Start | C1, C2 | P0 / P1 |
| 2 | region_actions | Status badge, Stop | Review, Start | C3, C5 | P0 / P1 |
| 3 | region_alert | Error banner, only when present | Review, Start | C7 | P1 |
| 4 | region_question | Elaboration question, only while pending | Start | C14, C15, C16 | P0 while pending |
| 5 | region_proposal | Proposed goal text | Review | C8 | P0 |
| 6 | region_activity | Streamed elaboration log, only while a run exists | Start | C13 | P1 |
| 7 | region_context | Captured facts, then inline Visible text and DOM excerpt | Review | C9, C10, C11, C20 | P1 / P2 |

```
Panel (surface, border, 4px radius, fills the grid cell)
  header (44px, border-bottom)
    identity (column)
      h2 heading, ellipsis, full value in title          P0
      file name, mono-small muted, ellipsis              P1
    actions (row, 6px gaps, never shrinks)
      [status badge] [Stop?]                              P0 / P1
  body (column, 12px padding, 16px between sections, scrolls)
    [error alert]                                         P1
    section question (warning border + surface)           P0 while pending
      overline "Elaboration question"
      question text
      option cards (one recommended label)
      free-text answer + submit
    section proposal
      overline "Draft"
      pre-wrap proposal text (no box)
    section activity (only while a run exists)
      overline "Elaboration activity"
      auto-following log, min 180px
    section captured context
      overline "Captured UI context"
      fact grid: Route, URL, Selected element, Viewport, Captured at   P1
      inline sections: Visible text, DOM excerpt                        P2
```

## Primary action

- Start elaboration is the one filled primary and lives on each draft row, next to the draft it
  starts; the detail header does not repeat it beside the status it changes.
- The row's Start is disabled while that draft runs, and its tooltip states the blocker.
- Stop takes the documented quiet-destructive style (24px word, `border-subtle`, muted until
  hover/focus turns `error-surface`/`error`). It appears only while this draft's run is live.
- The question's option cards and `Answer` are the critical path while a question is pending;
  they are not styled as a second page-level primary.

## Order and hierarchy

- Identity and action share the header, so the operator sees what is selected and what can be
  done before reading content.
- A pending question moves above the proposal and the log: it is the only thing blocking the
  elaboration, and the old layout buried it below a long activity stream.
- The proposal is the first content block because the review decision precedes the run.
- Activity sits above the captured facts: live progress is P1 and changes; the capture is
  reference. It is omitted entirely when no run exists, instead of showing an empty box.
- Captured facts are one compact grid; the visible text and DOM excerpt follow inline.

## State coverage

- Idle: badge `idle`, row Start enabled, no activity section, no question.
- Another draft running: badge `idle` for this draft, its row Start remains enabled.
- This draft running: badge `running`, row Start disabled with the blocker tooltip, quiet Stop,
  activity section streaming, question block on top as soon as one arrives.
- Stopped: badge `stopped`, row Start re-enabled, activity retained.
- Failed: badge `failed`, error alert with the server reason, draft retained, row Start retries.
- Read refused / vanished: the store clears the selection and the page renders the list; a
  refused read on a still-listed draft shows the alert.
- No captured context marker: "No captured UI context." in the context section.
- Loading: the detail is absent until `getGoalDraft` answers; the list panel remains usable.

## Responsive order

- ≥1100px: the detail is the second column beside the 240–340px list.
- <1100px: the list and the detail stack; the detail keeps the same internal order.
- At the 1024×720 floor the header title truncates, the path truncates, and the action group
  keeps its size; nothing wraps below the identity and no horizontal scroll appears.
- The body owns vertical scrolling; the log and the context sections never create a scroll
  trap outside it.

## Rationale

- The current panel is a stack of boxed blobs in raw-byte order: context, then the whole
  draft (context again), then a nested `Activity` header, then the log, then the question.
  Reading order follows data storage, not the operator's decisions.
- Splitting the bytes at the writer's `## Captured UI context` marker is the only parsing the
  writers guarantee. It removes the duplicate context from the reading surface; the raw source
  block added no content the structured proposal and evidence do not already show.
- Reusing `IssuesQuestion` (generalised from `IssuesAgentQuestion`) and `IssuesAgentLog`
  keeps the question grammar and the auto-following log identical to the Agents surface.
- Alternatives rejected: a three-column layout (the panel is a side column already), a
  modal question (the activity would disappear), tabs for proposal/context (the proposal must
  stay visible while the question is answered), and rendering Markdown (the proposal is shown
  as plain text and no Markdown renderer is wired into the client).

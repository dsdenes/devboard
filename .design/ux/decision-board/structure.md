# Decision board — structure

## Regions
| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Header row: title and board state | 1, 2, 3 | C1, C2 | P0 |
| 2 | region_editor | Read-only board body | 1, 2, 3 | C2, C3 | P0 |

## Primary action
- Action: none. The surface is read-only; the Flow sidebar and the command palette own
  navigation, and the implementation agent reads the board at its next checkpoint.
- Why there is no action: the page has no save path and no editable draft. Decisions arrive from
  the Flow session, so offering a control here would promise a write the product does not have.
- Where it lives: not applicable.

## State coverage
- Empty: `No decisions yet` muted badge; the body renders an empty read-only `<pre>`.
- Saved: `Saved` success badge; the body renders the stored markdown bytes in the same
  read-only `<pre>`.
- Restoring: `Restoring` accent badge; the body replaces the bytes with one restore notice
  until the stored Flow session settles.
- Error: server errors stay in the Flow notice region; the header keeps the last known state.
- Loading: the section renders from the mounted flow snapshot; no skeleton is needed.
- Partial: not applicable; the board is one string.
- Permission-denied: not applicable; the local operator owns the session.

## Responsive order
- Desktop: identity left in a 44px header row, the board body full width below it.
- Narrow (1024px): the same order. The workspace stays at least 900px wide after the rail and
  sidebar, so the title and badge never wrap.
- Collapsed/moved/hidden: nothing collapses; the header is one row at every supported width,
  and the body keeps its full width and scrolls.

## Rationale
- The 30px panel header held a two-line identity (12px title over an 11px state) while a 28px
  action was centered beside it. The two baselines crowded the 30px box and the state read as
  body copy rather than a status.
- The redesign keeps the documented Flow goal header pattern: one 18px `section-title` line, the
  state as a labeled `.badge`, and a 44px row above a page-leading document surface.
- The board is read-only because the editors are gone: the Flow session writes the decisions,
  and a Save control with a dirty state described a store field the product removed.
- Restoring is its own state: a restore frame carries an empty board on purpose, so showing
  `No decisions yet` would claim a settled empty board that the server has not confirmed.
- Alternatives rejected: keeping the two-line identity (the crowding the issue reports), moving
  the state below the body (separates it from the content it explains), and adding a new
  component (the badge and document primitives already exist).

# Decision board — structure

## Regions
| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Header row | 1, 2, 3 | C1, C2, C3 | P0 |

## Primary action
- Action: `Save`, filled only while the draft differs from the saved board.
- Why it is primary: it is the only action that moves the editor content into the board the
  implementation agent reads.
- Where it lives: right end of the header, after a 12px gap from the identity.

## State coverage
- Empty: `No decisions yet` muted badge; Save is a disabled secondary control.
- Saved: `Saved` success badge; Save is a disabled secondary control.
- Dirty: `Unsaved changes` warning badge; Save is the filled primary and enabled.
- Saving: the existing save path carries no separate header state; the draft stays dirty until
  the server confirms, so the header never claims saved early.
- Error: server errors stay in the Flow notice region; the header keeps the last known state.
- Loading: the header renders from the mounted flow snapshot; no skeleton is needed.

## Responsive order
- Desktop: identity left, actions right, one 44px row with 12px horizontal padding.
- Narrow (1024px): the same order. The workspace stays at least 900px wide after the rail and
  sidebar, so the title, badge, and Save never wrap.
- Collapsed/moved/hidden: nothing collapses; the header is one row at every supported width.

## Rationale
- The 30px panel header held a two-line identity (12px title over an 11px state) while a 28px
  action was centered beside it. The two baselines crowded the 30px box and the state read as
  body copy rather than a status.
- The redesign adopts the documented Flow goal header pattern: one 18px `section-title` line,
  the state as a labeled `.badge`, and a 44px row for a page-leading editor surface.
- Save becomes a neutral secondary control while unavailable, so a disabled blue primary no
  longer reads as the surface's main action.
- Alternatives rejected: keeping the two-line identity (the crowding the issue reports), moving
  the state below the editor (separates it from the action it explains), and adding a new
  component (the badge and button primitives already exist).

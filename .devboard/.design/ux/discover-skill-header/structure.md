# Discover skill header — structure

## Observed defect

The 30px panel header held a two-line identity while the 28px action group was centered against
it. The 12px path and the 11px state line met the divider with no vertical breathing room, and
the state line sat on a different baseline from Save. The disabled primary Save stayed a filled
blue block in the clean state, so the strongest element on the surface could not be used. In the
missing state the only usable recovery control remained an outline button beside that disabled
primary.

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Editor panel header, one 30px row | J1–J4 | C1, C2, C3, C4 | P0 |
| 2 | region_identity | Leading group: mono relative path | J1 | C1 | P1 |
| 3 | region_actions | Trailing group: state word, Save, optional Restore | J1–J4 | C2, C3, C4 | P0 |
| 4 | region_editor | Full-height Markdown editor | J2–J4 | — | P0 |

The page title above the panel is unchanged; it is outside this element and keeps the policy name.

## Primary action

- Action: Save when the draft differs from the live file; Recreate generated version when the
  live file is missing.
- Why it is primary: it is the one action that resolves the current state; a disabled Save must
  never be the strongest control.
- Where it lives: trailing end of the header's action group, after the state word and any quiet
  Restore control.

## State coverage

- Clean, generated: `No unsaved changes` muted; Save is a disabled `secondary`; no Restore.
- Clean, edited: `No unsaved changes` muted; Save disabled `secondary`; Restore `outline`.
- Dirty: `Unsaved changes` warning; Save enabled `default`; Restore `outline` when the live text
  differs from the generated version.
- Missing: `Live file missing` error; Save disabled `secondary`; Recreate `default`.
- Loading: no separate state; the page renders the editor when the skill record exists.
- Save/restore failure: the state keeps its value and the existing notification names the error.
- Long path: one line with ellipsis and the full path as its `title`.
- Narrow: the path truncates with its full-path tooltip; the state and actions keep their size
  and stay on the row, so no control is clipped.

## Responsive order

- Desktop: path left; state, Save, Restore right on one row.
- Narrow or over-wide sidebar: the path truncates first; the action group keeps state → Save →
  Restore order on the same row.
- Mobile: no layout below 1024×720; the viewport guard replaces the workspace.

## Rationale

- Grouping: the path is identity, the state qualifies the action, and the action sits at the
  trailing edge. This follows the shipped Flow goal and Decision board headers without adding a
  badge the operator feedback rejected.
- Alternatives rejected: a badge (duplicates the sidebar and contradicts prior feedback), a
  44px header (the 12px path and 10px state do not need a lead-surface height), and two lines
  (the crowding reported in this issue).

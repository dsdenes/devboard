# Discover skill header — structure

## Observed defect

The shipped 30px row had no surface of its own: it shared the panel's `surface`, so the file
identity and the editor met through one hairline with nothing marking the row as the editor's
chrome. The 28px Save left 1px above and below it, `No unsaved changes` read as a footnote at
11px, and nothing but that small grey word distinguished a saved draft from a dirty one at a
glance. On a wide viewport the row was a nearly empty strip whose only signals were the far
right cluster.

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Editor chrome bar, one 34px `surface-raised` row | J1–J4 | C1, C2, C3, C4 | P0 |
| 2 | region_identity | Leading group: mono relative path | J1 | C1 | P1 |
| 3 | region_actions | Trailing group: state dot and word, Save, optional Restore | J1–J4 | C2, C3, C4 | P0 |
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

- Clean, generated: `No unsaved changes` muted on a `success` dot; Save is a disabled `secondary`;
  no Restore.
- Clean, edited: `No unsaved changes` muted on a `success` dot; Save disabled `secondary`; Restore
  `outline`.
- Dirty: `Unsaved changes` warning text on a `warning` dot; Save enabled `default`; Restore
  `outline` when the live text differs from the generated version.
- Missing: `Live file missing` error text on an `error` dot; Save disabled `secondary`; Recreate
  `default`.
- Loading: no separate state; the page renders the editor when the skill record exists.
- Save/restore failure: the state keeps its value and the existing notification names the error.
- Long path: one line with ellipsis and the full path as its `title`.
- Narrow: the path truncates with its full-path tooltip; the state and actions keep their size
  and stay on the row, so no control is clipped.

## Responsive order

- Desktop: path left; state dot and word, Save, Restore right on one row.
- Narrow or over-wide sidebar: the path truncates first; the action group keeps state → Save →
  Restore order on the same row.
- Mobile: no layout below 1024×720; the viewport guard replaces the workspace.

## Rationale

- Grouping: the path is identity, the state qualifies the action, and the action sits at the
  trailing edge. This follows the shipped Flow goal and Decision board headers without adding a
  badge the operator feedback rejected.
- Chrome: the `surface-raised` band is the documented level-2 surface for panel sub-headers, and
  the 34px region height gives the 28px controls 3px above and below instead of 1px.
- State mark: the 6px dot repeats the shipped Discover run header and status-bar grammar; the
  word still carries the meaning, so the dot adds a scannable cue without a second label.
- Alternatives rejected: a badge pill (duplicates the sidebar and contradicts prior feedback), a
  44px header (the 12px path does not need a lead-surface height), two lines (the crowding the
  earlier run removed), and a larger path size (the `panel-title` step is the panel-header token).

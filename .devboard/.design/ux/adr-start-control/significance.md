# Decision record start control — significance

Score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk).

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| S1 | The word `Start` | 5 | 5 | 4 | 5 | 2 | 91 | P0 | Visible label on the only row action |
| S2 | The control's emphasis (filled on `Next`) | 4 | 5 | 4 | 4 | 1 | 79 | P0 | One filled primary, on the `Next` row only |
| S3 | The record identity in the accessible name | 3 | 4 | 5 | 5 | 2 | 75 | P1 | `aria-label` names the record; no extra visible text |
| S4 | Resolved rows have no action | 3 | 3 | 4 | 3 | 1 | 59 | P1 | Empty action cell; Implementation already states the state |
| S5 | Disabled state while work runs | 3 | 3 | 2 | 3 | 3 | 57 | P2 | Native disabled at 45% opacity, keeping the label |
| S6 | Hover, focus, and press feedback | 2 | 3 | 5 | 3 | 2 | 57 | P2 | Primitive hover fill, ring, and pointer cursor |

Rules applied:

- S1 stays visible at every supported width; the control is never icon-only.
- S2 is the only differentiator between the `Next` row and another pending row, so it carries the
  page's single filled primary. The `Next` badge remains the textual marker; the fill is
  hierarchy, not a second state word.
- S3 is not painted: the row already carries the title and `Next` badge; the accessible name is
  the only place the button needs to disambiguate itself from the other Start controls.
- S4 removes information rather than adding it: the Implementation column already owns
  `Resolved` / `Pending` on the same row.
- S5 and S6 are interaction states, not additional content; they never add a line or widen the
  action column.

# Decision record start control — structure

## Observed defect

The action column held a bespoke `button.start-button` on every pending row and the word
`Resolved` on every resolved row.

- Measured before, 1440 dark: the button was 20px tall with a 3px radius, 11px text inheriting
  the cell's 26px line-height, `0 6px` padding, and a 38.7px width. In a 28px row it was the only
  control below the 24px minimum `sm` size and the only functional control with a 3px radius.
- Every pending row repeated the same filled `primary` background. In the captured page three
  blue blobs at the far right competed with the record titles and gave no clue which record the
  lifecycle would pick first.
- Every resolved row printed `Resolved` in the action column while the Implementation column
  already stated `Resolved` on the same line.

## Regions and order

Within `section.panel.goal-adrs-panel` → `table.adr-table`:

1. `region_table_head` — six sticky `th` cells; the last is the action column. Existing.
2. `region_record_row` — one 28px `tr` per record. Existing.
3. `region_action_cell` — the last `td`, 10% column, one child or none:
   - `action_button` (S1–S3, S5, S6) — the shipped `Button` at `sm`; variant `default` only on
     the `Next` record and `outline` on every other pending record. P0.
   - `action_empty` (S4) — no child on a resolved record. P1.
4. `region_empty_state` — the filter empty row. Existing.

The cell keeps one child at every state. The variant changes emphasis, not the track, padding,
or row height.

## Measurements after

- All Start controls: 24px tall, 4px radius, 11px/500, `0 10px`, 46.7px wide, centered with
  2.5px above and 1.5px below inside the 27px content box. Row heights stay 28px (the first row
  measures 28.5px from the table's border rounding, as before).
- `Next` row: filled `primary` (`#1f6feb` dark, `#0969da` light), white foreground. It is the
  only filled primary on the surface, matching `openui.json`'s Button rule.
- Other pending rows: transparent fill, `border-strong` outline (`#6e7681` dark, `#6e7781`
  light), `foreground` text; hover takes the `secondary` fill.
- Resolved rows: empty action cell; the Implementation column keeps the only `Resolved` word.
- 1024×720: the document is 1024 wide with no horizontal scroll; the button keeps its size and
  the record title is the only column that truncates.

## Journey mapping

- J1: the `Next` row's filled button is the only filled control in the table, so the lifecycle
  order is visible without reading a second state word.
- J2: any other pending row keeps a 24px outlined Start at a 46.7px hit target, beside the same
  right edge as the next control.
- J3: resolved rows have no action affordance; the eye reads one state word per row.
- Keyboard: `Tab` reaches each pending row's button in row order; the primitive's 2px ring with
  a 1px offset marks focus, and `Enter`/`Space` trigger the action without opening the record.

## Significance mapping

- P0: S1 and S2 — visible label and one filled primary.
- P1: S3 and S4 — accessible identity and removal of the repeated state word.
- P2: S5 and S6 — disabled and interaction states, handled by the primitive.
- Dropped: none; the control has no additional content to score.

## Primary action

Start the record. Exactly one control per pending row; resolved rows carry none. The row click
still opens the record and is not a second action in the same cell.

## State coverage

- Next pending: filled primary.
- Other pending: outline.
- Resolved: no control.
- Disabled (creation, revision, skills preparation, manual run): native disabled, 45% opacity,
  pointer events removed, label intact.
- Hover: primary takes `primary-hover`; outline takes `secondary` fill.
- Focus: 2px `ring` with a 1px offset from the primitive; the row's own focus ring remains for
  row activation.
- Light and dark: the same variant grammar from each theme's tokens.
- Filtered table: the variant follows `goal.next`, so the next record keeps its fill whenever it
  is visible.

## Responsive order

The action column is fixed at 10% and never reflows. The button does not shrink; the title,
file, and summary columns truncate first. At 1024 the table remains within the viewport.

## Rationale

The shipped `Button` already defines the approved 24px `sm` control, radius, hover, focus, and
disabled states, so replacing the bespoke rule removes four off-system values at once. Painting
every pending row primary violated the one-primary rule and published no order; using the
existing `goal.next` state to fill exactly that row makes the lifecycle order visible without new
data or another label. Leaving the resolved cell empty follows the documented rule that a fact is
stated once per screen and removes nine repeated words from a twelve-row table.

# Issues queue row — structure

## Observed defect

The row is a three-track grid (`68px minmax(0, 1fr) auto`) with up to four
children: number link, title, optional `goal` badge, and the lifecycle badge.
When the `goal` badge is present (issue #281), the lifecycle badge has no third
column left and auto-places on a second grid row under the 68px number track.
Measured on the captured page: the row is 56px tall instead of 28px, and the
`running` pill sits at x=404 under `#281`. The fixed 68px number track also
wastes 40px on a five-character value.

## Regions and order

Top to bottom, within `section.issues-queue-page` (outside this change):

1. `region_header` — page title, repository, pending count. P2.
2. `region_queue_panel` — panel with `Queue` header. Existing.
3. `region_queue_list` — the list of rows. P0, the critical path.
4. `region_queue_row` — one row, repeated. Tracks, in DOM order:
   - `row_number` (Q1) — 44px leading track, mono, tabular, tracker link. P0.
   - `row_title` (Q2) — flexible middle track, one line, ellipsis, full title in
     the tooltip. P0.
   - `row_meta` (Q4 + Q5/Q6/Q7) — trailing auto track, inline group, 6px gap,
     never wraps: optional `goal` badge then exactly one state badge. P1.
5. `region_queue_empty` — one line when the queue has no rows. P2.

The row's three tracks are fixed in count and meaning. Adding or losing the
`goal` badge changes the meta group's width, never the track count, so the
state word cannot wrap and the row height is constant.

## Journey mapping

- J1: `row_number` and `row_title` on one 28px line; the number is the link.
- J2: `row_meta` at the trailing edge; the state word is always in the same
  place, at every viewport width.
- J3: `region_queue_empty` is a plain line inside the list, not a row.

## Significance mapping

- P0: Q1, Q2 — leading and middle tracks, first screen.
- P1: Q6 (and Q5/Q7 in the same slot) — trailing track.
- P2: Q4 — trailing track, small badge; page header items unchanged.
- Dropped: Q8–Q10.

## Primary action

Open one issue's tracker. Exactly one per row, carried by the issue number;
the title is not a second link.

## State coverage

- Empty queue: one muted line in the panel body.
- Populated: 0–n rows; each row has one state word.
- Running: accent state badge; goal + running coexist without wrapping.
- Handled: success state badge.
- Pending: pending state badge (warning tone).
- Loading / error: the page header and panel retain the last snapshot; the
  issues worker's own banners own those states and are outside this row.
- Long title: ellipsis with a `title` tooltip; the meta group keeps its width.
- Narrow (1024px): same three tracks; only the title track shrinks.

## Responsive order

The row does not reflow at the supported widths. The title track is the only
one that yields. The number and meta tracks are content-sized, so they do not
collapse.

## Rationale

An explicit three-track grid with a single trailing meta group is smaller than
any alternative that tolerates a fourth child: a wrapping flex row needs
`flex-wrap` rules and still lets the state word drift; a fixed state column
would reserve width for the widest badge at every row. One trailing group
keeps the state word on the same right edge as every other row, matches the
existing `.issues-agent-row` grammar in the same mode (44px number track, title,
right meta group), and fixes the double-height row with no new component.

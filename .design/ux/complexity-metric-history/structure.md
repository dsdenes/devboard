# Metric history panel — structure

## Regions
| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Panel header, 30px, `.panel__header` | 2 | C6 | P3 |
| 2 | region_rows | One row per metric | 1, 2 | C1, C3, C2, C4 | P1 |
| 3 | region_axis | One shared date axis, pinned below the scrolling body under the chart column | 1, 2 | C5 | P1 |
| 4 | region_empty | Empty / loading line, replaces regions 2–3 | 3 | C12 | P2 |

## Row geometry
One grid shared by every row and by the axis:

```text
[label: minmax(96px, 148px)] [chart: minmax(0, 1fr)] [value: 72px] [change: 64px]
```

- 10px column gap, 4px vertical row padding, `border-subtle` rule under every row except the last.
- The axis repeats the same template and puts its labels in the chart track, inset by the chart's
  8px x padding, so a date sits under its point.
- The chart is 24px tall and stretches with its track; its viewBox matches its rendered box, so a
  point stays a circle at every width.

## Primary action
- None. The panel is read-only; the page's only controls are the per-file sort buttons.

## State coverage
- Loading: one 12px `muted-foreground` line, `Loading the complexity history…`.
- Empty: one 12px `muted-foreground` line, `No snapshot has been recorded yet.`
- One recorded day: rows render, no line is drawn and no change is stated, because neither exists.
- Many days: the axis thins to first, middle, and last while every point keeps its `data-date`.
- Error: the shell's connection state owns it; the panel keeps the last known history.

## Responsive order
- Desktop: label, chart, value, change, axis under the chart column.
- 1024px: the label track shrinks to its 96px floor and then ellipsizes; the chart track takes the
  remaining width; the value and change tracks never shrink.
- Nothing collapses or reorders; the body owns the scroll while the axis stays pinned under
  a `border-subtle` rule.

## Rationale
- The shipped panel repeated the same three dates under all eight sparklines and boxed every chart,
  so the eye met eight frames and eight time scales before one number. C5 is one fact; it earns one
  row.
- The date axis was the only place a series' time scale was stated, and each series carried its own
  copy; the shared axis aligns to the chart track, so rows compare vertically.
- The change column exists because each series is normalised to its own range: a line's amplitude
  cannot say whether `Files` moved by 1 or by 179, and the newest value alone cannot say it moved.
- Rejected alternatives: keeping the multi-column grid (the date repetition and eight frames are
  the defect), a single combined chart of eight metrics (incomparable units), and per-row tooltips
  only (unreachable on touch and invisible at a glance).

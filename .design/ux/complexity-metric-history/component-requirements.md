# Metric history panel — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Metric history panel | Compose | — (no catalogued panel component; the `.panel` / `.panel__header` / `.panel__body` CSS primitives in `app.css`) | None; the panel is a page composition, and the primitive specimens live in `stories/design-system.stories.ts` | Empty, loading, one recorded day, many recorded days | `aria-label` on the section plus an `h2` panel title; the chart is `role="img"` with a text label | Existing `surface`, `border`, `border-subtle`, `accent`, `muted-foreground`, `foreground` tokens |
| Sparkline row | Modify | — (chart markup is local to `DevboardComplexity.svelte`; no catalogued chart component exists) | None | 0–N points; one point (no line, no change); flat series; rising series | `role="img"` and an `aria-label` naming the metric and the recorded-date count | `accent` for the line and the newest point, `muted-foreground` for the older points |
| Sortable per-file table | Reuse | `Button` (`bare` form) | `stories/design-system.stories.ts` | Unchanged by this redesign | Native buttons with `aria-sort` on the header cells | Unchanged |

## Component details

### Panel frame
- Decision: compose the shipped `.panel`, `.panel__header`, `.panel__title`, `.panel__body` primitives;
  add no shared component.
- Why: every sibling panel (Documentation changes, Discover question, Proposed goals) uses this
  frame, and the shipped panel was the only one without a header, so it read as a borderless block
  inside a box.
- States: `panel__header` is fixed at 30px; `panel__body` scrolls and pads 8px.
- Edge case: the panel is one flex child beside the per-file panel (`flex: 1 1 45%`), so the body is
  the only scroll container and the header never scrolls away.
- Accessibility: the section keeps its `aria-label`; the `h2` names the surface for sighted users.
- Tokens: `surface`, `border`, `border-subtle`, spacing 8.

### Sparkline row
- Decision: modify the local chart markup and its page-scoped CSS.
- Why: the chart's viewBox must match its rendered box; the shipped chart stretched a fixed 240×48
  viewBox with `preserveAspectRatio="none"`, so at a 1400px track every point became a 6× wide
  ellipse. Measuring the chart's width once and using it as the viewBox width keeps a point a
  circle while the line still fills the track.
- Edge cases: zero points (no rows, one empty line), one point (one point, no polyline, no change),
  a flat series (line level, change `0`), a long history (axis thins to first/middle/last while
  every point keeps its `data-date`), a wide track, and the 96px label floor.
- Accessibility: the SVG keeps `role="img"` and a label naming the metric and the recorded-date
  count; the points and the axis are not focusable.
- Tokens: `accent` (line, newest point — "active indicator"), `muted-foreground` (older points, axis
  dates, change value), `foreground` (newest value, metric name). The shipped chart used `ring`,
  which `DESIGN.md` reserves for focus, and `success`, which means pass/accepted.
- Storybook/OpenUI: unchanged; no shared component was added or modified. The `designmd` MCP server
  is not mounted in this session, so no design-system artifact was mutated.

### Change column
- Decision: compose inside the row; no new component.
- Why: each series is normalised to its own range, so amplitude cannot size a move. The signed
  difference between the first and the newest recorded value is derived from the same points and
  invents nothing.
- States: empty with fewer than two recorded days; `0` when the metric did not move.
- Accessibility: the value is text; its `title` names the first recorded day it is measured from.
- Tokens: `muted-foreground`, `mono-small` type, tabular figures.

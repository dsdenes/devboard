# Auto Scout — structure

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Page header: identity, meta, filing limits, actions | 1, 2, 3, 4 | C1, C2, C3, C6, C4, C12, C13, C14 | P0/P1 |
| 2 | region_alerts | Conditional banner row | 1, 4 | C7, C22 | P1 |
| 3 | region_main | Main column: filed issues, scan activity | 1, 4 | C11, C15–C20 | P0/P1 |

```
PageHeader (surface, border, 10/12 padding)
  eyebrow "Issues" · h1 "Auto Scout" · subtitle "owner/repo"
  meta: [lifecycle badge] [Last read time]
  actions: [Filing limits: two fields, C13 hint, C14 error, Save] [Stop] or [Start]
alerts (only when present)
  [sync error / worker error]
body (column, fills height)
  main (column)
    panel Filed issues     → header C17; table C15/C16 or C18; scrolls
    panel Scan activity    → header C11; log C19 or C20; fixed 210px
```

## Primary action
- Action: `Start` while the worker is stopped; `Stop` while a worker is attached.
- Why primary: it is the only state-changing worker action, and every journey starts or
  ends there.
- Where it lives: the page header's right-aligned action group, at most one filled
  action. Start is the filled primary; Stop is the filled destructive action.
- Why beside the limits: the operator sees the budget and the action that consumes it in
  the same glance.

## Order and hierarchy
- The page header answers "what is this and can I trust its data" before any panel, and
  carries the only editable values.
- The header keeps the filing limits beside the Start/Stop action they qualify, so the
  operator can adjust the budget without leaving the result area.
- Filed issues gets the largest area and scrolls; scan activity has a fixed, readable
  height so a long log never swallows the table.
- Tables and logs use the existing `panel` frame and 30px header; the results column
  spans the workspace because no side rail holds content.

## State coverage
- Empty, stopped: lifecycle `stopped`, last read `never`, pending `0`, empty table,
  empty activity, filled `Start`.
- Attached or scanning: lifecycle `idle`/`scanning`, filled `Stop`, activity lines
  appended live.
- Failed read: the banner carries the reason, the last successful time stays, existing rows
  stay visible.
- Worker failure: lifecycle `failed`, banner carries `lastError`; Start/Stop follows the
  server's flags, never inferred.
- Notice: success banner after a filing pass; no banner layout shift because the zone is
  a flex item that only exists when it has content.
- Invalid limits: inline alert under the fields inside the header group; the last saved
  values remain.
- Loading: the shell renders from the mounted store; before the first snapshot the
  repository reads `…`, lifecycle `stopped`, and both actions disabled by `canStart`.
- Disconnected socket: `canStart` is false, so Start is disabled; no separate banner.

## Responsive order
- ≥1100px: one results column; the header holds identity, meta, limits, and the action on
  one bar, wrapping the limits group only when the width runs out.
- <1100px: the header wraps the meta/limits/action tail below the identity, then alerts,
  filed issues, and activity. The page body scrolls vertically; the activity keeps its
  210px height.
- Supported floor: 1024×720. No horizontal scrolling; long titles ellipsize.
- Nothing collapses into menus; all actions and values stay visible.

## Rationale
- The page header already carries the state and the action; the filing limits are the
  budget those actions consume, so they belong on the same bar rather than in a rail that
  steals 360px from the results.
- A page header rather than a bespoke two-line header reuses the shared `PageHeader`
  primitive, so the lifecycle badge, the last-read time, the limits, and the action share
  one surface.
- Alternatives rejected: a five-equal-panel stack (no hierarchy), a table above the
  header (the action would be buried), and a side rail for two numbers (needless width
  loss for the results column).

## Accessibility
- `PageHeader` provides the page's only `h1`; panels use `h2`.
- Start/Stop, inputs, and Save are native controls with visible focus rings.
- The input labels wrap the fields; the limits error uses `role="alert"`.
- Lifecycle and read states are words in badges, not colour-only.
- Error and notice banners keep `role="alert"`/`role="status"` and remain in reading
  order immediately after the header.
- The table keeps column headers and link text; the empty table is a compact centered message
  with a decorative mark, not a full-width strip.

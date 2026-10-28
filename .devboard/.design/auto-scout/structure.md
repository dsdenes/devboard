# Auto Scout — structure

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Page header: identity, meta, actions | 1, 2, 4 | C1, C2, C3, C5, C6, C4 | P0/P1 |
| 2 | region_alerts | Conditional banner row | 1, 4 | C7, C22 | P1 |
| 3 | region_side | Left rail: worker facts, filing limits | 1, 2, 3 | C8, C9, C10, C12, C13, C14 | P1 |
| 4 | region_main | Main column: filed issues, scan activity | 1, 4 | C11, C15–C20 | P0/P1 |

```
PageHeader (surface, border, 10/12 padding)
  eyebrow "Issues" · h1 "Auto Scout" · subtitle "owner/repo"
  meta: [lifecycle badge] [GitHub read badge] [Last read time]
  actions: [Stop] or [Start]
alerts (only when present)
  [sync error / worker error]
body (grid: 360px minmax(0,1fr), gap 12, fills height)
  side (column, scrolls)
    panel Scout worker     → C8 count, C9 worker, C10 next attempt
    panel Filing limits    → C12 two fields, Save, C13 hint, C14 error
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
- Why not in the worker panel: the panel becomes a pure fact block, and the action is
  visible before scanning any panel.

## Order and hierarchy
- The page header answers "what is this and can I trust its data" before any panel.
- The side rail holds facts and the only editable values; the main column holds the
  results. This matches the Issues overview's side/main split.
- The worker panel leads with the pending count (the budget pressure) and keeps process
  and next-attempt facts below it in label/value rows.
- Filed issues gets the largest area and scrolls; scan activity has a fixed, readable
  height so a long log never swallows the table.
- Tables and logs use the existing `panel` frame and 30px header; no new container
  nesting than the two columns.

## State coverage
- Empty, stopped: lifecycle `stopped`, GitHub read `stale` and `never`, worker `none`,
  next attempt `none`, pending `0`, empty table, empty activity, filled `Start`.
- Attached or scanning: lifecycle `idle`/`scanning`, worker `pid … · version`, filled
  `Stop`, activity lines appended live.
- Failed read: read badge `error`, the last successful time stays, banner carries the
  reason, existing rows stay visible.
- Worker failure: lifecycle `failed`, banner carries `lastError`; Start/Stop follows the
  server's flags, never inferred.
- Notice: success banner after a filing pass; no banner layout shift because the zone is
  a flex item that only exists when it has content.
- Invalid limits: inline alert under the fields; the last saved values remain.
- Loading: the shell renders from the mounted store; before the first snapshot the
  repository reads `…`, lifecycle `stopped`, and both actions disabled by `canStart`.
- Disconnected socket: `canStart` is false, so Start is disabled; no separate banner.

## Responsive order
- ≥1100px: 360px side rail, main column takes the rest. Side rail scrolls on its own;
  main column's table absorbs height changes.
- <1100px: one column. Header, alerts, worker, limits, filed issues, then activity. The
  page body scrolls vertically; the activity keeps its 210px height.
- Supported floor: 1024×720. No horizontal scrolling; long titles ellipsize.
- Nothing collapses into menus; all actions and values stay visible.

## Rationale
- Two columns give the page a reading order and remove the near-empty full-width strips
  the current stack renders when Auto Scout has no rows.
- A page header rather than a bespoke two-line header reuses the shared `PageHeader`
  primitive, so the lifecycle and read badges sit on one meta line and the action aligns
  with the page title.
- The worker panel drops the scan id and last-read duplicate: the scan id labels the
  activity it describes, and last read belongs beside the read state.
- Alternatives rejected: a five-equal-panel stack (no hierarchy), a table above the
  header (the action would be buried), and a full-width limits form (needless travel for
  two numbers).

## Accessibility
- `PageHeader` provides the page's only `h1`; panels use `h2`.
- Start/Stop, inputs, and Save are native controls with visible focus rings.
- The input labels wrap the fields; the limits error uses `role="alert"`.
- Lifecycle and read states are words in badges, not colour-only.
- Error and notice banners keep `role="alert"`/`role="status"` and remain in reading
  order immediately after the header.
- The table keeps column headers and link text; the empty table is a compact centered message
  with a decorative mark, not a full-width strip.

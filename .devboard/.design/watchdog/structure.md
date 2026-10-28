# Watchdog page — structure

## Regions

1. **Page header** (existing `PageHeader`, framed): eyebrow `Issues`, one `Watchdog` h1, meta row
   with the GitHub sync badge and `Last read <time>`.
2. **Alerts** (conditional): one `.issues-error` paragraph per failed read, directly under the
   header.
3. **Newest cycle** (`.panel`): 30px header with `Newest cycle` and the age on the right; body is
   one verdict row plus one facts line.
4. **Body grid** (`.watchdog-body`): filed-issue panel and cycle-history panel, each owning its
   own scroll.

```
┌ Issues / Watchdog ────────────────── [GitHub read ok] Last read 14:02:48 ┐
├ Newest cycle ─────────────────────────────────────────────────── 2m ago ─┤
│ [filed] filed 2 issue(s)                                                 │
│ STARTED Oct 28, 14:00:00   FINDINGS 2   PENDING FILINGS 1                │
├ Filed issues ──────────────────────────────────────── 12 filed · 0 pending ┤
│ ISSUE                                         CATEGORY  FILED  STATE  ...  │
│ [watchdog] ...                                                           │
├ Cycle history ────────────────────────────────────────────────────────────┤
│ STARTED  ACTION  ISSUES                                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Regions and hierarchy

- The summary sentence (action + reason) is the loudest body content: 12px foreground beside a
  10px badge; the facts line is 10px overline labels over 11.5px tabular mono values.
- The page header owns trust; the summary never repeats the sync badge or last-read time.
- Filed issues and cycle history are peers, each with a 30px header, a table header, 27–28px rows,
  and a `border-subtle` rule. The filed-issue table gets the wider track (`1.25fr` versus
  `minmax(420px, 1fr)`) because its title is the only wrapping text. The history table has three
  labelled columns; the trailing `Issues` track links each cycle's filed issues as `#<number>`.
- Both tables live inside `.panel__body--flush`; the table header is sticky and the body scrolls,
  so the page itself never scrolls and the 100-row history cannot bury the filed issues.

## States

| State | Summary | Filed issues | Cycle history |
|---|---|---|---|
| No cycle, no filing | action `none`, `Never` start, `0` counts, no reason | centered empty stack | centered empty stack |
| Cycle, no filing | action, findings, pending | empty stack | rows |
| Filed issues | summary | table | rows |
| Sync error | summary unchanged | last known rows + error alert | unchanged |
| Page read error | last snapshot or empty shape | last known rows + error alert | unchanged |
| Stale sync | header badge `stale` | rows | rows |
| Narrow (≤1500px) | full width | first row, flexible height | second row, flexible height |

## Responsive

- Wide (≥1501px): two columns, filed issues left, history right. The summary spans both.
- Narrow (1024–1500px): one column of two flexible rows. Each row keeps a `minmax(0, …)` track so
  the panels shrink rather than overflow; tables and history scroll internally at every width.
- At ≤1100px the issue category yields before content is clipped (it is already in the generated
  title). The element stays in the DOM, so the browser contract still reads it.
- Page padding is 16px and the gap 12px, matching the other Issues pages. No horizontal page
  scroll at 1024px.

## States, copy, and empty composition

- The empty history and empty filed-issue states match `.scout-issues__empty`: a 20px muted Lucide
  mark, a 13px/600 title, one 12px muted line, capped at 360px, centered on both axes.
- Copy: `No cycles yet` / `The watchdog records one cycle every ten minutes.` and
  `No issues filed` / `Findings worth an issue appear here after a cycle.`
- The empty elements keep their testids on the wrapper so state assertions target the same node.

## Rationale

- One summary band replaces the four equal facts cards: the operator asks "what happened", not
  four independent questions; exact start and counts are supporting detail.
- Splitting the single scroll column into two self-scrolling panels fixes the observed defect
  where the page grew to 3511px inside an `overflow: hidden` workspace and the filed issues sat
  unreachable below 100 history rows.
- Labelled table headers fix the unlabelled history tracks, and a fixed action track stops badge
  width from shifting the issue links row to row. The integrated compact row keeps only the start,
  action, and linked issues; the newest reason and counts sit in the summary.

# Watchdog page — structure

## Regions

```
section.watchdog-page                       scroll container, 16px padding, 12px gaps
├─ header.page-header                       title + purpose + sync meta (C1, C2)
├─ div.watchdog-page__alerts                only while an error exists (C8)
└─ div.watchdog-body                        two columns while the page is >1300px
   ├─ div.watchdog-main                     primary column
   │  ├─ section.panel  newest cycle        full primary width (C3–C7)
   │  │  ├─ header: "Newest cycle" + action badge + age
   │  │  └─ body: 3-stat rail + reason line
   │  └─ section.panel  filed issues        bounded list (C11–C16)
   │     ├─ header: "Filed issues" + "<n> filed"
   │     └─ body (flush): table, header sticky, own scroll
   └─ section.panel  cycle history          bounded list (C9, C10)
      ├─ header: "Cycle history"
      └─ body (flush): ordered rows, own scroll
```

The body is a grid on the page container: while the page is wider than 1300px the primary column
takes `minmax(0, 1.45fr)` and the history panel `minmax(340px, 0.9fr)`. It then fills the height
left by the header and alerts, and both panels scroll inside it. At 1300px and below — including
the supported 1024×720 floor — it becomes one column in DOM order: newest cycle, filed issues,
cycle history; the page itself scrolls and each list keeps a capped height.

## Order and hierarchy

- The header answers trust first: the sync badge and last-read time are the only meta.
- The newest-cycle panel answers "what happened last": age in the header's trailing edge, action
  as the one toned badge, then three stats (Started, Findings, Pending filings) and a single
  reason line. Pending is the only warning-weight stat.
- Filed issues precede history in reading order: the outcome of the runs matters more than the
  chronology that produced it.
- History sits as the right-hand aside so its 100 retained rows occupy a bounded, scannable
  column instead of stretching a 1700px-wide strip.
- Every panel is a level-1 `surface` with a 1px `border`; nothing is nested except rows.

## Stats rail

Three equal cells on one row at ≥720px of panel width, wrapping to two columns then one on
narrow panes. Each cell is a 10px/700 `overline` label over a 12px mono value. Cells are separated
by `border-subtle` rules, not boxes.

| Cell | Value | Tone |
|---|---|---|
| Started | absolute `<time>` or `never` | foreground |
| Findings | integer | foreground |
| Pending filings | integer | warning only while > 0 |

The reason line uses `body-small` in `muted-foreground`, separated from the rail by a
`border-subtle` rule; it is omitted when the report carries no reason.

## Filed issues table

- Fixed table layout; columns: title (flexible), Category (110px), Filed (132px), State (86px),
  Version (76px).
- The title anchor is one line with ellipsis and the full text in its `title` tooltip; its text
  stays `[watchdog] <category>: <line>` (README contract).
- Header row is 27px, sticky inside the scrolling body, 11px/600 `label`-type uppercase
  labels on `surface`.
- Body rows are 27px with `5px 8px` cells, one `border-subtle` rule, and no vertical rules.
- Category and time are mono-small; state is the existing outline badge; version is mono.
- Hover tints only the row (`row-hover`); the title link takes `accent` and an underline.
- In the two-column layout the panel body absorbs the remaining column height and scrolls; in
  the stacked layout it is capped at `clamp(240px, 48vh, 520px)`. With no rows it renders one
  padded muted line.

## Cycle history

- One row per retained cycle, newest first; rows are compact by contract (no window, finding
  count, or reason).
- A row is a three-track grid: time (118px mono-small, tabular, muted), action (badge, auto), and
  issue links (`minmax(0, 1fr)` with 6px gaps). The three tracks start at the same x on every
  row, so 100 rows read as a column, not a ragged list.
- Rows are 27px, `5px 10px` padding, a `border-subtle` rule, no hover fill (the row is not a
  control; links own their hover).
- The panel body fills the grid row and scrolls independently; in the stacked layout it is capped
  at `clamp(280px, 58vh, 580px)`.
- Empty state: one padded muted line `No cycle has run yet.`

## States

| State | Rendering |
|---|---|
| First load | Header with `GitHub read stale` and `never`; newest cycle `never`/`none`; empty history and table |
| Healthy | Success sync badge, minutes-old cycle, pending `0`; neutral summary |
| Sync error | Error sync badge plus one `error-surface` alert above the body; cycle and table keep last known data |
| Pending filings > 0 | Pending stat turns warning, keeps its label and number |
| Failed cycle | Action badge takes `error` tone; reason line names the failure |
| No cycle | Age `never`, started `never`, action `none`, reason omitted, history empty line |
| Long finding line | Title cell ellipsis with the full issue text as tooltip |
| Many cycles / issues | Each list scrolls inside its panel; the header and stats stay in place |
| Narrow page (≤1300px) | One column; panels keep their caps and never scroll horizontally |

## Accessibility

- One `<h1>` (Watchdog) and one `<h2>` per panel; the region keeps `aria-label="Watchdog"`.
- The sync badge, action badge, state badges, and stats all carry words, not color alone.
- Every issue and cycle link is a native anchor, Tab-reachable in reading order, opening in a
  new tab with `rel="noopener noreferrer"`.
- Focus stays the shared 2px `ring` with a 1px offset; tables use `<th scope="col">`.
- Empty states are plain text, not focusable.
- Times keep `<time datetime>`; mono numerals are tabular, not decorative.

## Responsive priority

- The page is an inline-size container: the body uses two columns while the page is wider than
  1300px and one column below that, so a resized sidebar changes the layout by available width,
  not by viewport.
- The primary column is its own container: below 900px it drops the table's Category, Filed, and
  Version columns; the title (which already carries the category) keeps enough width to identify
  the finding, and State stays.
- 1024×720 is the supported floor; below it the shell's viewport guard replaces the workspace.

## Rationale tied to IDs

- C1/C2 own the header meta because every other fact depends on a successful read.
- C3/C4/C5/C7 share one panel because they describe a single event; C6 rides with them as a
  stat.
- C9/C10 get their own bounded region because they are 100 retained rows of chronology (P1) and
  must never push C11–C16 off the first screen.
- C17 is dropped; C18 is dropped; C19–C22 stay out of the DOM.

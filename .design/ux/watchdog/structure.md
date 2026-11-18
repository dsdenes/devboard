# Watchdog page — structure

The shipped surface is the shared agent page for the `watchdog` family plus the status bar's
indicator. No `section.watchdog-page`, `.watchdog-body`, two-column grid, newest-cycle panel, or
cycle-history table exists; no route or endpoint renders it.

## Regions

```
section.agent-page[data-agent="watchdog"]        flex column; 16px padding; 8px gap; overflow hidden
├─ section.agent-activity-bar                     pinned 30px row; expands to a 180px log
├─ div.agent-page__scroll                        owns the scroll; 0 8px 8px padding; 12px gap
│  ├─ header.page-header (data-testid=agent-header)
│  │  ├─ h1 Watchdog + descriptor description
│  │  ├─ meta row: peers badge, worker versions, forge badge + Last read
│  │  └─ footer: agent settings (Cadence, Filing limits)
│  ├─ p.agent-gate                               only when the project gates the family
│  ├─ details.agent-prompt                        read-only prompt; absent message for Watchdog
│  ├─ div.agent-blocked                          only while a legacy timer blocks Start
│  ├─ p.agent-notice                             only while the server states one
│  ├─ div.agent-page__alerts                     sync error and snapshot error paragraphs
│  └─ div.agent-page__main > div.agent-page__column
│     └─ section.panel.agent-page__issues        Filed issues + `<n> filed · <p> pending filing`
│        └─ div.panel__body.panel__body--flush > AgentIssuesTable
```

The activity bar sits above `agent-page__scroll`, inside the page, so it never scrolls away; the
scroll area below it owns the page's scrolling and the filed-issues panel flexes to fill it.

## Order and hierarchy

- The header answers trust first: the forge read's badge and `Last read` are the only health meta,
  beside the family lifecycle's peers count and the live worker versions.
- The activity bar answers "what happened last": its newest line and state dot, with the retained
  history one click away in the same component.
- The filed issues are the outcome of the cycles and follow the header. The table is the page's
  main surface; its panel header states the filed count and the pending filings.
- The settings footer and the prompt disclosure are supporting facts and stay collapsed or compact.
- The page body is one column at every supported width. There is no second panel and no aside.

## Activity bar

- One `surface` card with a 1px `border` and 4px radius; its row is at least 30px and holds, 8px
  apart, the 8px state dot, the newest line at 12px (ellipsized; empty reads `No activity yet.`), an
  optional `Question` pill, and the Start/Stop control in the trailing slot.
- The toggle is the keyboard control; the whole row expands on a click. A change of the page
  identity (`devboard:watchdog`) collapses it.
- The expanded log is `background`, under a 1px `border` top edge, 6px 10px padding, and a 180px
  max height that scrolls. It renders one 11.5px mono line per retained cycle, oldest first, and
  follows the newest line only while the operator stays at the bottom.
- A cycle line is `start · action · <window start> – <window end> · <n> finding(s) · <reason> ·
  <issue URLs>`; the reason and the issue URLs are omitted when the cycle carries none. The line
  is text, not a control, so the bar has no per-cycle anchors; the popover and the filed-issues
  table carry the clickable links.

## Header meta

- A `badge` with the forge read: `ok`, `stale`, or `error`. `Last read` holds the localized time in
  mono with the ISO value in its `title`; a never-read family reads `never` without a time element.
- A peers badge renders only while the family runs: `no peer`, `1 peer`, or `<n> peers`.
- Each live worker contributes a mono version chip; a worker that reports no version reads
  `unknown`.
- The footer is the shared agent settings band: `Cadence` (Every field in minutes, last run, next
  run, `Save cadence`) and `Filing limits` (Per hour, Open issues, `Save limits`). Empty limit
  fields are `unlimited`; the page refuses a non-integer or out-of-range value beside its group.
- The prompt disclosure states `Watchdog runs no agent, so it has no prompt to show or edit.` Its
  summary still carries the `Prompt` title and chevron, and it owns no editor.

## Filed issues table

- Columns: Title (flexible), Category (110px), Filed (132px), State (86px), Shipped (76px), in a
  fixed-layout 12px table. Rows sort newest first by `createdAt`, then by URL.
- The header is 11px/600 uppercase `label` type on `surface`, sticky inside the table's scroll; body
  rows are 27px with `5px 8px` cells and one `border-subtle` rule. Hover tints the row.
- The title anchor is one line with ellipsis and the full generated title (`[watchdog] <category>:
  <line>`) in its tooltip; it opens the tracker in a new tab. Category and filed time are mono;
  filed time keeps `<time datetime>` with the ISO value; the state is the shared outline badge; the
  shipped version is mono with the row's note in its tooltip and `—` when absent.
- Empty and unread states use the shared `.agent-issues__empty` stack: a 20px Lucide mark above a
  13px/600 title and one 12px line, capped at 360px and padded 24px 16px. A fresh read with no rows
  reads `No issues filed yet`; a family that was never read reads `The tracker has not been read
  yet` with a Clock mark; a failed read reads `The tracker could not be read` with an alert mark.
- Rows from a not-fresh read survive under one `agent-issues__sync` notice naming the last read and
  the failure.

## Status-bar indicator

- One 20px status control in the right group: a 7px dot, the 10px `overline` label `watchdog`, and
  `<action> · <age>` in 11px mono. The age is compact (`just now`, `4s ago`, `3m ago`, `2h ago`,
  `5d ago`) and `never` with no cycle; the action reads `unknown` before the first snapshot and
  `none` when the snapshot carries no cycle.
- Dot states are a verdict over the whole snapshot, never one cycle word: `closed` while the
  family failed, the snapshot carries an error, or the newest action is `failed`; `connecting`
  before the first snapshot, while the family is not running (stopped, starting, stopping,
  disabled, paused), while filings are pending, or while the forge read is not `ok`; `open` only
  for a running, enabled, unpaused family whose pending count is `0`, whose read is `ok`, and
  whose newest action is `none`/`filed`/`commented`/`duplicate`. The word beside the dot always
  carries the action.
- The trigger opens a fixed `dialog` popover above the bar, 8px from the right, anchored to the
  bottom: one summary line (`Cycle <ISO start> · <n> finding(s) · <p> pending`), one muted reason
  line when the cycle carries one, then every filed issue as a link, or `No issues filed.` The
  popover is capped at 520px wide and 50vh tall and scrolls; Escape or a second click closes it.

## States

| State | Rendering |
|---|---|
| Before the first snapshot | header badge `stale`, `Last read never`, no peers, Start disabled; bar `No activity yet.`; filed panel `The tracker has not been read yet` |
| Healthy | badge `ok`, recent last read, newest cycle line with `none`/`filed` action, pending `0` |
| Forge read stale | badge `stale`, no alert; rows keep their notice naming the last read |
| Forge read error | badge `error`, one `role="alert"` paragraph with the server's reason above the panel; last known rows stay |
| Snapshot error | the server's message in its own `role="alert"` paragraph |
| Running | peers badge, worker version chips, pulsing state dot, Stop in the bar |
| Stopped / failed | no peers badge; dot reads stopped or failed; Start renders unless the project gates the family |
| Gated family | the reason replaces Start in the bar and a gate line renders under the header |
| Legacy timer | the blocked block names the timer unit and offers the disable control |
| No cycle | bar reads `No activity yet.`; indicator reads `none · never`; popover `No cycle reported yet.` |
| Many rows | the table scrolls inside its panel; the bar log caps at 180px and scrolls |
| Long values | title ellipsizes with the full text as its tooltip; a long cycle reason wraps in the log line |

## Responsive

- One column at every supported width; the page does not reflow into a grid. The page pads 16px and
  gaps 8px; the scroll area pads `0 8px 8px` and gaps 12px; the main column gaps 12px.
- At 1440×900 the measured page is 1063×874 CSS pixels; at the 1024×720 floor it is 647×694. Both
  report `scrollWidth` equal to `clientWidth`, so the page never scrolls horizontally at its floor.
- The table keeps all five columns at the floor. Its stylesheet drops Category, Filed, and Shipped
  only below a 900px viewport, which the shell's 1024×720 guard already replaces with the viewport
  guard, so that rule renders nothing in the shipped product.
- The activity log keeps its 180px cap; the popover keeps 520px and 50vh caps; both scroll
  internally. The table's wrapper scrolls horizontally if a locale widens a fixed track.

## Accessibility

- One `h1` (`Watchdog`); the filed-issues panel is a `<section>` with an `aria-label` and an `h2`.
- Every state word is present: the forge badge, the state badges, the dot's accessible name, and the
  bar's `role="img"` dot label. Color is never the only signal.
- The activity toggle is a button with `aria-expanded`; the expanded log is `role="log"`. The
  status trigger is a button with `aria-haspopup="dialog"` and `aria-expanded`, and the popover is
  `role="dialog"` named `Watchdog report`; Escape closes it.
- Issue links are native anchors with `target="_blank"` and `rel="noopener noreferrer"`, and the
  title anchor carries the full generated title. Table headers use `<th scope="col">`; times keep
  `<time datetime>`; icons are `aria-hidden` or labelled.

## Rationale

- The Watchdog filed issues, so its page is the family's page: one header, one settings footer, one
  feed. A bespoke page shell duplicated the shared agent chrome and drifted from it.
- The pinned bar is the one place the cycle history renders, so the history never pushes the filed
  issues below the fold and the page keeps one scroll owner.
- The status-bar popover stays the glance surface: it needs no page shell, a 50vh cap keeps 87
  filed issues auditable, and the trigger's action and age answer the health question in place.

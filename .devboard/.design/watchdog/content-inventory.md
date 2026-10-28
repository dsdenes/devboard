# Watchdog page — content inventory

The current page is evidence, not a constraint. Every existing fact was re-scored against the
journeys in `brief.md`; nothing is kept merely because the API returns it.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Page identity `Watchdog` | page chrome | all | Orients the operator | Keep | Mode context; unchanged |
| C2 | GitHub sync state (`ok`, `error`, `stale`) | `snapshot.sync.state` | health | Is the projection current? | Keep | P0 trust signal |
| C3 | Last successful read | `snapshot.sync.at` | health | How old is the projection? | Keep | Supporting, header meta |
| C4 | Sync error reason | `snapshot.sync.error` | health, history | Why did the read fail? | Keep | Appears only on failure |
| C5 | Page read error | `watchdog.error` | health | Why did `/api/watchdog` fail? | Keep | Appears only on failure |
| C6 | Newest cycle action | `snapshot.action` | health | What did the last cycle do? | Keep | P0 verdict |
| C7 | Newest cycle reason | `snapshot.reason` | health | Why that action? | Keep | P0 explanation |
| C8 | Newest cycle findings | `snapshot.findings` | health | Did the cycle see anything? | Keep | P1 count |
| C9 | Newest cycle pending filings | `snapshot.pending` | health, issues | Is a filing still queued? | Keep | P1 count |
| C10 | Newest cycle start | `snapshot.cycle` | history | When did it run? | Keep | P2, compact facts line |
| C11 | Newest cycle age | derived | health | Is the timer still running? | Keep | P1, panel header |
| C12 | Cycle start | `cycles[].at` | history | Correlate with wall clock | Keep | P1 |
| C13 | Cycle window | `cycles[].window` | history | Which ten minutes did it cover? | Drop | The integrated compact row removes the interval; the start stamp is enough to correlate |
| C14 | Cycle action | `cycles[].action` | history | Rule or exception? | Keep | The row's badge |
| C15 | Cycle findings | `cycles[].findings` | history | How much did it see? | Drop | The newest count stays in the summary; the integrated row is compact |
| C16 | Cycle reason | `cycles[].reason` | history | Why the action? | Drop | The newest reason is in the summary; the integrated history change keeps only the action per row |
| C26 | Cycle's filed issue links | `cycles[].issues` | history, issues | Which issues did this cycle file? | Keep | The only row content after the action; `#<number>` anchors |
| C17 | Filed issue title and link | ledger + GitHub | issues | Which issue, and open it | Keep | P0 |
| C18 | Filed issue category | ledger | issues | Group by signal kind | Keep | P2 scan aid |
| C19 | Filed issue time | ledger | issues | Newest first | Keep | P2 |
| C20 | Filed issue state | GitHub | issues | Fixed or open? | Keep | P1 |
| C21 | Shipped version | GitHub | issues | Which release fixed it? | Keep | P1 |
| C22 | Filed count / pending count | derived | issues | Table size and queue | Keep | P1 panel subtitle |
| C23 | Empty history | no run dirs | history | Nothing has run | Keep | Required state |
| C24 | Empty filed issues | no ledger rows | issues | Nothing has been filed | Keep | Required state |
| C25 | Per-cycle aria label with raw ISO | current row | history | Screen-reader context | Keep | Accessible name, no visual cost |

## Removed or merged

| Item | Decision | Reason |
|---|---|---|
| Four-column fact grid (Started, Action, Findings, Pending) | Merged into one verdict row plus a compact facts line | The grid gave every value equal visual weight and split one sentence across four cards. |
| Separate underlined issue link style | Merged into the shared table-link treatment | Two link styles existed in one table stack; the Scout table already owns the quiet style. |
| Two separate empty-state paragraphs | Replaced with the shared compact empty composition | The old rows floated at the panel's left edge in a large region. |
| "Newest first · at most 100 retained cycles" header sentence | Merged into a short count/order subtitle | The cap is implementation detail; the order is worth one short word. |
| Outline monospace timestamps in the history | Merged into versioned mono-small cells | Four different `mono` sizes previously appeared in one row. |

## Conflicts resolved

- The summary and the newest history row both carry the last cycle. The summary wins for the
  headline; the history keeps every retained cycle, including the newest, because it is an audit
  list and the browser contract counts it.
- The issue title already includes the category; the category column stays because it is the only
  way to scan by signal kind without reading every generated title.

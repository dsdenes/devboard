# Watchdog page — content inventory

Redesign of issue #362. The current page is evidence, not a constraint; hard contracts in
`.devboard/README.md` («The Watchdog page») keep their test identifiers and row semantics.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Sync state (`GitHub read ok` / `stale` / `error`) | `sync.state` | 1, 4 | Trust or distrust every other fact; act on a rate limit | Keep | Primary trust signal; word, not color alone |
| C2 | Last successful GitHub read | `sync.at` | 1, 4 | Judge freshness | Keep | One mono timestamp beside C1 |
| C3 | Newest cycle start time and age | `cycle`, now | 1, 2 | Judge whether the watchdog is running | Keep | The page's first question |
| C4 | Newest cycle action | `snapshot.action` | 1, 2 | Know what the last run did | Keep | One word badge, toned by state |
| C5 | Newest cycle reason | `snapshot.reason` | 1, 3 | Understand a failure or a no-op | Keep | Only line that explains the action |
| C6 | Newest cycle finding count | `snapshot.findings` | 1, 2 | Know whether work was produced | Keep | Compact stat |
| C7 | Pending filings | `snapshot.pending` | 1, 2 | Detect a filing that never landed | Keep | One stat; also summarized in the filed panel |
| C8 | Sync error text | `sync.error`, page error | 1, 4 | Diagnose the failure | Keep | Alert above the summary |
| C9 | Retained cycle rows (time, action, links) | `cycles[]` | 3 | Spot failures, filed runs, cadence | Keep | Compact rows, one per retained run; contract |
| C10 | Cycle issue links | `cycles[].issues` | 3 | Reach the exact issues a run produced | Keep | Anchor per issue, opening in a new tab |
| C11 | Filed issue title anchor `[watchdog] category: line` | `issues[].category`, `.line` | 2, 4 | Recognize and open the issue | Keep | Documented anchor text |
| C12 | Filed issue category | `issues[].category` | 2, 4 | Group or filter by failure class | Keep | Short mono column |
| C13 | Filed issue time | `issues[].filedAt` | 2, 4 | Judge recency | Keep | Mono `<time>` |
| C14 | Filed issue state | `issues[].state` | 2, 4 | Know open vs implemented | Keep | Badge with the word |
| C15 | Filed issue shipped version | `issues[].version` | 2, 4 | Know which release carries the fix | Keep | Mono, `—` when absent |
| C16 | Filed count | `issues.length` | 2 | See the result of the runs | Keep | Panel header |
| C17 | Pending-filings count repeated in the filed panel subtitle | `snapshot.pending` | 1, 2 | — | Omit the repeat | Same fact as C7; one statement per screen |
| C18 | `Issues` eyebrow above `Watchdog` | static | — | — | Remove | The rail and sidebar already name the mode |
| C19 | Per-cycle window interval | `cycles[].window` | — | — | Omit | No journey needs it; the README forbids it in rows |
| C20 | Per-cycle finding count | `cycles[].findings` | — | — | Omit | Findings belong to the newest-cycle summary |
| C21 | Per-cycle reason | `cycles[].reason` | — | — | Omit | Would repeat the newest reason and add noise |
| C22 | Retained-cycle count / "newest first" subtitle | static | — | — | — | Omit | An earlier operator request already removed it; the order is self-evident |

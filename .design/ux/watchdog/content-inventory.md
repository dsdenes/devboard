# Watchdog page — content inventory

The shipped surface is the shared agent page for the `watchdog` family and the status bar's
indicator. Sources are the pushed agent snapshot: `sync`, `lifecycle`, `peers`, `workers`,
`cadence`, `limits`, `pending`, `issues[]`, and the retained `cycles[]`; the indicator reads the
same snapshot. No page read, route, or endpoint supplies a fact.

| ID | Information | Source | Journey | Decision | Where it ships |
|---|---|---|---|---|---|
| D1 | Forge read state (`ok`/`stale`/`error`) | `sync.state` | 1, 3 | Keep | Header badge |
| D2 | Last successful read | `sync.at` | 1, 3 | Keep | Header `Last read`, ISO in the tooltip |
| D3 | Lifecycle and peer count | `lifecycle`, `peers` | 1, 5 | Keep | Bar dot, Start/Stop, peers badge |
| D4 | Live worker versions | `workers[].version` | 1 | Keep | Header version chips |
| D5 | Cadence, last run, next run | `cadence`, `limits` | 5 | Keep | Header settings footer |
| D6 | Filing limits | `limits.maxPerHour`, `limits.maxPending` | 5 | Keep | Header settings footer |
| D7 | Pending filings | `pending` | 1, 3 | Keep | Filed-issues subtitle |
| D8 | Filed count | `issues.length` | 3 | Keep | Filed-issues subtitle |
| D9 | Filed issue title `[watchdog] <category>: <line>` | `issues[].title` | 3, 4 | Keep | Table title anchor and popover link |
| D10 | Filed issue category | `issues[].category` | 3 | Keep | Table column |
| D11 | Filed time | `issues[].createdAt` | 3 | Keep | Table column, `<time datetime>` |
| D12 | Tracker state | `issues[].state` | 3 | Keep | Table badge |
| D13 | Shipped version | `issues[].version`, `issues[].note` | 3 | Keep | Table column with the note as tooltip |
| D14 | Retained cycle history: start, action, window, finding count, reason, issue links | `cycles[]` | 2 | Keep | One line per cycle in the expanded activity log |
| D15 | Newest action and age | `cycles[0]`, now | 4 | Keep | Status-bar indicator trigger |
| D16 | Newest cycle summary, reason, and every filed issue | `cycles[0]`, `pending`, `issues[]` | 4 | Keep | Indicator popover |
| D17 | Read failure, snapshot error, notice, project gate, legacy-timer block | `sync.error`, `error`, `notice`, `availability`, `timer` | 1, 5 | Keep | Alerts and blocks under the header |
| D18 | "The Watchdog runs no agent" | descriptor `prompt.kind = absent` | — | Keep | Prompt disclosure; explains the absent editor |
| D19 | Newest-cycle panel with its own stat rail | `cycles[0]` | — | Drop | D1, D2, D14, D15, and D16 state the same facts where they belong |
| D20 | Two-column body with a separate cycle-history panel | `cycles[]` | — | Drop | One column; the activity log carries D14 |
| D21 | Per-cycle table columns (`Started`, `Action`, `Issues`) as separate tracks | `cycles[]` | — | Drop | D14 is a single mono line; no second table |
| D22 | Page REST read and page route | — | — | Drop | Does not exist; the snapshot is pushed and the sidebar opens the page |
| D23 | `Issues` eyebrow above the title | static | — | Omit | The mode rail and sidebar already name the mode |
| D24 | Run-directory contents, logs, fingerprints | — | — | Omit | No journey needs them |

## Deduplication

- Pending filings appear once, in the filed-issues subtitle (`<n> filed · <p> pending filing`); the
  bar's cycle lines do not repeat the live queue.
- The newest cycle is stated at three densities: the bar's line (action, window, findings, reason,
  links), the indicator's `<action> · <age>`, and the popover's ISO start with counts. None of them
  is a card or a stat rail.
- The filed issues appear in the table with state and shipped version, and in the popover as links
  for a glance; the popover never repeats the table's columns.

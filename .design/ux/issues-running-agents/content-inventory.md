# Issues overview — running agent list content inventory

Scope: one row of the running-agent list and its local header. The current row was treated as
evidence, not a constraint: every item was re-asked whether its removal costs a declared journey.
The row reproduced the panel's state word and let a long title push the grid columns over each
other.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Issue number (`#225`) | `agents[].issueNumber` | 1, 2, 3, 4 | Identifies the row against the queue and the issue tracker | Keep | Primary key; mono column, fixed 44px so titles align |
| C2 | Issue title | polled queue, `issueTitle()` | 1, 2, 3, 4 | Confirms this is the issue the operator means | Keep | One line with ellipsis; full title in the row tooltip |
| C3 | Per-row `running` badge | hard-coded | — | None: the panel is the running list and the header states `N active` | Drop | Duplicated the panel, the facts row, and the lifecycle badge |
| C4 | Elapsed run time | `agents[].startedAt` + clock | 3 | Whether an agent has been stuck long enough to stop | Keep | `mono-small`, tabular, right-aligned, muted; ticks while visible |
| C5 | Question waiting | `agents[].question` | 2 | Which agent is blocked and needs the operator | Keep | `needs answer` warning badge, words plus colour, only when true |
| C6 | Run identifier | `agents[].runId` | — | Nothing on this panel: the issue number already selects the run | Drop | The focus page and Runs page own run identifiers |
| C7 | ACP pid, argv, cwd | `agents[].acp` | — | Diagnostics only; not a decision the operator makes here | Drop | Never rendered in the summary |
| C8 | Link to GitHub issue | `queue[].url` | — | Duplicates row click; the row opens the agent, not GitHub | Drop | The issue title text is not a link on this panel |
| C9 | Running count | `agents.length` | 3 | Whether any agent runs at all | Keep | Panel subtitle `N active`; the Automation facts row states the same count as the page-level fact |
| C10 | Empty state | `agents.length === 0` | 1 | Explains why the panel has no rows | Keep | One muted line with row padding |
| C11 | Per-row status colour | — | — | Nothing: the row is not a status view | Drop | Colour would repeat the panel without a word |

Rules applied:

- The panel header already names the subject (`Running agents`) and its subtitle counts rows, so
  the row never repeats the state word.
- The title is the only variable-length text; it owns the flexible column and truncates rather
  than resizing the number and meta columns.
- Run state is still visible once per screen: the lifecycle badge in the page header, the
  `running` state in the Automation facts, and the active marker in the mode rail.

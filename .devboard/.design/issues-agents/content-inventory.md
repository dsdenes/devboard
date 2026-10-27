# Content inventory — Issues / Agents

Current page treated as evidence, not a constraint. Every candidate must serve a journey from
`brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Issue number | `issues.queue[].number` via agent | Scan, inspect | Identify the work and open its tracker | Keep | Primary identity of a card |
| C2 | Issue title | `issues.queue[].title` | Scan, inspect | Decide whether to open the issue | Keep | The number alone does not identify scope |
| C3 | Tracker URL link | `issues.queue[].url` | Scan | Open the GitHub issue | Keep | The number carries the link |
| C4 | Run status word | `issues.statusFor(runId)` | Scan | Know whether the agent is running or failed | Keep | Fleet state; always a word, never color alone |
| C5 | Pending question | `agent.question` | Answer | Act on the agent that is blocked | Keep | The only decision that requires the operator |
| C6 | Elapsed time | `startedAt` + local clock | Scan | Judge whether a run is stuck | Keep | Compact live signal |
| C7 | Exact started timestamp | `agent.startedAt` | Scan (edge) | Correlate with logs | Keep compressed | Tooltip on C6; not a second visible line |
| C8 | Agent activity stream | `issues.activityFor(runId)` | Scan, inspect | See current progress without opening Focus | Keep, bounded | Full text remains scrollable; Focus keeps the tall view |
| C9 | Run identifier | `agent.runId` | Inspect (edge) | Correlate a run with state files | Drop from card | Internal identifier; equals the start timestamp; Focus shows it |
| C10 | Repository name | `issues.repo` | Scan (context) | Confirm the host | Keep | Page header context; already in the status bar, so one line only |
| C11 | Fleet count | `agents.length` | Confirm | Know how many are active | Keep | Header badge |
| C12 | Count of agents needing answers | derived `question !== null` | Scan | Prioritize | Keep | Header badge when non-zero |
| C13 | Focus control | card action | Inspect | Open the full run | Keep | Primary card action |
| C14 | Empty-state explanation | derived | Confirm empty | Know the worker is not running | Keep | Prevents a blank grid |
| C15 | Overview link in empty state | navigation | Confirm empty | Start the worker | Keep | Recovery action |

Deduplications:

- C1 already links to the tracker; no separate "Open issue" control.
- C6 absorbs C7; the ISO string and the elapsed value are the same fact in two forms.
- C9 is not shown; the run id is an implementation detail (and duplicates C7's timestamp).
- C11 lives once in the header; cards do not repeat a running badge for the page count.

# Issues — Agents fleet page content inventory

Scope: the whole `section.issues-agents-page`, including its header, the fleet grid, each agent
card, and the empty state. The current card was treated as evidence, not a constraint. Every item
was re-asked whether its removal costs a declared journey.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Issue number (`#225`) | `agents[].issueNumber` | 1, 2, 3, 5 | Identifies the card against the queue and tracker | Keep | Mono, accent link; the only tracker route on the page |
| C2 | Issue title | polled queue, `issueTitle()` | 1, 2, 5 | Confirms this is the issue the operator means | Keep | Two lines reserved, ellipsis, full text in the tooltip and heading |
| C3 | Per-card `running` badge | `issues.statusFor(runId)` | — | Nothing: the page and header are the running fleet | Drop | Repeated one state word on every card and in the header |
| C4 | Per-card `needs answer` badge | `agent.question` | 2 | Finds the blocked card | Drop | The warning-bordered card and the full question block already name the state; the header counts it once |
| C5 | Question text, options, answer field | `agent.question`, `IssuesAgentQuestion` | 2 | Answers the blocked agent without leaving the fleet | Keep | Inline warning block; the primary action of the page |
| C6 | Elapsed run time | `agents[].startedAt` + clock | 3 | Whether an agent has been stuck long enough to act | Keep | `mono-small`, tabular, ticks while the page is open |
| C7 | Absolute start clock | `agents[].startedAt` | 3 | Anchors the duration to a wall-clock time | Keep | Secondary to the elapsed value; one meta line |
| C8 | Latest activity preview | run activity stream | 1, 4 | What each agent is doing now | Keep | Labeled `Latest activity`, bounded and newest-first; the focus page owns the full stream |
| C9 | Link to the GitHub issue | `queue[].url` | 1 | Opens the tracker without leaving the card | Keep | The issue number is the link; the title is not |
| C10 | `Focus` action | `openAgent()` | 1, 5 | Opens the agent's full output, question, and run identity | Keep | One outline control in the card head |
| C11 | Running count | `agents.length` | 1 | Whether any agent runs, and how large the fleet is | Keep | Header badge `N running` |
| C12 | Waiting-question count | `agents.filter(question)` | 2 | Whether any agent is blocked, before scanning | Keep | Header badge `N need an answer`; pluralized |
| C13 | Page identity: eyebrow, title, repository | `PageHeader`, `repoLabel` | 1 | Confirms the mode and project | Keep | Existing page header |
| C14 | Empty state | `agents.length === 0` | 1 | Explains why the grid is absent and how to start the worker | Keep | One bounded panel with `Open Overview` |
| C15 | Run identifier | `agents[].runId` | — | Nothing here: the issue number selects the run | Drop | The card carries it as a DOM key and data attribute only; the focus page renders it |
| C16 | ACP pid, argv, cwd | `agents[].acp` | — | Diagnostics only; not an operator decision here | Drop | Never rendered |
| C17 | Per-card status colour | `data-status` | — | Nothing: the page is the running list | Drop | Colour would repeat the header state without a word |

Rules applied:

- The page states the lifecycle once in the header count; a card never repeats `running`.
- The waiting state is named three ways already (header count, warning block, warning card
  border); a fourth pill would be noise. The question block carries the text, so colour is never
  the only signal.
- The title is the only variable-length text. It reserves two lines so cards in a row align, and
  truncates with the full text in `title`.
- Activity is labeled rather than raw: an unlabeled monospace block read as run-on output.
- Every retained value maps to a declared journey; run identity and ACP diagnostics stay on the
  surfaces that own them.

# Issues queue row — content inventory

Current row treated as evidence, not a constraint. Candidate information on one
queue row; every item re-asked whether its removal costs a declared journey.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| Q1 | Issue number `#281` | `queue[].number` | J1, J2 | Recognises the issue and opens its tracker | Keep | The only tracker link; mono, tabular |
| Q2 | Issue title | `queue[].title` | J1 | Distinguishes issues with similar numbers | Keep | One line, ellipsis, full text in the tooltip |
| Q3 | Tracker URL | `queue[].url` | J1 | Opens the issue | Keep | Carried by the Q1 link target, not duplicated as text |
| Q4 | Goal label | `queue[].labels` contains `goal` | J2 | Recognises goal work before starting it | Keep | One `goal` badge; already tested by the interface contract |
| Q5 | Lifecycle word `pending` | `queue[].handled=false`, `agentRunId=null` | J2 | Knows no agent owns the issue yet | Keep | State word is the queue's core distinction |
| Q6 | Lifecycle word `running` | `queue[].agentRunId !== null` | J2 | Avoids starting a second agent on the same issue | Keep | Trailing badge; also tested by the contract |
| Q7 | Lifecycle word `handled` | `queue[].handled` | J2 | Knows the issue was already processed | Keep | Same slot as Q5/Q6; only one shows |
| Q8 | Row index | DOM order | — | Nothing: the tracker order is not a ranking | Drop | Never rendered |
| Q9 | Creation date | `queue[].createdAt` | — | Tracker owns the age; the queue does not sort by it | Drop | Adds a column no journey uses |
| Q10 | Labels other than `goal` | `queue[].labels` | — | Not part of the queue decision | Drop | Never rendered |
| Q11 | Repository name | `issues.repoLabel` | J1 | Confirms the project | Keep | Page header, not per row |
| Q12 | Open/pending totals | `issues.queue.length`, `issues.pending` | J2 | Sizes the queue | Keep | Page header and sidebar item, not per row |

Rules applied:

- One lifecycle word per row: Q5, Q6, and Q7 are mutually exclusive; the row never
  shows two states.
- Q4 is a label, not a state; it sits beside the state word but reads as an
  attribute.
- Q8–Q10 are available in the data and deliberately absent; no value is shown
  merely because the snapshot carries it.
- No row-level duplicate of Q11/Q12; the page header owns the totals.

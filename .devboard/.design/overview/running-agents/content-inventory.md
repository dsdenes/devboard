# Content inventory — Overview / Running agents

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Panel title `Running agents` | static | 1,2,4 | names the list | keep | the region needs one name |
| C2 | Fleet count (`11 active`) | `issues.agents.length` | 2 | fleet size | drop | the Automation panel directly above already states `Agents 11 running`; the list shows its own length |
| C3 | Waiting count (`2 need answers`) | `agent.question !== null` | 2 | jump to a blocked agent | keep | the only aggregate blocked-work signal on this route |
| C4 | Issue number | `agent.issueNumber` | 1,3 | identify the row | keep | scan column; mono |
| C5 | Issue title | `issues.queue` | 1 | choose the agent | keep | the primary scan target; ellipsis + tooltip |
| C6 | `needs answer` badge | `agent.question` | 2 | mark the blocked row | keep | color never alone; word present |
| C7 | Elapsed short (`59m`) | `agent.startedAt` | 1,2 | spot a stuck run | keep | one duration form; tabular mono |
| C8 | Started clock | `agent.startedAt` | 1 | precise start | keep, disclosure | tooltip on the elapsed value only |
| C9 | Selection marker | `selectedAgent` | 1 | know which row feeds the pane | keep | accent surface + edge; `aria-current` carries it too |
| C10 | Close-issue control | `issues.closeIssue` | 3 | retire an unwanted issue | keep | explicit word, quiet until targeted |
| C11 | Empty state | `agents.length === 0` | 4 | confirm nothing runs | keep | one sentence |
| C12 | Run id | `agent.runId` | — | — | drop | internal path; stays in `data-run` only |
| C13 | Worker pid / poll cadence | Automation panel | — | — | drop | the panel above owns them |
| C14 | Second Agents link | sidebar / Automation `Open Agents` | — | — | drop | already reachable twice |
| C15 | Per-row status word (`running`) | snapshot lifecycle | — | — | drop | the panel lists running agents only; repeating it is noise |

The shipped header carried a plain `11 active` subtitle. It is removed: the fact is already in the
Automation panel, and the list's own length shows it. The header keeps one right-hand element —
the waiting count — and only while at least one agent is blocked.

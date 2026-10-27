# Content inventory — Flow / Steering

Current panel treated as evidence, not a constraint. Every candidate must serve a journey from
`brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Panel title `Steering` | static | All | Identify the surface | Keep | Single identity line in the header |
| C2 | Draft note | `flow.steeringDraft` | Send | Write the direction | Keep | The primary input |
| C3 | Send action | `flow.steering.send` | Send | Submit the draft | Keep | The primary action |
| C4 | Note text | `flow.steering[].text` | Review | Read what was sent | Keep | The only record of the direction |
| C5 | Note source | `flow.steering[].source` | Review | Distinguish developer notes from widget conclusions | Keep | Two sources exist; the word names it |
| C6 | Note timestamp | `flow.steering[].timestamp` | Review | Place the note against activity | Keep compressed | One meta line; never a second date format |
| C7 | Note status word | `flow.steering[].status` | Review | Know whether the agent consumed it | Keep | Never color alone |
| C8 | Waiting summary | derived `status === "new"` count | Send, review | Know at a glance whether direction is pending | Keep | Header state line |
| C9 | Read timing (`Read at the next checkpoint`) | server contract | First visit, send | Decide whether a note will land in time | Keep | Only while the panel is empty |
| C10 | Empty-state line | derived | First visit | Understand why the log is blank | Keep | Panel body |
| C11 | Sidebar note count | `flow.steering.length` | Arrival | See that notes exist before opening | Keep outside panel | The sidebar already owns it; the header does not repeat the total |
| C12 | Note identifier | `flow.steering[].id` | — | Correlate state files | Drop | Internal; never needed by the operator |
| C13 | Raw error text | server error | Failure | Diagnose a refused send | Keep outside panel | The notification region owns it; the panel never prints transport errors |

Deduplications:

- C1 appears once, in the header; the tab title repeats it as navigation only.
- C6 is one timestamp, not a relative and an absolute value.
- C8 is a summary of C7; rows keep the per-note word, the header keeps the count.
- C11 stays in the sidebar; the panel does not repeat the total count.
- C13 stays in the existing notification region.

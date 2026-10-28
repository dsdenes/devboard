# Decision record start control — content inventory

Current cell treated as evidence, not a constraint. Candidate content for one action cell; every
item re-asked whether its removal costs a declared journey.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| A1 | The word `Start` | fixed label | J1, J2 | Starts the record | Keep | The only visible action in the cell; never icon-only |
| A2 | Record title | `record.title` | J1, J2 | Distinguishes this Start from the other rows | Keep | Accessible name only (`Start the implementation of <title>`); the row already prints it |
| A3 | Prerequisite tooltip | `goal.startLifecycleTitle` | J1, J2 | Explains why Start is unavailable | Keep | Native `title`; no extra line in the row |
| A4 | Disabled state | `goal.runStartDisabled` | J1, J2 | Prevents a conflicting run | Keep | Native disabled, 45% opacity, label intact |
| A5 | The word `Resolved` | action cell | J3 | Nothing: the row already states it | Drop | The Implementation column owns the state once |
| A6 | Record file name | `record.file` | — | Nothing: the File column prints it | Drop | Available on `data-file` for commands, never painted twice |
| A7 | Next marker | `goal.next` | J1 | Shows the lifecycle's first record | Keep | Existing title badge; it selects the filled variant, not a new word |
| A8 | Row click target | entire row | J3 | Opens the record detail | Keep | Not repeated inside the action cell |
| A9 | Run count or timestamps | none | — | Nothing in this decision | Drop | The Activity panel owns run history |

Rules applied:

- A1 is the visible label and the start of the accessible name, so WCAG 2.5.3 label-in-name holds.
- A2 is heard once per button rather than painted; the title column already carries the text.
- A3 stays a tooltip because it is a prerequisite explanation, not a state badge; it is absent
  when no prerequisite applies.
- A5 is the only removed content; the state is still available on the same row in the
  Implementation column, so no journey loses information.
- Nothing is added to compensate for the removed word.

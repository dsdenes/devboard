# Auto Scout agent header — content inventory

Scope: the header region and its footer. The filed-issues table, scan-activity panel, and alerts
below the header are evidence for context, not redesign candidates here.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Page name `Auto Scout` | registry descriptor label | J1–J5 | Identifies the surface; the only h1 | Keep | The page cannot be named another way without the sidebar. |
| C2 | One-sentence purpose | registry descriptor description | J1 | Confirms what a scan does before starting it | Keep | First-time arrival context; one line, no repetition below. |
| C3 | Lifecycle word (`stopped`, `starting`, `running`, `stopping`, `failed`) | agent snapshot | J1, J2, J4 | Decides whether Start or Stop is the available action | Keep | The action follows the state; color never carries it alone. |
| C4 | Forge sync word (`ok`, `stale`, `error`) | agent snapshot sync | J1, J5 | Decides whether the filed list is trustworthy | Keep | The header's health fact; the detailed reason stays in the alert below. |
| C5 | Last successful forge read clock | snapshot `sync.at` | J1, J5 | Bounds the age of the filed list | Keep | Pairs with C4; the alert below does not replace a clock. |
| C6 | Last scan clock | snapshot `cadence.lastRunAt` | J1, J3 | Confirms the schedule has been running | Keep in footer | Context for cadence; belongs with the interval that caused it. |
| C7 | Next scan clock | snapshot `cadence.nextRunAt` | J1, J3 | Confirms the saved interval took effect | Keep in footer | Same group as C6; never primary in the header row. |
| C8 | Start/Stop control | snapshot owned/lifecycle, connection | J2 | The one state-changing run action | Keep | Filled primary, exactly one per surface. |
| C9 | Scan interval field | snapshot `cadence.minutes` | J3 | Changes how often the agent runs | Keep in footer | Editable value plus its Save; secondary to the run action. |
| C10 | Save cadence control | command `setAgentCadence` | J3 | Commits C9 | Keep in footer | Sits beside C9, never in the primary row. |
| C11 | Hourly filing cap field | snapshot `limits.maxPerHour` | J4 | Bounds findings per rolling hour | Keep in footer | Empty means unlimited; placeholder states it. |
| C12 | Open-issues cap field | snapshot `limits.maxPending` | J4 | Bounds the open backlog | Keep in footer | Empty means unlimited; placeholder states it. |
| C13 | Save limits control | command `setAgentLimits` | J4 | Commits C11 and C12 | Keep in footer | One save for both limits, beside its fields. |
| C14 | Cadence validation message | client validation | J3 | Explains a rejected interval | Keep below header | Existing alert position; not header content. |
| C15 | Limits validation message | client validation | J4 | Explains rejected limits | Keep below header | Existing alert position; not header content. |
| C16 | Sync failure reason | snapshot `sync.error` | J5 | Explains a failed read | Keep below header | Too long for the bar; the alert owns the sentence. |
| C17 | Worker error | snapshot `error` | J1, J2 | Explains a failed lifecycle | Keep below header | Existing alert position; not a header fact. |
| C18 | Legacy timer block + disable control | snapshot `timer` | J2 | Explains why Start is unavailable and clears it | Keep below header | Conditional banner; the header keeps the state word. |

Deduplication: C4's word and C5's clock stay distinct (health plus its age). C6 and C7 stay only
as cadence context, not as independent header metrics. No value is repeated in two places: the
lifecycle appears once, the sync state once, the interval once, and each limit once.

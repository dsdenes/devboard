# Issues agent focus — content inventory

Scope: the output panel header and the information the tab needs to name its run.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Run identifier | `tab.resourceId` / `IssuesAgent.runId` / `IssuesRunDetail.runId` | Identify the run | yes — correlate tab, card, and run directory | yes | The tab's only exact identity. |
| C2 | Run start time | `IssuesAgent.startedAt` or `IssuesRunDetail.startedAt` | Identify the run, inspect a finished run | yes — tells a fresh run from an old one | yes | Short relative age is enough; the full ISO value stays in a tooltip. |
| C3 | Run status | live agent or run history | Monitor, inspect a finished run | yes — live vs finished | yes, already in the page header | One badge at page level; never repeat it in the panel header. |
| C4 | Activity lines | live stream or run history | Monitor, inspect a finished run | yes — the primary content | yes | Panel body owns it. |
| C5 | Pending question | agent | Answer | yes | yes | Rendered below the log. |
| C6 | Issue number and title | tab title | Identify the run | no — run identity is C1 | yes, already in the page header | Already present; do not repeat in the panel header. |
| C7 | Run status word in the panel header | run status | Monitor | no — C3 already states it | no | Duplicate of the page header. |
| C8 | Repository and checkout path | snapshot / run detail | Identify the run | no for this tab | no, in the panel header | Belongs to the Runs detail, not this header. |
| C9 | Worker pid and harness version | run detail | Debugging | no for this tab | no, in the panel header | Not part of the read-the-output journey. |

## Conflicts resolved

- **Live run vs run history.** A live agent and a loaded run can both exist. `C2` prefers the live
  agent's `startedAt`, which the server publishes from the same run record; history is the fallback
  once the agent is gone. `C3` uses the live status first, then history.
- **Identity presentation.** `C1` is a machine identifier, so it stays verbatim; only its
  presentation changes (chip, truncation, full value in the tooltip). It is never shortened or
  re-derived.

## Removed from the panel header

- The bare `panel__subtitle` treatment of `C1`, which showed a long ISO id in muted 11px text with
  no label, no boundary, and no start-time context.
- Any status re-statement: the page header badge already carries `C3`.

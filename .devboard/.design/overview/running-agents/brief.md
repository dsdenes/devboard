# Brief — Overview / Running agents

Issue #256 selects the second panel of the Overview side column:
`#workspace-issues > section.issues-overview > div.issues-overview__body > div.issues-overview__side > section.panel:nth-of-type(2)`.

## Surface identity

- Route: Issues mode → Overview (`#workspace-issues > section.issues-overview`), left column.
- Entry points: the Issues mode tab and the Overview sidebar entry; the operator lands here
  after starting the worker.
- Audience: one repository operator watching a live issues fleet.

## Primary goal

Pick which running agent the right-hand output pane streams. Success is one click on the row of
the issue the operator cares about, with the selected row visibly the source of that pane.

## Secondary goals

- See at a glance how many agents run and whether any of them waits on an answer.
- See how long each agent has been running.
- Close an issue the operator no longer wants implemented, without stopping the agent already
  working it.

## Arrival context

The operator already started the worker from the panel directly above. The fleet is frequently
large (10–20 agents), titles are long, and several agents may be blocked on a question. This is a
dense desktop console at 1024×720 minimum; it is never a mobile surface.

## Relationship to other pages

The Automation panel above owns lifecycle controls and the fleet facts. The right column owns the
selected agent's stream and question. The Agents page owns per-agent cards and Focus tabs; the
queue and Runs pages own open and finished work. This panel is only the fleet picker.

## User journeys

1. **Pick an agent.** Trigger: the focused agent is not the one wanted. Steps: scan the rows, click
   a title. Success: the output pane switches to that run and the row reads as selected. Failure:
   the row and pane disagree. Recovery: click again; the pane always follows the newest selection.
2. **Find a blocked agent.** Trigger: an agent waits on a question. Steps: scan for the warning
   marker. Success: the blocked row and the header count both name it. Failure: the panel reads as
   a uniform list. Recovery: open Agents, which renders the question itself.
3. **Close an unwanted issue.** Trigger: the operator decides issue N should not be implemented.
   Steps: use the row's Close control. Success: the issue leaves the next poll as not planned.
   Failure: the closure is refused. Recovery: the reason arrives as an error notification and the
   issue stays open.
4. **Confirm the fleet is empty.** Trigger: no agents run. Steps: read the empty state. Success:
   one sentence states it and no blank rows remain.

## Failure routes

- Empty fleet: one explicit empty row, never a blank panel.
- Long title: one line with ellipsis; the full title stays in the tooltip.
- Many agents: the side column scrolls; the rows never overlap or clip their meta.
- A closure in flight: the control is disabled, not hidden.
- A refused closure: the panel is unchanged and the error is announced by the notification region.
- No queue metadata: the title falls back to `Issue N`; the row still renders.

## Non-goals

- Lifecycle controls, poll state, worker facts (the Automation panel above).
- Full logs, questions, and answer controls (the right output column; the Agents page).
- Sorting, filtering, or paging the fleet.

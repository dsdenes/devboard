# Issues overview — running agent list brief

Issue: #238, redesign the selected row of `ol.issues-agent-summary` (the issue-title span inside
`button.issues-run`). The report names the Issues overview at `/`; this brief covers only that
running-agent list, not the rest of the mode.

## Page identity

- Route: `/`, client-only Issues mode at its Overview page. The mode rail is the entry; the
  Issues tab remembers the last Issues page in `localStorage`.
- Visible identity: eyebrow `Issues`, page title `Issue automation`, the repository as
  `owner/repo`, and the lifecycle badge.
- Auth/role: local operator of the running dashboard. No account model.
- Entry points: mode rail `Issues` (Alt+2), command palette, or a restored layout.

## Primary goal

Resume watching one running agent before it finishes or stalls. The list is the fastest route
from the overview to one agent's output and question, so a row must name the issue precisely and
stay clickable end to end.

Observable success signal: clicking a row opens the agent focus page for that issue's run and its
output, with the row still identifiable when the operator returns.

## Secondary goals

- Spot an agent that is waiting on an answer without opening every row.
- Compare how long the running agents have been working.

## Arrival context

- The operator arrives after starting or checking the Issues worker. They know the repository
  and roughly which issues were open.
- They carry the page state: lifecycle word, running count, queue size, keep cooldown and run
  count in the Automation panel beside the list.
- Device: desktop, at least 1024×720; below 1100px the two overview columns stack and the list
  moves under the Automation panel.
- Urgency: high when an agent waits on a question, low otherwise. Titles are long, operator
  authored sentences that carry the whole request, so truncation is normal.

## Relationship to other pages

- Upstream: the Issues worker state (`agents[]`) and the polled queue supply each row.
- Downstream: a row opens the agent focus page, which owns the question answer, the activity log,
  and Stop.
- Loop: answering a question in focus returns the agent to work; the overview row keeps its
  elapsed time and drops the answer mark.
- State left behind: the open workspace tab, not the row.

## User journeys

1. **Open a running agent.** Trigger: the operator needs one issue's output. Steps: scan the
   list, match `#number` and title, click the row. Success: the focus page names `#number` and
   the title. Failure: no agents → one empty line (`No issue is running.`); the row still
   remains one line with the title truncated, never wrapping the layout. Recovery: `Open Agents`
   in the Automation panel lists every running agent as a card.
2. **Find the blocked agent.** Trigger: the worker has not advanced. Steps: scan the right side
   of each row for the `needs answer` badge, open that row, answer. Success: the badge
   disappears on the next state push. Failure: two agents blocked → both rows carry the badge;
   colour never alone, the words stay.
3. **Judge how long work has been running.** Trigger: deciding whether to stop a stuck agent.
   Steps: read the elapsed value at the row's right edge, compare across rows. Success: every
   row shows a compact mono duration that ticks while the overview is open. Failure: malformed
   start time → the raw value renders instead of a duration.
4. **Keyboard scan.** Trigger: the operator drives by keyboard. Steps: Tab reaches each row in
   issue order, the focus ring is visible, Enter or Space opens it. Success: focus order follows
   the sorted list; the empty state is not focusable.

## Non-goals

- Starting, pausing, stopping, or answering from the overview. Those controls stay in the
  Automation panel and the agent focus page.
- Listing finished agents, run history, or per-agent activity in this panel.
- Changing the panel header, the Automation panel, or the Agents page.

## Assumptions (inferred from code)

- `agents[]` is already sorted by issue number in the client store; the list keeps that order.
- `startedAt` is an ISO timestamp; the UI owns the elapsed presentation.
- A question mark is per-agent (`question !== null`) and arrives with the state push.

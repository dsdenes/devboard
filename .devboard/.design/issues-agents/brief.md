# Brief — Issues / Agents

## Page identity

- Route: Issues mode → Agents tab (`#workspace-issues > section.issues-agents-page`).
- Entry points: sidebar `Agents`, the status bar issues indicator, and a restored `agents` tab
  after reload.
- Audience: the repository operator watching a running issues fleet.

## Primary goal

See which issues are being worked, which agent needs an answer, and how long each has run, then
open the one that needs attention. Success is reaching the right agent's Focus tab without
reading a terminal stream for every card.

## Secondary goals

- Notice a pending question and answer it without leaving the fleet.
- Confirm the fleet size and that newly started agents appear.

## Arrival context

The operator arrives while agents run, often with 10–20 cards. They know issue numbers and the
current task, not run identifiers. They expect one scan to separate "working" from "waiting on me".
The page is a desktop operator console (minimum 1024×720); it is not a mobile surface.

## Relationship to other pages

Overview starts and stops the worker and links here. Focus opens a single agent's full output in
its own tab. Queue and Runs hold the issues and completed work. This page is the live fleet view
between Overview and Focus.

## User journeys

1. **Scan the fleet.** Trigger: operator opens Agents. Steps: read issue numbers and titles, scan
   statuses and elapsed times, notice any question marker. Success: the agent needing attention is
   obvious. Failure: 20 cards look identical and questions hide below the fold. Recovery: a
   question badge and a warning edge on its card. Exit: opens Focus on one card.
2. **Answer an agent.** Trigger: a card shows a pending question. Steps: read the question, choose
   an option or type an answer, submit. Success: only that agent's question clears. Failure:
   submission refused; the question stays with its error. Recovery: retry from the same card.
3. **Inspect one agent.** Trigger: a card's Focus control. Steps: open the Focus tab, read the full
   output, close back to Agents. Success: the focus tab keeps the same run. Failure: a pruned run
   shows the unavailable state with a Runs link.
4. **Confirm the fleet is empty.** Trigger: no agent is running. Steps: read the empty state.
   Success: the state names the worker as the next step and links to Overview.

## Failure routes

- No running agents: explicit empty state, never a blank grid.
- Long issue title: clamps on the card; the full title stays in the tooltip and the Focus tab.
- Many agents: the grid scrolls inside the workspace; the header does not scroll away from the
  page's own scroll container.
- Missing queue metadata: the linked issue falls back to `Issue N` and an empty tracker URL; the
  card still renders.
- Failed run: status badge takes the error tone and keeps the word.
- Pending question: warning edge, `needs answer` badge, and the question block; status never relies
  on color alone.

## Non-goals

- Starting, pausing, or stopping the worker (Overview owns those).
- Completed run history (Runs owns it).
- Rendering full logs for every agent at full height (Focus owns that).

## Assumptions

- `issues.agents` is already sorted by issue number ascending and contains only active agents.
- The activity stream is the newest source for per-agent progress; the full log stays available in
  Focus.

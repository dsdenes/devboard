# Issues — Agents fleet page brief

Issue: #240, redesign the selected `section.issues-agents-page`. The page is the Issues mode's
fleet monitor at `/` when the `Agents` sidebar entry, the `Open Agents` control, or the command
palette opens it.

## Page identity

- Route: `/`, client-only Issues mode, Agents page. The mode rail is the entry; the sidebar
  `Agents` entry and the Overview `Open Agents` button are the in-product routes.
- Visible identity: eyebrow `Issues`, title `Agents`, the repository as `owner/repo`, a running
  count and a waiting-question count.
- Auth/role: local operator of the running dashboard. No account model.
- Entry points: sidebar `Agents`, Overview `Open Agents`, command palette, a restored page.

## Primary goal

Monitor the whole running fleet and act on the agent that needs the operator. One screen must
answer: which issues are running, which one is blocked, and what each agent is doing now. The
operator then answers the blocked agent inline or opens one agent's focus page.

Observable success signal: the operator can identify the blocked agent from the grid and either
submit an answer in its card or reach its focus page in one click, without opening other cards.

## Secondary goals

- Compare how long the running agents have been working.
- Follow the newest activity line of every agent without changing pages.
- Reach the issue on the tracker from the card.

## Arrival context

- The operator arrives after starting or checking the Issues worker, and knows the repository and
  roughly which issues are open.
- They carry the page state: the worker lifecycle, the queue and run counts in the sidebar, and
  the aggregate counts in the page header.
- Device: desktop, at least 1024×720. At 1440×900 the workspace fits two cards per row; at the
  2101-wide capture it fits four.
- Urgency: high when an agent waits on a question, low otherwise. Agent titles are long,
  operator-authored sentences that carry the whole request, so truncation is normal.

## Relationship to other pages

- Upstream: the issues worker state (`agents[]`), its activity stream, and the polled queue.
- Downstream: a card's `Focus` opens the agent focus page, which owns the full activity stream,
  the question answer, and the run identity. A card's `#number` opens the tracker.
- Loop: answering in a card drops that card's question block and decrements the header's waiting
  count on the next state push; the activity and elapsed time continue.
- State left behind: the open Agents page and its scroll position, not the selected card.

## User journeys

1. **Survey the fleet and open one agent.** Trigger: the operator needs one agent's output.
   Steps: scan issue numbers and titles, check the right side of each card, click `Focus`.
   Success: the focus page names the issue and shows its activity. Failure: no agents → the
   empty state explains how to start the worker and offers `Open Overview`. Recovery: the
   sidebar `Agents` entry stays reachable.
2. **Answer a blocked agent.** Trigger: a card shows a question. Steps: read the question,
   choose an option or type an answer, submit. Success: the card's question block disappears on
   the next state push and the header count decrements. Failure: an empty answer disables the
   `Answer` button; a send failure leaves the question in place. Recovery: retry or open the
   focus page.
3. **Judge how long work has been running.** Trigger: deciding whether an agent is stuck. Steps:
   read the elapsed value on each card and compare. Success: every card shows a ticking duration
   and the absolute start time. Failure: a malformed start time renders verbatim instead of a
   duration.
4. **Follow the latest activity.** Trigger: the operator wants to know what each agent is doing.
   Steps: read the labeled activity block on a card. Success: the block follows the newest lines.
   Failure: an agent with no lines shows `No activity yet.`
5. **Keyboard scan.** Trigger: the operator drives by keyboard. Steps: Tab reaches each issue link
   and `Focus`; the focus ring is visible; Enter opens the target. Success: focus order follows
   issue order.

## Non-goals

- Starting, pausing, stopping, or closing issues from this page; those controls stay on Overview
  and the agent focus page.
- Listing finished agents or run history; the Runs page owns that.
- Replacing the Overview output pane or the agent focus page.
- Changing the page header, the empty state copy, or the sidebar.

## Assumptions (inferred from code)

- `agents[]` is already sorted by issue number in the client store; the grid keeps that order.
- `startedAt` is an ISO timestamp; the card renders elapsed and start clock from it.
- `question !== null` identifies a blocked agent and arrives with the state push.
- The activity stream belongs to a run and is replayed on connect; the card shows its newest
  lines and follows appends.

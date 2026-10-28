# Issues queue row — brief

Slug: `issues-queue-row`. Scope: one row of `ol.issues-queue` on the Issues mode
Queue page (`section.issues-queue-page`), plus the page's empty row. Design
artifacts live under `.devboard/.design/` per the harness convention; the
interface is the harness's own UI.

## Page identity

- Route: Issues mode → `Open issues` (sidebar item `Issues`, `page=queue`).
- Title: `Open issues`; repository label under it.
- Auth/role: local operator console; no accounts, no roles.
- Entry points: the Issues rail tab, the sidebar `Issues` item (with the pending
  count), the status bar's issues-worker button, and the command palette's
  queue command.

## Primary goal

Decide which open tracker issue to open, start, or leave alone. The observable
success signal: the operator opens one issue's tracker URL from the queue, or
leaves the page knowing which issues already have a running agent.

## Secondary goals

- Recognise a goal-labelled issue before starting work on it.
- Recognise the per-issue lifecycle word (pending, running, handled).

## Arrival context

The operator is in Issues mode, has just read the Overview's fleet or the
sidebar count, and scans the queue for a specific issue number or title. They
carry the repository identity and the current worker state. Desktop viewport,
local network; no urgency beyond a running agent that may need attention.

## Relationship to other pages

- Upstream: Issues Overview (fleet and pending count), sidebar, status bar.
- Downstream: the GitHub tracker (external) opened from the issue number.
- Loops: the queue repolls, so a row changes state in place while the page is
  open.
- State left behind: the queue page itself. Opening the tracker leaves devboard.

## User journeys

J1 — Find one issue and open its tracker.

- Trigger: the operator needs the issue description or to act on GitHub.
- Steps: scan by number or title; hover the row; click the `#number` link.
- Decision points: is this the issue? Is it already running or handled?
- Success: the tracker page opens in a new tab.
- Failure: the link target is wrong, or the title is clipped and the operator
  cannot tell two issues apart.
- Recovery: hover the title for its full text, or scan the number.
- Exit: the tracker tab.

J2 — Check what the worker is doing without leaving the page.

- Trigger: the operator wants to know whether an issue already has an agent.
- Steps: scan the right-hand state word of each row.
- Decision points: start another issue or wait.
- Success: the running rows are identifiable at a glance.
- Failure: two badges collide or wrap, so the state reads as part of the
  number column and the row height jumps.
- Recovery: none needed in the correct design; the state word is always on the
  row's trailing edge.
- Exit: back to scanning or to the Overview.

J3 — Read an empty queue.

- Trigger: the worker has not polled yet, or no open issues exist.
- Steps: read the single empty line.
- Success: the reason for the empty panel is stated.
- Failure: the empty line is mistaken for a row.
- Exit: start the worker from the Overview.

## Non-goals

- Starting an agent from a row; the Overview and the issue prompt own that.
- Editing, closing, or filing tracker issues from the queue.
- Sorting, filtering, or grouping the queue; the list is tracker order.
- A detail view; the tracker owns the issue body.

## Assumptions

- `issues.queue` is unordered by design and rendered in tracker order.
- A row never needs more than two badges: the `goal` label and one lifecycle
  word (pending, running, handled).
- The supported viewport is at least 1024×720; below that the viewport guard
  replaces the workspace.

# Auto Scout agent header — UX brief

Issue: #465, redesign the selected element
`#workspace-issues > section.agent-page > header.page-header.page-header--bar`.
Route `/`, Issues mode, Auto Scout page. This brief covers the header region only; the filed-issues
table, the scan-activity panel, and the alerts below the header keep their existing behavior.

## Page identity

- Route: `/` → Issues mode → sidebar `Auto Scout` (`open-issues-scout`, tab kind `scout`).
- Title: `Auto Scout`.
- Auth/role: local operator of one repository; no roles, accounts, or permission gates.
- Entry points: the Background agents sidebar entry, the command palette, a restored workspace tab
  after reload, and programmatic focus on the agent.

## Primary goal

Understand the Auto Scout's operating state and act on it: whether the worker is running, whether
its forge reads are healthy, how often it scans, how many findings it may file, and the one
Start/Stop control that changes the run. Success signal: the operator can answer all of those from
one glance and can change the cadence or the limits without leaving the page or losing the filed
issues in the same view.

## Secondary goals

- Keep the Start/Stop control unambiguous and unique: it is the only filled primary control.
- Keep freshness visible: the last successful forge read explains whether the filed list is
  current.
- Keep cadence editing and its validation next to the schedule it changes.

## Arrival context

The operator arrives from the Issues sidebar, generally while investigating why the agent did not
file an expected finding, or while tuning how often and how much it files. They know the
repository and the agent; they do not know the current state, the schedule, or the active limits
without looking. The desktop is at least 1024×720, the workspace is resizable, and nothing here is
a mobile surface. The page is time-sensitive only in the sense that "next run" matters; no
destructive or financial action exists.

## Relationship to other pages

- Upstream: Issues overview and the Background agents sidebar entry, which carry a coarse
  lifecycle word and a pending count.
- Sibling: the Watchdog page renders the same header contract from its own registry descriptor.
- Downstream: the filed-issues table and the scan-activity/cycle panel, which depend on the forge
  read that the header's sync state reports.
- Loop: save cadence or limits, the server publishes a new snapshot, and the header reports the
  saved values and the recomputed next run.

## User journeys

### J1 — Read the state

Trigger: the operator opens the Auto Scout page.
Steps: read the page name and purpose; read the lifecycle word; read the forge sync word and the
last-read clock; scan the schedule and the active limits.
Decision: is the worker running, is the filed data fresh, and is the budget what I expect?
Success: the operator can state the lifecycle, the read health, the cadence, and the limits.
Failure: before the first snapshot the header renders neutral values (stopped, stale, never,
disabled Start) rather than an empty frame.
Exit: J2, J3, J4, or leave the page.

### J2 — Start or stop the worker

Trigger: the operator needs the agent to run or to stop running.
Steps: read the lifecycle word; press the single Start/Stop control.
Decision: act only when the state allows it; a live worker owned by another dashboard cannot be
stopped here, and Start is a no-op with a notice.
Success: the lifecycle word changes through `starting`/`running` or `stopping`/`stopped`.
Failure: a disconnected socket disables Start; a legacy timer blocks Start and the banner below
the header explains how to clear it. Recovery: reconnect or clear the timer, then retry.
Exit: J1 or leave the page.

### J3 — Change the scan cadence

Trigger: the operator wants a different interval between scans.
Steps: read the current `Every` value; edit it; press `Save cadence`.
Decision: the field is in minutes; the valid range is 1–1440.
Success: the saved value appears in the field and the next-run clock moves.
Failure: a non-integer or out-of-range value shows an inline alert and nothing is sent; the last
saved value remains in effect. Recovery: correct the value and save again.
Exit: J1.

### J4 — Bound how many findings are filed

Trigger: the operator wants to cap the filing rate or the open backlog.
Steps: read `Per hour` and `Open issues`; edit either; press `Save limits`.
Decision: each field is empty (`unlimited`) or an integer from 1 through 100.
Success: the saved values appear and the next snapshot matches them.
Failure: an invalid value shows an inline alert and nothing is sent. Recovery: correct or clear
the field and save again.
Exit: J1.

### J5 — Investigate a failed forge read

Trigger: the sync word reads `error` or the last-read clock is old.
Steps: read the sync word and the last-read clock; read the alert below the header; keep the last
successful clock as the freshness bound.
Decision: rely on the filed list only as of the last success; retry the run only when the cause is
cleared.
Success: the next successful read returns the badge to `ok` and updates the clock; the error alert
clears.
Failure: the cause persists; the header keeps reporting it without hiding the filed rows.
Exit: J1 or leave the page.

## Non-goals

- Editing the agent's prompt, registry descriptor, or engine.
- A manual "scan now" trigger.
- A history of runs or filed findings (the panels below own that).
- Per-finding actions, or changing how the tracker close works.
- Mobile layouts; the supported floor is 1024×720.

## Assumptions

- The browser connects to one dashboard and one repository; the agent id is stable (`scout`).
- `stamp()` renders local time; the clocks are informational, not editable.
- The Watchdog page shares this header contract and must not diverge in composition.

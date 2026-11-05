# Metric history panel — UX brief

## Identity
- Route: `/` → Devboard mode → `Complexity` (`data-command="devboard.tab.complexity"`).
- Surface: `section.panel[aria-label="Metric history"]` inside `data-testid="complexity-page"`.
- Auth/role: local operator of one repository; no roles or remote accounts.
- Entry points: the Devboard sidebar's `Complexity` entry and the command palette.

## Goal
- Primary goal: judge whether the project's code metrics are moving over the recorded days.
- Success signal: the operator can name the newest value of any metric and how far it moved
  across the whole recorded window without reading a table.
- Secondary goals: confirm how many days the history covers; see the measured date span.

## Arrival context
- What the user knows: the repository is measured once per day and this page shows the history.
- What they carry in: a suspicion that complexity grew, or a habit of checking after a merge.
- Prior page/state: the page is reached from any mode; no selection carried in.
- Device/network assumptions: desktop browser at 1024×720 or wider; local WebSocket.
- Urgency: low; the surface is reviewed occasionally, not per minute.

## Relationship to other pages
- Upstream: the Devboard rail; the daily snapshot worker.
- Downstream: no page consumes this one; the per-file table below is a separate surface.
- Loops: read the trend, open a file's numbers in the per-file table, return.
- State left behind: none; the panel is read-only and stores no selection.

## Journeys

### Journey 1 — Read the trend of one metric
- Trigger: the operator wants to know whether a metric moved.
- Steps: find the metric's row by name, read its line, read its newest value and its change.
- Decision points: whether the movement is large enough to act on.
- Success: name, shape, newest value, and whole-window change are read in one row.
- Failure routes: no snapshot yet (empty state); a single recorded day (no line or change).
- Recovery: wait for the next daily snapshot; the page reads it on the next frame.
- Exit: leave the page or open the per-file table.

### Journey 2 — Compare all metrics at one glance
- Trigger: a periodic review of the project's health.
- Steps: scan the eight rows top to bottom, using the shared date axis once.
- Decision points: which metric moved most.
- Success: the rows align, so values and changes compare vertically.
- Failure routes: the history is longer than the axis labels show; the axis thins to first,
  middle, and last.
- Recovery: none needed; the line keeps its shape at any length.
- Exit: leave the page.

### Journey 3 — Read the history while it loads
- Trigger: the page opens before the server answers.
- Steps: read the panel, which reports that it is loading.
- Decision points: none.
- Success: no invented value and no blank chart is drawn.
- Failure routes: the connection drops; the shell reports it.
- Recovery: the page re-reads on reconnect.
- Exit: leave the page.

## Non-goals
- Editing metrics or triggering a measurement.
- Per-function or per-file detail (the per-file panel and its table own that).
- Comparing two repositories, or any target/threshold the server does not record.

## Assumptions
- The daily snapshot list is the only source of the series; no interpolation is invented.
- Each series is normalised to its own range by design, so the row keeps the newest value and
  the change as numbers rather than relying on the line's amplitude.
- The page header already states the newest date, the recording clock, and the day count, so the
  panel does not repeat them.

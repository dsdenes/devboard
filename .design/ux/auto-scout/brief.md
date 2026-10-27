# Auto Scout — UX brief

## Identity
- Route: `/` → Issues mode → Auto Scout (`#workspace-issues`, `section.issues-scout`).
- Title: `Auto Scout`; the subtitle names the repository origin (`owner/repo`).
- Auth/role: local operator of one repository's dashboard; no accounts or roles.
- Entry points: the Issues sidebar (`open.issues.scout`), the command palette, and the
  restored Issues page in `localStorage`.

## Goal
- Primary goal: run or stop the Auto Scout worker and understand whether it is healthy.
- Success signal: the lifecycle state, the last GitHub read, and the next attempt are
  readable in one glance, and Start/Stop reflects what the server will accept.
- Secondary goals: leave the worker unattended while its scans file issues; adjust the
  filing limits; inspect what was filed and read the current scan's activity.

## Arrival context
- What the user knows: Auto Scout scans this checkout and files high-significance issues
  under the `scout` label. It may be stopped, scanning, idle, or failed.
- What they carry in: an intent to start a first scan, stop an unattended worker, tune
  the filing budget, or check why nothing was filed.
- Prior state: the sidebar count of open scout issues; a previous scan may exist.
- Device/network assumptions: desktop browser at 1024×720 or wider; the dashboard
  streams state over a local WebSocket. The page never polls.
- Urgency: low while idle; high when a read failed or the worker is failed.

## Relationship to other pages
- Upstream: the Issues sidebar and the worker's published snapshot.
- Downstream: GitHub issues opened from the filed-issues table; the operator returns
  here to read the newest scan.
- Loops: start → scans and filings → stop; adjust limits → save → the worker applies
  them on its next pass.
- State left behind: worker lifecycle and settings are durable; the open page is a
  browser-only layout value.

## Journeys

### Journey 1 — Start a scan and watch it work
- Trigger: the operator opens Auto Scout with the worker stopped.
- Steps: read the lifecycle and repository, choose `Start`, watch the activity log and
  the filed-issues count.
- Decision points: start now versus leave it stopped; stop if the first pass is wrong.
- Success: lifecycle leaves `stopped`; the activity log shows the scan; filed issues
  appear with title, category, state, and shipped version.
- Failure routes: Start is unavailable while the socket is closed or a worker is
  already attached; a scan failure surfaces in the activity log and the error banner.
- Recovery: read the error, correct the repository or GitHub access, start again.
- Exit: the operator leaves the page while the worker continues, or chooses `Stop`.

### Journey 2 — Stop an unattended worker
- Trigger: the operator wants no further scans or filings.
- Steps: read the lifecycle, choose `Stop`, confirm the state returns to `stopped`.
- Decision points: stop versus wait for the current scan.
- Success: the lifecycle badge reads `stopped` and Start becomes the only action.
- Failure routes: Stop is disabled when no worker is attached; a failed stop surfaces
  the server error and keeps the previous lifecycle.
- Recovery: retry Stop or read the error banner.
- Exit: the operator leaves the page.

### Journey 3 — Tune the filing limits
- Trigger: the worker files too many or too few issues per hour.
- Steps: read the current limits, edit `Issues per rolling hour` and `Open issues`,
  choose `Save limits`.
- Decision points: save versus leave the existing budget.
- Success: both values persist across a reload and the worker applies them.
- Failure routes: a non-integer or out-of-range value shows `Both limits must be
  integers from 1 through 100.` and sends nothing.
- Recovery: correct the field and save again.
- Exit: the operator returns to monitoring.

### Journey 4 — Explain a stale read or empty result
- Trigger: the table is empty, stale, or an error banner appeared.
- Steps: read the GitHub-read badge and last successful read, then the reason in the
  banner, then the scan activity.
- Decision points: wait for the next attempt, restart the worker, or fix access.
- Success: the operator knows whether the empty table is a real result or a read
  failure.
- Failure routes: the error text is missing or the last success is overwritten.
- Recovery: the next successful read clears the badge and keeps the newest rows.
- Exit: back to monitoring.

## Non-goals
- Choosing recommendations, scores, or the worker's prompts.
- Reviewing, approving, rejecting, or drafting goals from scout findings; the review
  widget was removed on purpose.
- Paging through older scans; the newest scan is the only activity shown.
- Opening the Issues overview, queue, runs, or agents.

## Assumptions
- The server snapshot is the only source of lifecycle, sync, limits, rows, and activity.
- `pending` means an open scout issue; a closed one is `implemented`.
- An empty table is a valid result and must not be confused with a failed read.

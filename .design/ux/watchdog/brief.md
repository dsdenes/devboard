# Watchdog page — brief

Issue: #358, redesign the selected element `#workspace-issues > section.watchdog-page`.
Route `/`, Issues mode, Watchdog page.

## Page identity

- Route: `/`, client-only Issues mode. The mode rail's `Issues` tab (Alt+2) is the entry; the
  sidebar's `Watchdog` entry (`open-issues-watchdog`) opens this page in place of the Overview tab.
- Title: `Watchdog`. No account model; the local operator of the dashboard.
- The page reads only `GET /api/watchdog`; it never files, comments, closes, starts, or fixes.

## Primary goal

Decide whether the repository watchdog is healthy right now: its last GitHub read succeeded, its
newest cycle ran and what it did, and whether anything is waiting to be filed.

Success signal: one glance at the top of the page answers "is it running, when did it last read,
what did the newest cycle do, and is anything stuck?" with no scrolling.

## Secondary goals

- Confirm that findings became GitHub issues, and whether those issues are still open.
- Inspect the retained cycle history for a recent failure, a filed run, or a gap in cadence.
- Trace a cycle row to the exact GitHub issues it produced.

These never compete with the primary goal: history and the issue table sit below or beside the
newest-cycle summary.

## Arrival context

- The operator arrives from the Issues sidebar, usually after automation feels wrong (nothing
  filed, a rate-limit alert, a stalled cycle) or before trusting the fleet.
- They know the repository and the mode; they do not know the latest cycle's outcome.
- Desktop only, at least 1024×720. The workspace pane is wide (measured 1726px at 2101px viewport)
  and the page must use it instead of stretching one narrow strip.
- Urgency is high when a sync error or pending filing exists, low during routine checks.

## Relationship to other pages

- Upstream: the watchdog service writes run reports and the ledger under `<STATE_DIR>/watchdog/`;
  the server projects GitHub state every 60 seconds.
- Downstream: every issue link opens GitHub in a new tab; the status bar's watchdog indicator is
  unchanged and opens its own popover.
- Loop: a newly written cycle or ledger entry appears within the 15-second poll, without reload.
- State left behind: the active Issues tab; the page itself owns no persisted state.

## User journeys

1. **Routine health check.** Trigger: open Watchdog. Steps: read the sync badge and last-read
   time, read the newest cycle's age, action, findings, pending count, and reason. Success: the
   status is `ok`, the age is minutes, and pending is `0`. Failure: `error` or `stale` badge with
   the server's message above the summary; the page keeps the last known cycle facts. Recovery:
   the next successful GitHub read clears the error in place.
2. **Verify what a run filed.** Trigger: the newest action is `filed` or `commented`. Steps: read
   the newest cycle, then find the issue in the filed table; follow the row to GitHub. Success:
   the row names the issue, its category, filed time, and state. Failure: the table is empty while
   the ledger reports pending filings; the pending count names the gap. Recovery: read the next
   cycle row or the sync error.
3. **Investigate a failure streak.** Trigger: automation looks wrong. Steps: scan cycle history
   for `failed` rows and their issue links, then read the newest reason. Success: the failure rows
   are visible without scrolling the whole document. Failure: history is truncated by the
   retained window; the page states the newest-first order. Recovery: the cycle rows remain
   scrollable inside their panel.
4. **Return to an already-known issue.** Trigger: an operator remembers an issue number. Steps:
   scan the filed table's newest-first rows, read the state badge and shipped version. Success:
   the row still exists with its current GitHub state. Failure: GitHub read failed; the table
   keeps the last known state and version, and the sync badge reports the error.
5. **Keyboard pass.** Trigger: the operator uses Tab. Steps: reach the header, issue links, and
   cycle links in reading order. Success: every link has a visible 2px ring; focus never enters
   the empty states. Failure: no links exist; the page remains readable but unactionable.

## Non-goals

- Starting, stopping, re-running, or repairing the watchdog from this page.
- Showing per-cycle finding text, windows, or reasons in history rows (the retained contract
  keeps compact rows: time, action, issue links).
- Changing the status-bar indicator, the popover, the sidebar, or the server projection.
- Inventing a repository name, cadence, or health metric the API does not return.

## Assumptions (inferred from code and README)

- `cycles` is newest first, capped at 100, one row per retained run directory.
- `snapshot.pending` is the number of fingerprints still waiting for a successful filing.
- `sync.state` is `ok`, `stale` (a success older than 120 seconds with no later failure), or
  `error`; `sync.at` is the last successful read or `null`.
- The page polls every 15 seconds; the newest cycle and ledger rows appear without a reload.

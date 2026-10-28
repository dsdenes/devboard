# Watchdog page — brief

## Page identity

- Route: Issues mode → `Watchdog` sidebar entry (`open.issues.watchdog`); the page replaces the
  mode's active tab until another Issues page opens.
- Title: `Watchdog`, eyebrow `Issues`.
- Auth/role: local operator; no role gate and no mutation from this page.
- Entry points: the Issues sidebar entry, the persistent Issues tab, and the status-bar watchdog
  indicator's surrounding context.

## Primary goal

Decide whether the unattended watchdog is healthy and what its last cycle did. Observable success:
the operator can read the sync state, the last cycle's action, its findings and pending filings,
and the reason, then leave without opening a run directory.

## Secondary goals

- Audit the recent cycle history: which cycles found nothing, which filed, which failed.
- Review every issue the watchdog filed, with its GitHub state and the release that shipped it.
- Reach a filed issue on GitHub in one click.

These support the primary goal and do not compete with it; the page never starts, stops, files,
comments, closes, or fixes anything.

## Arrival context

The operator arrives from Issues mode, usually after noticing the status-bar watchdog or an
unexpected filed issue. They know the repository and the watchdog cadence (one cycle every ten
minutes) but not the newest action. The dashboard is local, so latency is low, while the GitHub
projection is at most 60 seconds old and can fail independently of the page.

## Relationship to other pages

Upstream: Issues mode and the status-bar watchdog indicator. Downstream: the GitHub issue a row
links to. The page leaves no state behind; it only reads `GET /api/watchdog` and polls every 15
seconds.

## User journeys

### Check health and the last outcome

Trigger: the operator suspects the watchdog missed or filed something. Steps: read the sync badge,
then the newest cycle's action and reason, then its findings and pending counts. Decision: is the
last cycle the expected one, and is the GitHub read current? Success: the answer is visible above
the fold. Failure: the sync badge reads `error` and the reason sits under the page header; the
last projection stays intact. Recovery: the next successful read clears the error. Exit: switch
Issues pages or modes.

### Audit the cycle history

Trigger: an unexpected action or reason. Steps: scan the history newest first, compare actions and
findings, read a cycle's window when the timing matters. Decision: was a filing, a duplicate, or a
failure the rule or the exception? Success: the history is aligned in labelled columns and the
newest row matches the summary. Failure: a run directory cannot be parsed, so it is skipped while
the other rows remain. Exit: open a filed issue or leave.

### Review a filed issue

Trigger: a new filed issue appears. Steps: scan the filed-issue table, read the state and shipped
version, follow the title link to GitHub. Decision: is this issue still pending, and which release
shipped the fix? Success: the row answers both and opens the tracker in a new tab. Failure: the
GitHub read failed, so the last known state and version stay and the error is stated. Exit:
return to the page.

## Non-goals

- Starting, stopping, or configuring the watchdog.
- Filing, commenting on, closing, or linking issues from the page.
- Showing run-directory contents, logs, or fingerprints.
- Replacing the status-bar indicator or its popover.

## Assumptions

- The operator reads absolute clock times in local time; the ISO value stays in the element for
  tooltips and tests.
- A 100-row history is an audit trail, not a live feed; it may scroll inside its own panel.
- The viewport is at least 1024×720; narrow layouts stack the two tables.

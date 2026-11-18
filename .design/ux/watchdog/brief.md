# Watchdog page — brief

Status: describes the shipped surface (retargeted by issue #2102). The Watchdog has no page
component of its own: the Devboard-mode background-agent page (`AgentPage.svelte`) renders it for
the `watchdog` family, and the status bar's watchdog indicator is its always-visible companion.
The retired `.watchdog-page` / `.watchdog-body` layout, its Issues-mode route, and its REST read do
not exist and this packet specifies none of them.

## Page identity

- Route: Devboard mode (`Alt+5`) → sidebar `Background agents` → `Watchdog`
  (`data-command="open.devboard.watchdog"`, `data-testid="open-devboard-watchdog"`).
  `DevboardWorkspace.svelte` renders `AgentPage agentId="watchdog"` in the mode's tab panel; the
  workspace tab carries the descriptor's `watchdog` id and kind, and no URL route names the page.
- Title: `Watchdog`, the descriptor's label, as the page's only `h1`. Subtitle: the descriptor's
  description, `Watches dashboard evidence and files significant machine findings as issues.`
- Data: the family's agent snapshot, pushed by the server over the dashboard WebSocket
  (`agentsState` carrying every family, and `agentState` for one). The snapshot carries the
  retained cycles, the filed-issue rows, pending filings, lifecycle, workers, cadence, and the
  forge read. There is no watchdog page endpoint: opening the page sends one `refreshAgent`
  command, and the server reads the tracker on its own 60-second cadence.
- Auth/role: local operator. Start and Stop are the shared activity bar's one lifecycle control; the
  page itself files, comments, closes, starts, stops, and fixes nothing.

## Primary goal

Decide whether the Watchdog is healthy and what its last cycle did. Observable success: the forge
read state and its last read, the newest cycle's action and age, the retained cycle history, and
every filed issue with its tracker state and shipped version are readable without opening a run
directory.

## Secondary goals

- Audit the retained cycles: which found nothing, which filed, which failed, and which issues each
  one produced.
- Review the filed issues with their category, filed time, state, and shipped version, and reach
  the tracker in one click.
- Adjust the family's cadence and filing limits without leaving the page.

These support the primary goal and do not compete with it.

## Arrival context

The operator arrives from the Devboard sidebar, usually after automation feels wrong (nothing
filed, a stalled cycle, a rate-limit alert) or before trusting the family. They know the repository
and the mode but not the newest action. The dashboard is local, so latency is low; the tracker
projection is at most 60 seconds old and can fail independently of the page. The status-bar
indicator is reachable from every mode, so the page is the deliberate stop and the indicator is the
glance.

## Relationship to other pages

Upstream: the status-bar watchdog indicator, whose popover states the newest cycle and every filed
issue, and the Devboard sidebar's `Background agents` group. Downstream: each issue link opens the
tracker in a new tab. The page persists nothing of its own; its settings are the family's persisted
cadence and filing limits. The prompt disclosure stays because every agent page carries it, and it
states that the Watchdog runs no agent.

## User journeys

1. **Routine health check.** Open the page. Read the header's forge-read badge and `Last read`,
   then the activity bar's newest line and state dot. Success: the badge reads `ok`, the last read
   is minutes old, and the newest line states the action, window, and finding count. Failure: the
   badge reads `stale` or `error` and the alert under the header carries the reason. Recovery: the
   next successful read clears the alert in place.
2. **Audit the cycle history.** Expand the activity bar. The retained cycles read oldest first with
   the newest at the bottom, and the log follows the newest line while the operator stays at the
   bottom. Success: one line per cycle with start, action, window, finding count, reason, and the
   issues it filed. Failure: the log is empty, and the bar reads `No activity yet.`
3. **Review a filed issue.** Scan the filed-issues table, read the state badge and the shipped
   version, and follow the title to the tracker. Success: the row answers whether the issue is
   still pending and which release shipped it. Failure: the read is not fresh, so the surviving
   rows carry one notice naming the last read.
4. **Glance from another mode.** Read `watchdog <action> · <age>` in the status bar, open the
   popover for the newest cycle's ISO start, finding and pending counts, its reason, and the filed
   issues, then press Escape or click the trigger again. The popover states no route.
5. **Change cadence or limits.** Use the header footer: `Every` (1–1440 minutes, default 10),
   `Per hour`, and `Open issues` (empty means unlimited; 1–100 otherwise). Success: the save
   feedback confirms and the clocks update. Failure: a refusal renders beside the group that owns
   the invalid field.

## Non-goals

- A dedicated page shell, a section element, a route id, or a REST read for the Watchdog. The
  shipped facts arrive only in the pushed agent snapshot.
- A newest-cycle panel, a two-column body, or a cycle-history table beside the filed issues; the
  shared page is one column and the bar's log carries the history.
- Filing, commenting, closing, starting, stopping, or fixing anything from the page beyond the
  shared Start/Stop control.
- Replacing the status-bar indicator or its popover.
- Showing run-directory contents, logs, fingerprints, or a per-cycle detail view.

## Assumptions

- One cycle every ten minutes by default; the cadence accepts 1 through 1440 minutes.
- The server reads the tracker every 60 seconds. A successful read of a table with known rows
  older than 120 seconds reads `stale`; an answered empty table keeps its `ok` state, and a
  failed read reads `error` with its reason.
- The server retains 100 cycles; the activity log lists them oldest first and the newest last.
- A snapshot arrives only when the server pushes one; opening the page asks for one fresh refresh.
- The supported viewport floor is 1024×720; below it the shell replaces the workspace with the
  viewport guard.

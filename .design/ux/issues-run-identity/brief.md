# Issues agent focus — brief

## Page identity

- Route: Issues mode → agent tab `agent:<runId>` (the workspace tab opened from an Agents card).
- Title: `#<issue> <title>` in the page header; the panel under review is the run output panel.
- Auth/role: local operator; no role gate.
- Entry points: an Agents card's `Focus` control, a restored tab after reload, and the command
  palette's tab switch.

## Primary goal

Read one agent run's output and answer its pending question without losing the run's identity.
Observable success: the operator can name the run being read, correlate it with the Agents card
and the Runs history, and answer its question; the run keeps streaming while the tab is open.

## Secondary goals

- Distinguish a live run from a finished run restored from history.
- Reach the run's question and send an answer without leaving the tab.
- Close the tab back to the Agents page.

These support the primary goal and do not compete with it.

## Arrival context

The operator has chosen one agent from many. They know the issue number and title, not the run id.
They arrive to inspect progress or to answer a question; the run may finish or disappear while the
tab is open. The viewport is desktop (1024×720 or wider); the dashboard is local, so latency is
low but the socket can reconnect.

## Relationship to other pages

Upstream: Agents page cards and restored tabs. Downstream: Runs history when the run is no longer
available. The tab leaves no state behind except the answer it sends; the run itself is owned by
the server and is not stopped by leaving.

## User journeys

### Monitor a live run

Trigger: a card shows a running agent. Steps: activate `Focus`, read the page header status, read
the run identity, follow the activity log. Decision point: is the output still moving? Success:
the log advances and the status stays `running`. Failure: the socket drops — the connection state
in the status bar carries the failure message and the log stops advancing. Recovery: reconnect
replays the activity in the tab. Exit: close the tab.

### Identify the run

Trigger: the operator must correlate the tab with a card or a run directory. Steps: read the run
identity in the output panel header, compare it to the card's run id, or use the tooltip to copy
the full identifier. Decision point: is this the run I think it is? Success: the identifier is
visible and unambiguous. Failure: the identifier is clipped — the tooltip still carries the full
value. Exit: continue reading or switch tabs.

### Answer the agent's question

Trigger: a question appears in the tab. Steps: read the question, choose an option or type an
answer, submit. Success: the question clears for this run only. Failure: the run ended first —
answering is refused and the error reaches this peer. Recovery: the run history keeps the final
state. Exit: close the tab.

### Inspect a finished run

Trigger: a restored tab whose run has ended. Steps: read the final status from the page header and
the identity with its elapsed start time, read the final activity. Success: the tab states the run
is finished and shows history. Failure: the run was pruned — the no-longer-available panel links to
Runs. Exit: close the tab.

## Non-goals

- Starting, stopping, or pausing the worker from this tab.
- Editing the issue or the run record.
- Showing every running agent's output in this tab.
- Giving the run id an operational meaning beyond correlation.

## Assumptions

- The panel header is the only place the tab states which run it belongs to. Inferred from the
  current component: the page header names the issue, not the run.
- The operator recognizes ISO run ids as identifiers; a label or chip is enough context.

# Brief — Discover / Run header

Issue #272 selects the header of the active Discover run panel:
`#workspace-discover > div.mode-body.discover-body > div.scroll-column.discover-page >
section.panel.discover-run:nth-of-type(2) > div.panel__header.discover-run__header`.

## Surface identity

- Route: Discover mode → Overview (`#workspace-discover`), the `Run in progress` panel.
- Entry points: starting a Discover run from the page header or from the command palette; a run
  started elsewhere stays visible here because the server owns it.
- Audience: one repository operator watching a long-running inventory of the host repository.

## Primary goal

Know that a Discover run is active and be able to stop it. Success: the header states the run
state and offers one working Stop control, while the activity terminal below is the place to
judge progress.

## Secondary goals

- See how long it has been running without opening a log.

## Arrival context

The operator started the run seconds or minutes ago and may return from another mode or another
browser tab. The run continues on the server, so the panel can appear already running. Desktop
console at a 1024×720 minimum; the app replaces the workspace below that guard.

## Relationship to other pages

The Discover page header owns starting a run and the project identity. This panel appears only
while a run is active. Published artifacts replace it on a later page load. The activity terminal
inside the same panel owns progress detail.

## User journeys

1. **Confirm the run is alive.** Trigger: the panel appears. Steps: read the header state, glance
   at the terminal. Success: one unambiguous state word plus a growing activity log.
2. **Stop the run.** Trigger: the run is wrong or no longer needed. Steps: find the Stop control,
   activate it. Success: the run stops; failure is reported by the page's existing notification
   region, not by a second header message.
3. **Judge elapsed time.** Trigger: the run feels stalled. Steps: read the start time. Success: a
   relative age that updates while the panel is open, with the exact start clock in its tooltip.

## Failure routes

- **Stop refused or the socket is down** — the existing notification path reports it; the header
  keeps its last known state.
- **Missing start time** — the header omits the meta item and keeps the state and Stop; no empty
  placeholder is rendered.

## Non-goals

- Progress percentage, stage list, or log summarisation; the terminal owns the run detail.
- Starting a second run from this panel; the page header owns the start control.
- A confirmation dialog before Stop; the run is a read-only crawl and the control stays a single
  step, as shipped.

## Assumptions

- The panel exists only while a run is active, so no idle, completed, or queued header state is
  designed here. `discover.active` gates the section in `DiscoverOverview.svelte`.

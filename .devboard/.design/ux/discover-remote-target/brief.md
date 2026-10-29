# Discover remote target — brief

Slug: `discover-remote-target`. Scope: the body of
`#workspace-discover section.panel.discover-remote` on the Discover Overview, plus its panel
header and footer. Design artifacts live under `.devboard/.design/` per the harness convention;
the interface is the harness's own UI.

## Page identity

- Route: Discover mode → Overview (`/`, `data-tab="overview"`).
- Region: the first region of the Discover Overview, above the project header.
- Availability: source checkout only (`discover.remoteAvailable`); an installed host renders no
  remote controls.
- Entry points: the Discover rail tab, the sidebar, and the command palette's Overview command.

## Primary goal

Decide which repository Discover reads and writes, and make that target visible before anything
it affects. The observable success signal: the operator switches to a retained project, or names
a new GitHub URL and starts a discovery, without leaving the Overview.

## Secondary goals

- Remove one retained project without touching the others.
- Return to this checkout's own artifacts while keeping every retained project.
- Recognise the active retained project at a glance instead of inferring it from the dropdown.

## Arrival context

The operator runs the interface from the harness source checkout and has discovered at least one
remote project earlier; the server replayed the retained list and active target on connect. They
carry the repository identity in the page header and expect the target strip to be the first thing
they read. Desktop viewport, local network.

## Relationship to other regions

- Upstream: the Discover rail and the page header's start control.
- Downstream: the sheet, the skills pages, and the run panel, all of which read the selected
  target's bytes.
- Loops: switching, removing, or clearing changes the target in place; the panel never navigates.

## User journeys

J1 — Switch to a retained project.

- Trigger: the operator wants the artifacts of a repository discovered earlier.
- Steps: open the dropdown; choose the URL.
- Success: one `switchDiscoverRemote` frame, the row takes the active treatment, and the page
  renders the retained bytes with no clone or crawl.
- Failure: the active project is not identifiable in the list, so the operator cannot tell which
  project the sheet belongs to.

J2 — Add a remote project.

- Trigger: the operator needs to read a repository that has never been retained.
- Steps: read the `Discover another repository` label, type the URL, submit.
- Success: one `discoverRemote` frame with the trimmed URL; while cloning, the panel names the URL.
- Failure: the submit control reads as part of the switch control, so the operator changes the
  target instead of adding one.

J3 — Remove one retained project.

- Trigger: a retained project is stale or unwanted.
- Steps: scan the rows; press that row's `Remove`.
- Success: one `removeDiscoverRemote`; only that directory and row disappear.
- Failure: the remove control is too quiet to find, or it looks like the destructive action for
  the whole panel.

J4 — Return to the host target.

- Trigger: the operator wants to continue with this checkout's artifacts.
- Steps: press `Clear remote target`.
- Success: one `clearDiscoverRemote`; every retained project and its bytes remain.
- Failure: the control sits inside the add form and reads as a second submit, or it is mistaken
  for a deletion.

## Non-goals

- The wire contract, persistence, and discovery pipeline; they are unchanged.
- A host entry in the dropdown; the host target is the absence of a selection.
- A filled primary; the page header keeps the only one.
- Sorting, filtering, or renaming retained projects.

## Assumptions

- Retained projects arrive newest first; the dropdown order and row order match.
- The active target is either one retained URL or the host; the dropdown has no host option.
- The fixed test hooks (`discover-remote-select`, `discover-remote-remove`,
  `discover-remote-url`, `discover-remote-start`, `discover-remote-clear`) stay in place.
- The supported viewport is at least 1024×720; below that the viewport guard replaces the
  workspace.

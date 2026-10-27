# Flow goal header — UX brief

## Identity
- Route: `/` → Flow mode → Overview (`#workspace-flow`).
- Title: `Flow goal`.
- Auth/role: local operator of one repository; no roles or remote accounts.
- Entry points: Flow mode tab, the Flow sidebar's Overview entry, and the command
  palette's `open.flow.overview`.

## Goal
- Primary goal: decide whether the Flow session goal is ready and act on it — create
  it through the interview, or save a changed draft.
- Success signal: the header states the current draft state, and the required action
  (create/recreate or save) is available without inspecting the editor contents.
- Secondary goals: start a goal interview when none exists; keep the editor the
  largest surface.

## Arrival context
- What the user knows: the Flow session exists or is being prepared; the goal is the
  text the implementation agent works from.
- What they carry in: an intent to write, replace, or confirm the goal.
- Prior page/state: the overview opens with no goal, a saved goal, an unsaved draft,
  or a running interview.
- Device/network assumptions: desktop browser at 1024×720 or wider; local WebSocket.
- Urgency: medium; the goal blocks starting implementation.

## Relationship to other pages
- Upstream: Flow overview and sidebar.
- Downstream: the goal interview panel and the Session panel, which starts the
  implementation only after a goal exists.
- Loops: create → interview → goal returned → edit → save.
- State left behind: the saved goal is session state; the unsaved draft lives in the
  mounted editor until saved or discarded.

## Journeys

### Journey 1 — Create a goal from empty
- Trigger: the overview opens with no goal.
- Steps: read the state, choose `Create flow goal`, answer the interview, review the
  returned text, edit if needed, save.
- Decision points: create now versus write later.
- Success: the state becomes saved and the editor holds the generated goal.
- Failure routes: the interview fails or writes nothing; the header must not claim a
  goal exists.
- Recovery: retry create; the editor remains empty and save stays unavailable.
- Exit: the developer moves to the Session panel.

### Journey 2 — Save an edited draft
- Trigger: the developer changes the goal text.
- Steps: read the unsaved state, review the draft, choose `Save`.
- Decision points: save versus discard by leaving the draft.
- Success: the state returns to saved and Save is unavailable.
- Failure routes: save fails; the state must not silently report saved without the
  server confirmation path already implemented by the client.
- Recovery: keep the draft and retry.
- Exit: the developer starts implementation.

### Journey 3 — Replace a saved goal
- Trigger: a saved goal exists but is wrong.
- Steps: choose `Recreate flow goal`, complete the interview, review, save.
- Decision points: replace versus edit the existing text.
- Success: the new goal replaces the old one.
- Failure routes: the interview fails; the old goal stays intact.
- Recovery: retry recreate or edit the existing text.
- Exit: back to the session.

## Non-goals
- Choosing the goal's content or editing the editor.
- Session status, branch, PR, widgets, files, checkpoints, and blockers.
- The interview transcript and its question controls.
- Navigation and command discovery.

## Assumptions
- The header is the only place that states goal draft state; the editor carries the
  goal text itself.
- The Flow session's saved goal is the source of truth for the saved state.

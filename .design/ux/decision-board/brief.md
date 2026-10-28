# Decision board — UX brief

## Identity
- Route: `/` → Flow mode → Decision board (`#workspace-flow`, sidebar `Decision board`).
- Title: `Decision board`.
- Auth/role: local operator of one repository; no roles or remote accounts.
- Entry points: the Flow sidebar's `Decision board` entry and the command palette's
  `open.flow.decisions`.

## Goal
- Primary goal: record the implementation decisions the agent must follow, then persist them.
- Success signal: the header states whether the draft differs from the saved board, and Save is
  available exactly when it does.
- Secondary goals: read the saved board without editing; resume an interrupted draft.

## Arrival context
- What the user knows: the Flow session exists and its implementation reads this board.
- What they carry in: a decision to write down or a saved board to review.
- Prior page/state: the board opens empty, saved, or with an unsaved draft from earlier editing.
- Device/network assumptions: desktop browser at 1024×720 or wider; local WebSocket.
- Urgency: medium; the decisions steer the running or upcoming implementation.

## Relationship to other pages
- Upstream: Flow sidebar and command palette.
- Downstream: the implementation agent reads the saved board at its next checkpoint.
- Loops: edit → save → agent reads → edit again.
- State left behind: the saved markdown persists in the session; an unsaved draft lives only in
  the mounted editor until saved or discarded.

## Journeys

### Journey 1 — Write the first decisions
- Trigger: the board opens empty.
- Steps: read the empty state, write markdown in the editor, choose `Save`.
- Decision points: save now versus keep drafting.
- Success: the state becomes saved and Save becomes unavailable.
- Failure routes: the save request fails; the header must not report saved.
- Recovery: keep the draft and retry.
- Exit: the developer moves to another Flow surface; the agent reads the board.

### Journey 2 — Revise a saved board
- Trigger: a saved board exists and needs a new decision.
- Steps: edit the text, read the unsaved state, choose `Save`.
- Decision points: persist or leave the draft.
- Success: the state returns to saved; the editor text matches the server copy.
- Failure routes: the save fails or the connection drops; the dirty state stays visible.
- Recovery: retry Save; the draft is not discarded.
- Exit: back to steering or history.

### Journey 3 — Read without changing
- Trigger: the developer opens the board to check what was decided.
- Steps: read the text; do not edit.
- Decision points: none.
- Success: Save stays unavailable and the header reports saved.
- Failure routes: the board cannot be read; the Flow notice region owns the error.
- Recovery: reopen the surface.
- Exit: leave the surface.

## Non-goals
- Choosing what a decision should say.
- Reading decisions back to the implementation agent.
- Steering notes, history, checkpoints, blockers, and session status.
- Navigation and command discovery.

## Assumptions
- The saved board is the source of truth for the `saved` state; the editor text alone cannot
  distinguish a saved board from an unsaved one.
- The Flow notice region owns server errors, so the header never invents an error state.

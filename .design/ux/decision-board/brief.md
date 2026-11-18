# Decision board — UX brief

## Identity
- Route: `/` → Flow mode → Decision board (`#workspace-flow`, sidebar `Decision board`).
- Title: `Decision board`.
- Auth/role: local operator of one repository; no roles or remote accounts.
- Entry points: the Flow sidebar's `Decision board` entry and the command palette's
  `open.flow.decisions`.

## Goal
- Primary goal: read the implementation decisions the agent must follow.
- Success signal: the developer can read the stored board, or the surface states that no
  decisions exist yet, and can tell a settled board from a session that is still restoring.
- Secondary goals: confirm that the board is empty; resume reading once an interrupted session
  finishes restoring.

## Arrival context
- What the user knows: the Flow session exists and its implementation reads this board.
- What they carry in: a saved board to review, or the question of whether any decisions exist.
- Prior page/state: the board opens saved, empty, or restoring.
- Device/network assumptions: desktop browser at 1024×720 or wider; local WebSocket.
- Urgency: medium; the decisions steer the running or upcoming implementation.

## Relationship to other pages
- Upstream: Flow sidebar and command palette.
- Downstream: the implementation agent reads the saved board at its next checkpoint.
- Loops: the Flow session writes decisions → the developer reads them → the agent reads them
  again at its next checkpoint.
- State left behind: nothing. The board is read-only; the stored markdown lives with the Flow
  session, and no draft is held in the page.

## Journeys

### Journey 1 — Read the decisions the agent follows
- Trigger: the developer opens the board to check what was decided.
- Steps: read the board text; leave the surface.
- Decision points: none.
- Success: the text matches the stored board and the header reports saved.
- Failure routes: the board cannot be read; the Flow notice region owns the error.
- Recovery: reopen the surface.
- Exit: back to steering, history, or the implementation view.

### Journey 2 — Confirm there is no board yet
- Trigger: a Flow session exists with no decisions written.
- Steps: open the board; read that no decisions exist.
- Decision points: stay to start the implementation, or leave to create the goal.
- Success: the header reports no decisions yet and the body is empty.
- Failure routes: the session read fails; the Flow notice region owns the error.
- Recovery: reopen the surface after the connection returns.
- Exit: leave the surface.

### Journey 3 — Open the board while a stored session restores
- Trigger: the dashboard reconnects to a stored Flow session and the restore is still running.
- Steps: open the board; read the restore notice; wait for the restore to land.
- Decision points: wait, or leave and return later.
- Success: the notice is replaced by the settled board, saved or empty.
- Failure routes: the restore never lands; the Flow notice region reports the server error.
- Recovery: reopen the surface after the reconnect or the server recovers.
- Exit: read the settled board, or leave the surface.

## Non-goals
- Writing or editing decisions.
- Choosing what a decision should say.
- Draft, save, discard, and dirty-state semantics.
- Steering notes, history, checkpoints, blockers, and session status.
- Navigation and command discovery.

## Assumptions
- Decisions are written by the Flow session, not typed into this page; the page only reads them.
- A restore frame carries an empty board on purpose, so the restoring state is not an empty
  board.
- The Flow notice region owns server errors, so the header never invents an error state.

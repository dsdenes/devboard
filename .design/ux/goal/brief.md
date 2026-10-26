# Goal mode — UX brief

## Identity

- Route: `/` with no URL segment. Goal is one client-only mode of the single-page devboard shell;
  `localStorage` `devboard.layout.v1` restores it as the active mode and the open page.
- Title: the document title is the host repository path (`<title>` from `connection.projectPath`).
  Inside the mode the visible identity is the mode name plus the page name.
- Auth/role: local developer or operator with access to the running dashboard. There is no
  account, role, or permission model in the interface; the server refuses work by run state, not
  by identity.
- Entry points: mode rail `Goal` (`data-testid="mode-goal"`, Alt+1), command palette
  `Switch to Goal`, a restored layout, or a Goal `data-command` from the palette.

## Primary goal

Turn a written goal into executed decisions. The primary job is to run the implementation
lifecycle and keep it moving: start it, see the stage it is in, answer the agent when it asks,
resolve a decision record by hand when the operator wants to drive one, and read what the agent is
doing.

Observable success signal: the lifecycle reaches `finished` (or every ADR is resolved and the
generated epics are implemented); each queued question was answered once; the goal document holds
the text the operator last saved; every started lane ends `closed` or is explicitly stopped.

## Secondary goals

- Correct the goal: edit and save it, or revise it with guidance while no work runs.
- Prepare the skills the implementation agents read.
- Inspect one ADR or one lane in depth without losing the run.
- Recover from a bad state: stop work, pause and resume, or reset the implementation deliberately.

## Arrival context

- What the user knows: they are in a host checkout served by devboard, and the host has a
  `GOAL.md`, a set of ADRs, and possibly prepared skills. They may have just read the goal or just
  returned from Discover.
- What they carry in: the current `GOAL.md`, whichever ADRs exist, prepared or absent skills, and
  possibly a running or paused lifecycle, an active lane, or a queued question.
- Prior state: any mode or any Goal page. Switching modes or pages never starts work and never
  writes.
- Device/network assumptions: desktop browser at least 1024×720, local WebSocket, no mobile
  layout. Agents stream activity through that socket and can be slow.
- Urgency: high while a lifecycle waits on an answer; low while reading records. A queued
  question blocks the run, so it must be reachable from wherever the operator is.

## Relationship to other pages

- Upstream: Discover mode publishes the skills that Goal's prepare step consumes; Flow mode and
  Discover mode hold the single work slot, so a Goal run is refused while either runs.
- Downstream: implementation agents read `GOAL.md`, the ADRs, and `.omp/skills/`; the ADR decisions
  drive the generated epics and their code changes.
- Loops: an ADR that the lifecycle cannot settle becomes a question; an implementation that fails
  is retried as a new lane attempt; resetting the implementation deletes the work and returns the
  lifecycle to `goal`.
- State left behind: `GOAL.md`, `adrs/` records, `.omp/skills/`, the persisted lifecycle pass and
  stage, lane history, and the selected Goal page.

## User journeys

### Journey 1 — write the first goal

- Trigger: a host whose `GOAL.md` is empty and whose skills are not prepared.
- Steps: open Goal, open the Goal document, click `Create goal`, answer any questions, wait for the
  agent, read the written text, click `Save goal`.
- Decision points: whether to accept the generated text; whether to edit it before saving; whether
  to answer a question with a suggested option or free text.
- Success: `GOAL.md` holds the saved text, the document shows a saved state, and the skills action
  becomes available.
- Failure routes: the agent asks a question and waits; the agent fails and the previous text
  remains editable; the socket closes mid-run and the page states the disconnection.
- Recovery: answer the question, re-run creation, or type the text by hand and save.
- Exit: the Goal document, the skills page, or another mode.

### Journey 2 — prepare the skills

- Trigger: a saved goal with no prepared skills.
- Steps: open Goal, open Skills, click `Prepare skills`, watch activity, read the prepared list and
  any contradiction.
- Decision points: whether to re-prepare after changing the goal or Discover artifacts; whether a
  contradiction must be resolved in another mode.
- Success: the skills list is non-empty and the implementation start control becomes enabled.
- Failure routes: preparation is refused while another run owns the work slot; the agent fails and
  the previous skills stay in place; contradictions are listed with both directives.
- Recovery: finish or stop the other work, then prepare again.
- Exit: the implementation page or the Goal document.

### Journey 3 — revise the saved goal

- Trigger: the goal is wrong, incomplete, or stale after a design change.
- Steps: open the Goal document, type optional revision guidance, click `Revise goal`, answer any
  question, read the revised text, save it.
- Decision points: whether to revise with the agent or edit by hand; whether the revision is worth
  stopping the lifecycle for.
- Success: the document shows the revised text, saved, with the lifecycle still consistent.
- Failure routes: revision is refused while the lifecycle is running unpaused; the agent fails and
  the previous goal text is unchanged; unsaved hand edits would be replaced, so the save state is
  visible before revising.
- Recovery: pause or stop the lifecycle, then revise; or discard the draft.
- Exit: the implementation page.

### Journey 4 — run the lifecycle

- Trigger: a saved goal and prepared skills.
- Steps: open the implementation page, click `Start implementation`, watch the stage track advance,
  follow the activity log, answer questions as they appear.
- Decision points: whether to pause and inspect; whether to answer a question or stop the run;
  whether a failing lane should be retried by the lifecycle or taken over by hand.
- Success: the stage track reaches `finished`; open epics and running lanes return to zero; the
  activity log names the last action.
- Failure routes: start is refused with a named reason (no goal, no skills, another run active);
  the socket drops and the page says so; the lifecycle stops on failure and the last action stays
  readable.
- Recovery: fix the named precondition, resume a paused lifecycle, or resolve the failing ADR
  manually.
- Exit: the finished state, an ADR, or a lane.

### Journey 5 — pause and resume

- Trigger: the operator needs to inspect or edit while the lifecycle runs.
- Steps: open the implementation page, click `Pause`, read the paused stage, use the ADR or lane
  pages, click `Resume`.
- Decision points: whether pausing is enough or the run must stop.
- Success: the stage shows paused, editing the goal becomes available, and resume continues the
  same pass.
- Failure routes: resume is refused when the lifecycle is not paused; a queued question stays
  visible while paused.
- Recovery: resume, or stop and restart.
- Exit: the paused or resumed implementation page.

### Journey 6 — answer a queued question

- Trigger: an agent asks a question during goal creation, revision, skills preparation, a manual
  ADR run, or the lifecycle.
- Steps: read the message, choose a suggested option or type an answer, submit once.
- Decision points: which option matches intent; whether the question belongs to the lifecycle or a
  single lane.
- Success: the answer is sent once, the question disappears, and the run continues.
- Failure routes: an empty answer cannot be submitted; a stale or duplicate answer is refused with
  one error; the question may be withdrawn by the agent.
- Recovery: answer again when a new question arrives.
- Exit: wherever the operator was.

### Journey 7 — resolve one ADR manually

- Trigger: the operator wants to drive a single decision instead of the whole lifecycle.
- Steps: open ADRs, find the next record, click `Start`, follow the activity, answer questions,
  return to the list.
- Decision points: which record to start; whether the next record is the right one.
- Success: the record becomes resolved, the next marker moves, and the lane closes.
- Failure routes: start is refused while another run is active; the run fails and the record stays
  pending with the failure in the activity log.
- Recovery: read the log, start the record again, or use the lifecycle.
- Exit: the ADR list or another record.

### Journey 8 — inspect one lane

- Trigger: a lane is running, failed, retrying, or parked, and the operator needs its detail.
- Steps: open Lanes in the sidebar, open one lane, read its identity, status, attempt, activity,
  and question, answer if asked.
- Decision points: whether the lane needs an answer or a new attempt; whether its epic link must be
  opened.
- Success: the lane's current action and history are readable and its question was answered once.
- Failure routes: the lane closes while open and the page says it is no longer active; a stale
  answer is refused.
- Recovery: return to the list and open the new attempt.
- Exit: the list or another lane.

### Journey 9 — stop the lifecycle

- Trigger: the run is wrong, stuck, or no longer relevant.
- Steps: open the implementation page, click `Stop implementation`.
- Decision points: whether stopping loses useful work; the control must say what stopping does.
- Success: the lifecycle leaves the active stage, the active lane ends, and the start control
  returns with its preconditions restated.
- Failure routes: stop while the socket is closed is refused; a partially written record stays as
  it is.
- Recovery: reconnect and stop again, or reset the implementation.
- Exit: the implementation page.

### Journey 10 — reset the implementation

- Trigger: the operator wants a clean implementation slate while keeping the goal, the ADRs, the
  skills, and the harness.
- Steps: open the implementation page, reveal the danger zone, read what is kept and what is
  deleted, click `Reset implementation`, confirm.
- Decision points: whether the loss is acceptable; whether the reset is armed by intent.
- Success: the working tree keeps `.devboard`, `.omp`, `AGENTS.md`, `.gitignore`, `GOAL.md`,
  `.git`, and `.worktree`; everything else is deleted and a commit is reported.
- Failure routes: the reset is refused while the socket is closed; a failed reset reports the
  failure and keeps the state readable.
- Recovery: use git to restore what was lost; reset again after the cause is fixed.
- Exit: the implementation page or another mode.

### Journey 11 — read the ADR set

- Trigger: the operator needs the decision landscape, or which record is next.
- Steps: open ADRs, read the progress line, filter to pending, scan titles, open one record.
- Decision points: whether the set is complete; which record is blocking the lifecycle.
- Success: every record is listed with its document status and implementation state, and the next
  record is marked.
- Failure routes: no records shows an empty state that says how records arrive; a filter with no
  match shows a reset action.
- Recovery: clear the filter.
- Exit: one record or the implementation page.

### Journey 12 — inspect one decision record

- Trigger: the operator needs the full decision text or wants to start that record.
- Steps: open a record from the list, the sidebar, or the palette; read status, next marker, file,
  summary; click `Start` when it is pending.
- Decision points: whether the record is the next one; whether to resolve it now.
- Success: the record's identity and summary are visible once, and its start control starts that
  record.
- Failure routes: the record disappears from the set and the page says so; start is disabled with a
  reason.
- Recovery: return to the list.
- Exit: the list or the run.

### Journey 13 — recover from an interruption

- Trigger: the socket closes, the dashboard restarts, or an upgrade is waiting.
- Steps: read the notice, wait for reconnection, confirm the stage and the last action.
- Decision points: whether the run survived or must be restarted.
- Success: after reconnection the stage, records, and last activity match the server again.
- Failure routes: the server reports a failed reset or a stopped run after restart; a pending
  upgrade restarts the dashboard when work ends.
- Recovery: restart the run or reset the implementation.
- Exit: the implementation page.

## Non-goals

- Editing ADR files in the browser; records are read and started, never rewritten.
- Editing prepared skills in Goal mode; skills are files under `.omp/skills/` and Discover owns
  their review surface.
- Running two things at once; the server allows one work slot shared by Goal, Flow, and Discover.
- Choosing a branch, a remote, credentials, or a model.
- A mobile layout below 1024×720.
- Undoing a completed lifecycle pass.

## Assumptions

- The lifecycle automates epics and their ADR-driven implementation; a manual run resolves exactly
  one record. This brief treats both as supported paths because both controls ship.
- `openEpics` counts generated epics that are not closed upstream; the interface cannot refresh it
  itself.
- Skills are read from `.omp/skills/`; contradictions are detected by the server and are advisory.
- `lifecycleSeen` is false until the server reports a stage other than `goal`, so a fresh host has no
  lifecycle on screen.
- The status bar owns ambient connection, project, mode, and version facts; a page repeats one of
  them only when the action requires it.

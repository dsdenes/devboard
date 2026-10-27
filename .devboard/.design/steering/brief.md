# Brief — Flow / Steering

## Page identity

- Route: Flow mode → Steering tab (`#workspace-flow`, `tab.kind === "steering"`).
- Entry points: sidebar `Steering` with its note count, the command palette's
  `Focus Flow steering`, and the restored tab after reload.
- Audience: the repository operator supervising a running Flow implementation.
- Surface: one panel in the workspace's scroll column, not a full page.

## Primary goal

Redirect a running implementation without stopping it, and know whether the agent has consumed the
note. Success is: the note leaves the composer on submit, appears in the log marked `new`, and the
header states that notes are waiting until the next checkpoint.

## Secondary goals

- Review the steering history of the current session in order.
- Understand when the agent reads a new note before writing one.

## Arrival context

The operator arrives mid-run, usually because the implementation is drifting or a decision needs
correcting. They know the goal and the visible work; they do not know checkpoint timing. The panel
may be empty on a fresh session or hold notes from earlier in the run. The interface is a desktop
operator console with a 1024×720 floor.

## Relationship to other pages

The sidebar owns the total note count. Overview and the implementation activity panel show the
running agent; this tab is the only place a steering note is written. The decision board is a
separate document with its own tab.

## User journeys

1. **Send a note.** Trigger: the implementation needs a correction. Steps: read the header to
   confirm read timing, type into the composer, see `Send` enable, submit. Success: the draft
   clears, the note appears as `new`, and the header switches to waiting. Failure: no Flow session
   exists, so the server refuses the note; the error notification stays visible and the operator
   can retype. Recovery: retype and resend once a session exists.
2. **Review the notes.** Trigger: returning to the tab. Steps: scan each row's text, source,
   timestamp, and status; read the header summary. Success: everyone knows whether the agent still
   has unread direction. Failure: nothing pending; the header says all notes were read.
3. **Understand an empty panel.** Trigger: first visit. Steps: read the empty state and the header
   line. Success: the operator knows a note is read at the next checkpoint, so no note is sent
   twice.

## Failure routes

- No session: the server rejects the note with a notification; the panel keeps its empty state.
- Empty draft or whitespace: `Send` stays disabled; no empty note can be submitted.
- Long note: the textarea scrolls; the log row wraps inside the panel.
- Many notes: the panel body scrolls; the header and composer stay at the top of the panel.
- Stale note state: the server owns `new`/`read`; the panel never infers a read.

## Non-goals

- Editing or deleting an existing note.
- Live conversation with the agent (the widget conversation owns that).
- Replacing or saving the decision board.

## Assumptions

- `flow.steering` is session-scoped and append-only.
- The server marks a note `read` from `steering-ack.jsonl`, never from the client.

# Brief — Flow / Decision board header

Issue #261 selects the header of the Decision board panel:
`#workspace-flow > div.flow-mode.mode-body > div.scroll-column > section.panel > div.panel__header:nth-of-type(1)`.

## Surface identity

- Route: Flow mode → `Decision board` workspace tab (`#workspace-flow`).
- Entry points: the Flow sidebar's `Decision board` item, the command palette
  (`open.flow.decisions`), and the `flow.decisions.save` command.
- Audience: one repository operator reading and amending the decisions the implementation agent
  must honor.

## Primary goal

Record a decision in the board and save it. Success: the saved text is what the implementation
reads, and the surface says plainly whether the draft differs from it.

## Secondary goals

- Know before leaving the tab whether the draft is saved.
- Save with the button or the editor's Ctrl/Cmd+S and get the same result.

## Arrival context

The operator already ran or is running an implementation and heard a decision in the interview.
The board is a Markdown editor over a file the agent reads; the operator may arrive with unsaved
edits from an earlier visit because the draft survives tab switches. Dense desktop console at a
1024×720 minimum; never a mobile surface.

## Relationship to other pages

The Flow goal panel states the goal and its interview state. The sidebar repeats the unsaved marker
for navigation while the Decision board is closed. This header owns the saved/draft state of this
one editor.

## User journeys

1. **Read the board.** Trigger: the operator opens the tab. Steps: read the header state, then the
   editor. Success: `Saved` and a disabled Save when the draft matches the stored text.
2. **Amend a decision.** Trigger: a new constraint appears. Steps: type in the editor; the header
   turns to `Unsaved changes` and Save enables; press Save or Ctrl/Cmd+S. Success: the header
   returns to `Saved` and Save disables. Failure: the socket is down; the request fails and the
   connection state reports it.
3. **Start an empty board.** Trigger: no decisions exist. Steps: open the tab. Success:
   `No decisions yet` in muted text and a disabled Save, so the header never claims an empty
   document is "Saved".
4. **Leave with edits.** Trigger: the operator switches tabs. Steps: glance at the header or the
   sidebar marker. Success: the unsaved fact stays visible in the navigation.

## Failure routes

- Empty board: `No decisions yet`, Save disabled.
- Save with no changes: Save is disabled and its tooltip says `No unsaved changes.`
- Long decisions file: the state line never shrinks; the header height stays 30px plus the line.
- Light and dark theme: every color is a token.

## Non-goals

- The editor, its content model, and the save transport are unchanged.
- The Flow goal header's interview controls and the sidebar's navigation marker are unchanged.

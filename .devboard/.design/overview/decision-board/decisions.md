# Decisions — Flow / Decision board header (#261)

## What changed and why

- **The header now states the saved fact.** The shipped header was a bare `Decision board` title
  and a permanently enabled `Save`; nothing said whether the editor matched the stored text. It now
  pairs the panel title with an 11px state line (`Saved` success, `Unsaved changes` warning,
  `No decisions yet` muted), like the Discover skill header's draft line.
- **Save refuses a no-op write.** The primary action is disabled while the draft matches the stored
  text, with `No unsaved changes.` as its tooltip; while dirty it is enabled with `Save the decision
  board.`. Ctrl/Cmd+S in the editor still saves.
- **The two-line identity fits the 30px panel header.** The title's line height is pinned to 1.2
  inside this header so 14.4px + 2px gap + 13.2px state = 29.6px, inside the documented 30px
  header. Measured overflow is −0.4px, so the state line never crosses the header border.
- **Geometry matches the sibling editors.** `align-items: flex-start` and a 12px gap to a
  right-aligned action group, state and actions never shrink, identity absorbs the narrow width.

## What stayed

- The panel, test ids (`flow-decisions-section`, `flow-decisions`, `save-flow-decisions`,
  `flow.decisions.save`), the Monaco editor, its accessible label, dirty marker, Ctrl/Cmd+S, and
  the exact-text save path.
- The sidebar's `unsaved` badge: the navigation region answers "which tab is dirty", the header
  answers "is this board saved".

## Design-system boundary

No token, OpenUI, Storybook, or DTCG change. The header composes the existing panel header and
primary Button and matches the Discover skill header's draft line; `DESIGN.md` gains the component
entry.
Because nothing in the design system itself changed, no designmd mutation receipt was produced.

## Divergences from the wireframe

| Wireframe | Implementation | Why |
|---|---|---|
| Saved state drawn dark gray | `success` token (green) | state color follows the token role; the word carries the meaning |
| Unsaved state drawn brown | `warning` token (amber) | same |
| Save drawn with a plain border | primary fill, 45% while disabled | the shipped Button variant table owns the control |

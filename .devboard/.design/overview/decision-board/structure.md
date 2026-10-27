# Structure — Flow / Decision board header

## Regions

One panel header at the top of the Decision board panel; the editor fills the body below it.

1. **Identity column (left).** `h2` `Decision board` in `panel-title`, with a 2px gap above an
   11px state line: `Saved` (`success`), `Unsaved changes` (`warning`), or `No decisions yet`
   (`muted-foreground`). The column shrinks first and never wraps.
2. **Action group (right).** One primary `Save`, vertically centered against the identity column,
   disabled while the draft matches the stored text. Its `title` explains the disabled state.

There is no third region: no size, count, timestamp, or shortcut hint. The editor below owns the
document.

## States covered

- **Saved** — `Saved` success line, Save disabled, tooltip `No unsaved changes.`
- **Dirty** — `Unsaved changes` warning line, Save enabled, tooltip `Save the decision board.`
- **Empty** — `No decisions yet` muted line, Save disabled (an empty stored board is not an edit).
- **Long content** — the header is content-independent: the state line always occupies one line.
- **Light theme** — all three tones are token roles, no literal colors.
- **Narrow pane** — the identity column absorbs the width; the Save action never shrinks.
- **Save in flight / failed** — the local dirty flag clears on send as before; a failed socket is
  reported by the connection state, not by a second header message.

## Rationale

- C2 (91) leads the header because the surface's job is to make the saved fact unmistakable.
- C3 (82) is the one primary action, right-aligned as on every other editor header.
- C4 (64) is expressed through the control, not through a second word, so the header stays one
  state plus one action.
- The pattern matches the Discover skill header: identity column, 11px state line, right action
  group with 12px gap. The decision board is the third editor surface, so it uses the same
  geometry rather than the lead surface's 44px row.

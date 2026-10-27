# Decisions — Overview / Running agents (#256)

## What changed and why

- **The selected row is the only emphasized surface.** The shipped row used `secondary` for both
  hover and `aria-current`, so the row feeding the output pane was indistinguishable from a pointed
  row. Selection now takes `accent-surface` plus a 2px `accent` edge inside the row's existing 10px
  left padding, and the issue number turns `accent`. Hover keeps `row-hover`. Both state cues are
  token roles already declared for this job (`accent-surface` = selected row tint, `row-hover` =
  hovered row).
- **The close control stopped competing.** A filled `destructive` button on every row put 11 red
  pills in the side column; it buried the titles and read as an error wall. It is now a quiet
  24px word control with a `border-subtle` outline, `muted-foreground` text, and the error tint
  only while hovered or focused. The word `Close` and its `aria-label`/`title` are unchanged, so
  the destructive action stays discoverable and the verification contract holds.
- **The panel header states one new fact.** The plain `11 active` subtitle repeated the
  Automation panel's `Agents 11 running` fact 12px above. It is gone. In its place the header shows
  `<n> need answers` as a warning badge while at least one agent waits — the one aggregate this
  route lacked.
- **Elapsed values line up.** The meta group gained a 40px floor and right alignment with tabular
  numerals, so durations form a column instead of stepping left and right as they widen. The exact
  start clock moved into the value's tooltip; no new text was added.
- **Empty state copy matches the Agents page.** `No issue is running.` became
  `No agents running.`, one sentence inside the panel body's padding.

## What stayed

- Three grid columns, the 44px issue-number column, title ellipsis with the full title in the
  tooltip, the `needs answer` row badge, `data-command`, `data-run`, `data-issue`, `aria-current`,
  clicking to select instead of opening a tab, and the close control's `data-testid="issues-close-issue"`,
  `data-issue`, label, title, and disabled-while-in-flight behavior.
- No inner scroll region: the side column still owns scrolling, so a large fleet never creates a
  second scrollbar inside a panel (same rule as the Discover decision record).

## Design-system boundary

No token, OpenUI, Storybook, or DTCG change. The row and its close control are page CSS using
existing tokens; `DESIGN.md` is updated because it documented the old hover fill and had no entry
for the close control or the header badge. Because nothing in the design system itself changed, no
designmd research receipt was produced; the system's components were reused as they are.

## Divergences from the wireframe

| Wireframe | Implementation | Why |
|---|---|---|
| Selected row edge drawn gray | `accent` edge and `accent-surface` fill | tokens own the color; the wireframe is grayscale |
| `2 need answers` badge at the header's right | same, `warning` tone | tone follows the state token |
| Close control drawn with a plain border | `border-subtle` at rest, `error` on hover/focus | a resting outline keeps the word recognizable as a control |

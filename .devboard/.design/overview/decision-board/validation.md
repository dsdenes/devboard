# Validation — Flow / Decision board header (#261)

## Commands

| Command | Result |
|---|---|
| `cd .devboard && bun install --frozen-lockfile` | pass |
| `cd .devboard && bun run build` | pass; `dist/index.html` and every referenced asset written |
| `cd .devboard && bun run check` | pass; 1672 files, 0 errors, 0 warnings |
| `cd .devboard && bun test` | pass; 600 tests, 0 fail, 4148 assertions (final integrated run; 581/4074 before the follow-up scout merge) |
| `cd .devboard && bun run verify:interface` | pass, including the new saved/dirty header assertions |

## Live surface

A fixture dashboard served the worktree's `dist` with the verification fixture's seeded Flow
session (`STATE_DIR` under `.devboard/.tmp/verify-interface-*/host`), exercised with the OMP
browser tool at 2101×1017 and 1024×720.

| State | Viewport | Result | Evidence |
|---|---|---|---|
| saved, dark | 2101×1017 | pass | `.devboard/.tmp/visual/after-saved-dark.png`, `after-saved-dark-page.png` |
| dirty, dark | 2101×1017 | pass | `.devboard/.tmp/visual/after-dirty-dark.png` |
| keyboard focus on Save, dirty | 2101×1017 | pass | `.devboard/.tmp/visual/after-focus-dirty-dark.png` |
| empty, dark | 2101×1017 | pass | `.devboard/.tmp/visual/after-empty-dark.png` |
| saved, light | 2101×1017 | pass | `.devboard/.tmp/visual/after-saved-light.png`, `after-saved-light-page.png` |
| saved, light, narrow | 1024×720 | pass | `.devboard/.tmp/visual/after-saved-1024-light.png` |
| saved, dark (rebased bundle) | 2101×1017 | pass | `.devboard/.tmp/visual/final-saved-dark.png` |
| dirty, dark (rebased bundle) | 2101×1017 | pass | `.devboard/.tmp/visual/final-dirty-dark.png` |

After rebasing onto `fc186ba` (the Flow goal header redesign), the build, check, full test suite,
`verify:interface`, and the saved/dirty live pass were rerun against the integrated bundle. The
decision board is unaffected by that redesign: its own classes and 30px geometry are unchanged.

Measurements from the live DOM:

- Saved: state `Saved`, color `rgb(63, 185, 80)` = `success`, Save disabled, opacity 0.45,
  tooltip `No unsaved changes.`
- Dirty: state `Unsaved changes`, color `rgb(210, 153, 34)` = `warning`, Save enabled, 28px tall,
  tooltip `Save the decision board.`
- Empty (after saving an emptied editor): state `No decisions yet`, color
  `rgb(139, 148, 158)` = `muted-foreground`, Save disabled.
- Light theme: saved state `rgb(26, 127, 55)` = light `success`.
- Header: 30px tall, 12px gap, identity column 2px gap; the state line's bottom sits 0.42px inside
  the header border (no crossing). At 1024px the header and state line do not overflow, Save stays
  a 52px word, and the state line stays one line.
- Keyboard: tabbing reaches Save, `:focus-visible` matches, and the ring renders as a 1px
  `background` gap plus a 3px `ring` halo; the button is a normal stop in DOM order after the
  panel header.

## Checks

| Check | Result |
|---|---|
| Saved / dirty / empty copy | pass in the live surface |
| Save disabled at rest and enabled while dirty | pass in the live surface and `verify:interface` |
| Save through Ctrl/Cmd+S still sends exact text | pass; unchanged `verify:interface` assertion |
| Narrow viewport (1024×720) | pass; no header or state overflow |
| Light and dark theme | pass |
| Keyboard focus visibility | pass |
| Long decisions file | not exercised visually; the header is content-independent and the state line is one fixed line |
| Console errors | none observed during the live checks |
| Reduced motion | not applicable; the change adds no animation |
| Dependent pages | none; the header is local to the Decision board panel |

## Divergence from the wireframe

Only the grayscale-versus-token color difference recorded in `decisions.md`.

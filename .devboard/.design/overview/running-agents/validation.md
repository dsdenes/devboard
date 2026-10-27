# Validation — Overview / Running agents (#256)

## Commands

| Command | Result |
|---|---|
| `cd .devboard && bun install --frozen-lockfile` | pass |
| `cd .devboard && bun run build` | pass; `dist/index.html` and every referenced asset written |
| `cd .devboard && bun run check` | pass; 1672 files, 0 errors, 0 warnings |
| `cd .devboard && bun test` | pass; 581 tests, 0 fail, 4074 assertions |
| `cd .devboard && bun run verify:issues` | pass |
| `cd .devboard && bun run verify:interface` | pass, including the new header-badge assertion |

## Live surface

A fixture dashboard served the worktree's `dist` with a seeded state of 11 running agents
(`.devboard/.tmp/visual/seed.ts`; state and host under `.devboard/.tmp/visual/`), exercised with
the OMP browser tool at 2101×1017, 1440×900, and 1024×720.

| State | Viewport | Result | Evidence |
|---|---|---|---|
| default, selected first row, 2 blocked | 1440×900 dark | pass | `.devboard/.tmp/visual/after-panel-outline.png` |
| default, selected first row, 2 blocked | 1440×900 light | pass | `.devboard/.tmp/visual/after-panel-light.png` |
| full side column with the Automation panel above | 2101×1017 | pass | `.devboard/.tmp/visual/after-side.png` |
| 11 rows, narrow column | 1024×720 | pass | `.devboard/.tmp/visual/after-panel-1024.png` |
| hovered unselected row, hovered close | 1440×900 | pass | `.devboard/.tmp/visual/after-hover.png` |
| keyboard focus on a close control | 1440×900 | pass | `.devboard/.tmp/visual/after-focus.png` |
| empty fleet | 1440×900 | pass | `.devboard/.tmp/visual/after-empty.png` |

Measurements from the live DOM:

- Row height 27.59–28px (28px for rows with a badge), no row scroll overflow at 1024 or 1440
  (`scrollWidth <= clientWidth` for all 11 rows).
- Selected row: `background` `rgb(22,35,58)` = `accent-surface`, left edge `rgb(88,166,255)` =
  `accent`; hovered unselected row `rgb(27,33,41)` = `row-hover`; the two states differ.
- Close control at rest: `muted-foreground`, transparent fill, `border-subtle` outline, 24px.
  Its own hover/focus: `rgb(43,21,19)` = `error-surface`, `error` text and border, global 2px
  `ring` outline with 1px offset. Accessible name `Close issue #225` verified.
- Header badge `3 need answers` on the three-agent fixture (dark and light), absent with an empty
  fleet; `verify:interface` asserts the aggregate and its warning tone.
- Issue title, issue number, and elapsed time never overlap; the title column absorbs the narrow
  width and ellipsizes.

## Checks

| Check | Result |
|---|---|
| Long titles (200+ characters) truncate with tooltip | pass |
| Missing queue title | not exercised live; falls back to `Issue N` in unchanged code |
| Many agents (11) | pass; side column scrolls, no inner scrollbar, no clipping |
| Selected vs hover distinction | pass |
| Close refused / in flight | not exercised live; the disabled and error paths are unchanged |
| Empty fleet | pass |
| Light and dark theme | pass |
| Keyboard focus visibility and order | pass; native buttons, global ring, DOM order row → close |
| Destructive action wording | pass; `Close`, `aria-label`, `not planned` title |
| Console errors | none observed during the live checks |
| Reduced motion | not applicable; the change adds no animation |

## Divergence from the wireframe

None beyond the grayscale-versus-token color difference recorded in `decisions.md`.

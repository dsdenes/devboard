# Validation — Decision board header

- Page: Flow mode → Decision board (`#workspace-flow`, `[data-testid="flow-decisions-section"]`).
- Commit/branch: worktree `.worktree/issue-351`, branch `issue-351`.
- Build: `bun run build`.
- Dashboard: `HOST=127.0.0.1 PORT=8199 STATIC_DIR=<worktree>/.devboard/dist` with the
  `verify:interface` fixture host and seeded Flow session.
- Playwright source: OMP browser (Playwright-backed Chromium).
- Viewports: 1440×900 and 1024×720. Themes: dark and light.
- Journeys exercised: read a saved board, edit into the unsaved state, save an edited draft,
  clear the board to the empty state.
- States exercised: empty, saved, dirty, light theme, 1024px boundary.
- Dependent pages: no shared component changed. `Button` and `.badge` are reused unchanged, and
  the rest of the interface verification covers their existing consumers.

## Measurements

| State | Header height | Left padding | State | Badge tone | Save |
|---|---:|---:|---|---|---|
| Saved | 44px | 12px | `Saved` | `success` | disabled secondary |
| Unsaved | 44px | 12px | `Unsaved changes` | `warning` | enabled primary |
| Empty | 44px | 12px | `No decisions yet` | none (muted badge) | disabled secondary |

- Title and badge centers differ by 0px at both viewports.
- Title is one 21.6px line (18px / 1.2); it does not wrap.
- 1024×720: `scrollWidth === clientWidth === 1024`; the Save control's right edge is at 1003px;
  the badge does not overflow or clip.
- Standalone A2UI wireframe: `scrollWidth === clientWidth` at 1440 and 390.

## Screenshots
- `saved-dark-1440.png`
- `dirty-dark-1440.png`
- `dirty-light-1440.png`
- `empty-light-1440.png`
- `empty-dark-1440.png`
- `empty-dark-1024.png`

## Console/network
- No console entries on the worktree dashboard.
- One `GET /api/watchdog` connection-refused entry was recorded while the dashboard restarted;
  after the restart the endpoint returned 200 and no further failures appeared.

## Checks
- `bun run build`: pass.
- `bun run check`: 0 errors, 0 warnings.
- `bunx tsc --noEmit`: pass.
- `bun test`: 699 pass, 0 fail, 4776 assertions across 53 files.
- `bun run verify:interface`: the Decision board assertions pass (saved and unsaved badges, 44px
  row, aligned identity, 12px padding). The script then stops at its pre-existing Ask assertion:
  it counts `ask-spawn` log lines that commit `2ea5d0d` removed from the stub in favor of
  `ask-start`. That failure is unrelated to this change and outside its scope.
- UI/UX preflight: applicable, all checks pass.

## Not run / blocked
- `designmd` MCP research could not run because no MCP manager is configured; see
  `.design/research/2026-10-28-decision-board.md`. No token, OpenUI, or Storybook change was made.
- The panel body height is unchanged; this issue covers the selected header only.

## Verdict
Pass for the changed header. The verification script's unrelated Ask assertion remains a known
pre-existing failure on `main`.

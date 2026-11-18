# Validation — Decision board

- Page: Flow mode → Decision board (`#workspace-flow`, `[data-testid="flow-decisions-section"]`).
- Commit/branch: worktree `.worktree/issue-2181`, branch `issue-2181`, base `1d848da0`.
- Change: design packet only. No client or server source is part of this change.
- Dashboard: the live launcher-published dashboard (`v1.58.0`) at `http://127.0.0.1:8080`,
  Flow → Decision board. Its served client bundle does not contain the restoring branch
  (`index-Caf2uYHH.js` has no restore notice), so it renders the read-only surface without that
  state.
- Browser source: OMP browser (Playwright-backed headless WebKit).
- Viewports: 1440×900 and 1024×720. Theme: dark.
- Journeys exercised: read the empty board (the served Flow session holds no decisions).
- Dependent pages: no shared component changed. `.badge` and `.flow-document__text` are reused
  unchanged, and this change adds no design-system mutation.

## State matrix

| State | `data-state` | `data-tone` | Label | Body |
|---|---|---|---|---|
| Saved | `saved` | `success` | `Saved` | `<pre>` carries the board bytes |
| Empty | `empty` | none (muted badge) | `No decisions yet` | `<pre>` is empty |
| Restoring | `restoring` | `accent` | `Restoring` | restore notice; no `<pre>` and no board bytes |

Evidence: `DecisionBoard.test.ts`, 3 pass, 0 fail, 17 assertions. The restoring case keeps a
board text that arrived before the restore frame from winning over the notice.

## Measurements (empty state, live dashboard)

| Viewport | Section | Header height | Left padding | Badge | Body |
|---|---|---:|---:|---|---|
| 1440×900 | 1047×70 | 44px | 12px | `No decisions yet`, no tone | 24px empty `<pre>` |
| 1024×720 | 631×70 | 44px | 12px | `No decisions yet`, no tone | 24px empty `<pre>` |

- Title and badge centers differ by 0px at both viewports.
- Title is one 21.6px line (18px / 1.2); it does not wrap.
- 1024×720: `scrollWidth === clientWidth === 1024`; the section's right edge is at 1016px.
- The section renders no action control: zero buttons, no Save, and no dirty state.
- The empty body measures 24px: the `<pre>` padding only. `.flow-decisions__body` declares
  420px, but the panel's `flex: 1 1 0%` body is content-sized inside the content-sized panel,
  so the declaration does not size it. This change does not alter that layout.

## Wireframe

- Standalone `.design/a2ui/decision-board.wireframe.html` rendered at 1440×900 and 390×844.
- `scrollWidth === clientWidth` at both widths: 1440 and 390; no horizontal overflow.
- Region order in every state is `region_header` then `region_editor`, the same order as the
  shipped section.
- States rendered: empty, saved, restoring. The empty state draws no board bytes, the saved
  state draws the board bytes as a read-only document, and the restoring state draws the notice
  in place of the bytes.

## Screenshots

- `saved-dark-1440.png`, `empty-dark-1440.png`, `empty-dark-1024.png`, `empty-light-1440.png`,
  `dirty-dark-1440.png`, and `dirty-light-1440.png` are historical evidence from the editor-era
  header (worktree `.worktree/issue-351`). They show the retired Save control and editor and are
  not current evidence.

## Checks

- `verification_run {"check": "test", "paths": ["client/lib/components/DecisionBoard.test.ts"]}`:
  3 pass, 0 fail.
- Live dashboard check: empty board measured at 1440×900 and 1024×720; no console errors after
  the reload and no horizontal scroll.
- Wireframe check: three states, correct region order, no overflow at 1440 and 390.

## Not run / blocked

- Saved and restoring states were not exercised visually: the serving bundle predates
  `1d848da0`, and this run never restarts or replaces the dashboard. The component test covers
  their labels, tones, and body swap.
- `designmd` MCP research could not run because no MCP manager is configured. No token,
  OpenUI, or Storybook change was made, so no design-system mutation depended on it.
- Build and typecheck: not run for this packet-only change; no client or server source changed.

## Verdict

Pass for the packet correction. The packet now names the shipped read-only regions and lists
only the states `DecisionBoard.svelte` renders.

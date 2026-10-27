# Validation — Flow / Steering

- Page: Flow → Steering (`#workspace-flow`, `section[data-testid="flow-steering"]`).
- Branch: `issue-262`; commit: the revision that carries this file (merged to `main` after
  verification).
- Command: `cd .devboard && bun install --frozen-lockfile && bun run check && bun run build`, then
  a source dashboard from the worktree (`bun run server/index.ts`) with `STATIC_DIR` pointing at
  that build and a seeded Flow session under `.devboard/.tmp/verify-262`.
- Base URL: `http://127.0.0.1:8144/` (seeded notes), `http://127.0.0.1:8145/` (empty session).
- Playwright source: OMP browser (Playwright-backed Chromium).
- Viewports: 1724×834 (the issue's 2101×1017 at 1.21875), 1440×900, 1024×720. 390×844 is not
  supported: the app replaces the workspace with the viewport guard below 1024×720 by design.
- Screenshots: `.devboard/.design/steering/shots/` (ignored by `.devboard/.design/.gitignore`).

## Journeys exercised

| Journey | Evidence |
|---|---|
| Send a note | Typed a draft: `Send` enabled; clicked: draft cleared, note appeared with `new`, header changed to `1 note waiting for the next checkpoint`; server persisted `steering.jsonl` |
| Empty draft | Empty and whitespace-only drafts keep `Send` disabled (`disabled=""`) |
| Review the notes | Seeded new/read notes render in order with source, timestamp, and status word; header read `All notes read` when no note was new |
| Empty panel | Empty fixture: header `Read at the next checkpoint`, body `No steering notes yet.`, `Send` disabled |
| Long note | Sent a 108-character note at 1724 and 1024; row wraps inside the panel, no horizontal overflow |
| Keyboard | Focus on the textarea, `Tab` reaches `Send`; the 2px focus ring is visible and not clipped |
| State colors | `waiting` uses warning tone and `read` success tone, always with the state words |

## Measurements

- Before: at 1724 the panel was 1332.89px wide, its header 30px tall, and `Send` sat at
  x=1652.84 (54.16×28), 1,260px from the textarea at x=392.11; the button filled 28 of the 30
  header pixels and read as a page-level primary.
- After: `Send` starts at x=1368.84, 6px below the textarea's bottom edge (textarea bottom 111,
  button top 117) and shares the composer's right edge; the header holds only the title and the
  state line (143.58×15.94 at 1440).
- 1024: title at x=390.11, state line at x=810.89, `Send` at x=952.84; no overlap, no horizontal
  overflow (`scrollWidth === clientWidth === 1024`).
- Panel body owns the scrolling; header 30px, body padding 8px, composer gap 6px — all on the
  approved scale.

## Console/network

- `tab.errors()` empty on both fixtures; no failed request affected the panel.

## Dependent pages

- `Button` and `.textarea` are unchanged; no design-system component was modified.
- Other Flow panels, the sidebar `Steering` count, and the command palette's
  `open.flow.steering` / `flow.steering.focus` entries are untouched. `bun run check` reports
  0 errors and 0 warnings across 1672 files; `bun test` and the interface verification cover the
  remaining branches.

## Not run / blocked

- No-session send failure: the seeded fixtures always had a session, so the existing notification
  path for `No Flow session exists.` was not re-exercised. The panel code around it is unchanged.
- Loading and permission-denied states do not exist for this panel; the server owns the snapshot.
- `verify-interface.ts` asserts the existing `flow-steering-note` rendering only; it does not
  assert the header composition. The browser evidence above covers the redesigned surface.

## Verdict

pass (with the no-session failure path noted as not exercised).

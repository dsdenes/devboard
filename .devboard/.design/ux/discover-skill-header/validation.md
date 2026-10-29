# Validation

- Page: Discover skill editor, `/` with Discover mode and the `naming-conventions` tab.
- Commit/branch: `issue-786`, merged with `origin/main` (`1fd286c`).
- Command: `bun run build`; source dashboard
  `HOST=127.0.0.1 PORT=8199 ADRS_DIR=… REPO_DIR=… GOAL_FILE=… STATIC_DIR=dist STATE_DIR=… AGENT_COMMAND=true bun run server/index.ts`
  against a copied fixture host under `.devboard/.tmp`; `bun run check`; `bunx tsc --noEmit`;
  `bun test`; a temporary copy of `bun run verify:interface`.
- Base URL: `http://127.0.0.1:8199/`.
- Playwright source: OMP browser tool (Chromium) plus the project's CDP interface suite.
- Viewports: 1440×900 and 1024×720; the sidebar was also widened to its bound.
- Journeys exercised:
  - J1 read the path and draft state on a clean skill.
  - J2 edit, observe `Unsaved changes`, save, observe the clean state.
  - J3 discard an edit and return to the generated text.
  - J4 delete the live file, observe `Live file missing`, recreate it, observe clean.
- States exercised: clean/generated, clean/edited, dirty, missing, long path (1024px), dark and
  light themes, wide sidebar.
- Dependent pages: none. The change touches only `.discover-skill__header` and the `Button`
  variant selection at its call site; no shared component or token changed.
- Screenshots:
  - `before-clean-1440-light.webp` — the two-line header before the change.
  - `after-clean-1440-dark.webp`, `after-clean-1440-light.webp` — one row, muted clean state,
    quiet disabled Save.
  - `after-dirty-1440-dark.webp` — `Unsaved changes` and the filled primary Save.
  - `after-edited-1440-dark.webp` — clean edited skill with the outline restore control.
  - `after-missing-1440-dark.webp`, `after-missing-1024-dark.webp` — `Live file missing` with
    Recreate as the only primary.
  - `after-clean-1024-dark.webp` — the default narrow viewport.
  - `after-narrow-sidebar-1024-dark.webp` — the path truncates, the state and actions stay on
    the 30px row, no horizontal overflow.
- Measurements at 1440×900 dark: header height 30px, identity/action center delta 0.008px,
  `No unsaved changes`, Save disabled with `bg-[var(--secondary)]`, header `scrollWidth` equals
  `clientWidth`. Dirty: Save `bg-[var(--primary)]` and enabled. Missing: Save disabled
  `secondary`, restore `bg-[var(--primary)]`. After merging main, Button horizontal padding is
  the documented 10px.
- Console/network: no page errors or failed requests observed in the browser session.
- Checks: `bun run check` 0 errors/0 warnings; `bunx tsc --noEmit` 0 errors; `bun test`
  1091 pass / 0 fail.
- Findings: the state word and the action it qualifies now share one baseline; the disabled
  blue primary that dominated the clean state is gone; the missing state names its recovery and
  gives that recovery the only primary.
- Not run / blocked: the designmd MCP research could not run because `mcp://` reports no MCP
  manager; the receipt records the limitation. `bun run verify:interface` is red on
  `origin/main` before reaching Discover: it still expects the old 12px Button padding while the
  shipped Button uses 10px. A temporary copy with that one stale assertion corrected passes the
  whole Discover block (including this header's one-row geometry, missing state, and recovery
  emphasis) and then fails at a pre-existing Issues poll assertion
  (`Tracker sync starting` instead of `Not polling`). Both failures are outside this change and
  are reported in the issue comment.
- Verdict: pass for the changed surface.

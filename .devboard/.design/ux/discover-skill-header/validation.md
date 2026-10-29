# Validation

- Page: Discover skill editor, `/` with Discover mode and the `naming-conventions` tab.
- Commit/branch: `issue-786` based on `origin/main`.
- Command: `bun run build`; source dashboard
  `HOST=127.0.0.1 PORT=8199 ADRS_DIR=… REPO_DIR=… GOAL_FILE=… STATIC_DIR=dist STATE_DIR=… AGENT_COMMAND=true bun run server/index.ts`
  against a copied fixture host under `.devboard/.tmp`; `bun run check`; `bun test`;
  `bun run verify:interface`.
- Base URL: `http://127.0.0.1:8199/`.
- Playwright source: OMP browser tool (Chromium) plus the project's `verify:interface` CDP suite.
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
  - `after-narrow-sidebar-1024-dark.webp` — the path truncates, the state and actions stay on
    the row, no horizontal overflow.
- Measurements at 1440×900 dark: header height 30px, identity/action center delta 0.008px,
  `No unsaved changes`, Save disabled with `bg-[var(--secondary)]`, header `scrollWidth` equals
  `clientWidth`. Dirty: Save `bg-[var(--primary)]` and enabled. Missing: Save disabled
  `secondary`, restore `bg-[var(--primary)]`.
- Console/network: no page errors or failed requests observed in the browser session.
- Findings: the state word and the action it qualifies now share one baseline; the disabled
  blue primary that dominated the clean state is gone; the missing state names its recovery and
  gives that recovery the only primary.
- Not run / blocked: the designmd MCP research could not run because `mcp://` reports no MCP
  manager; the receipt records the limitation. `bun run verify:interface` reaches a pre-existing
  Issues poll assertion failure outside this change; see the report in the issue comment.
- Verdict: pass for the changed surface; the full interface suite is reported separately.

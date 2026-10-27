# Validation — Discover mode redesign

- Page: Discover mode (Overview, Glossary, term, five skill pages, Warnings, empty, active run,
  question, error) plus the shared mode rail and sidebar identity.
- Commit/branch: `discover-redesign` worktree, based on `main` at `8e66c26`.
- Command:
  - `cd .devboard && bun run build`
  - `cd .devboard && bun run check`
  - `cd .devboard && bun test`
  - `cd .devboard && bun run verify:interface`
  - validation dashboard:
    `ADRS_DIR=.tmp/validation/host/adrs REPO_DIR=.tmp/validation/host GOAL_FILE=.tmp/validation/host/GOAL.md STATIC_DIR=dist STATE_DIR=.tmp/validation/host/.state AGENT_COMMAND="bun server/fixtures/stub-agent.ts --discover" bun run server/index.ts` (port 8137), then the same server with `--discover --discover-no-exit --discover-question` for the active and question states.
- Base URL: `http://127.0.0.1:8137/` (validation fixture); the interface verifier uses its own fixture and a free port.
- Playwright source: project — `scripts/verify-interface.ts` drives headless Chromium through CDP and
  screenshots `.devboard/.tmp/interface/`; OMP's Playwright-backed `browser` tool drove the empty,
  active/question, error, light-theme, and 1024×720 states.
- Viewports: 1440×900; 1024×720 (the supported boundary). 390×844 applies to the standalone
  wireframes only; the application replaces its shell with the viewport guard below 1024×720.
- Journeys exercised:
  1. First discovery: empty → `Discover project` → published sheet (stub crawl; 2 terms, 5 skills).
  2. Orientation scan: header, freshness, Commands, Testing, Bounded contexts, Platform, Delivery,
     Stack, stack repository link.
  3. Stale re-discovery: the verifier's fixture is stale; the `stale` marker renders beside the
     title and `Re-discover` is the header action.
  4. Stop: active run → `Stop` → run region disappears, `Discover project` returns, no replacement.
  5. Glossary review: glossary → term → back; search and minimum-use filter; filtered-empty reset.
  6. Skill edit/restore: Monaco edit → dirty marker → Save → Restore (interface verifier).
  7. Question: elicited question, options, answer field (active screenshots; server tests cover
     one-answer refusal).
  8. Remote target: the interface verifier covers the active remote target, invalid URL refusal,
     clear, and the installed gate. The validation fixture showed the documented scratch-root
     refusal as the error state.
- States exercised:
  - default/published (dark and light, 1440), empty (dark and light), active run + question (dark),
    stopped, error, interrupted (verifier fixture replay), partial (`unknown` and `Not observed`
    rows), stale (verifier fixture), filtered-empty, 1024×720 single column.
- Dependent pages:
  - Goal and Flow are exercised by `verify:interface` after the rail, sidebar identity, and
    `DetailSplit` changes: mode switching, shortcut inertness, ADR table, Flow widget split,
    persistence, palette, and the 1024×720 boundary.
  - `DetailSplit` is shared with Flow; its 2px minimum buffer is covered by the Flow split drag,
    double-click reset, and keyboard resize checks.
- Screenshots (`.design/ux/discover/screenshots/`):
  - `published-overview-desktop-verify.png`, `published-glossary-desktop-verify.png`,
    `published-term-desktop-verify.png`, `published-skill-desktop-verify.png` — interface verifier,
    current build.
  - `published-desktop-dark.png`, `published-1024-dark.png`, `published-desktop-light.png`,
    `glossary-desktop-light.png`, `term-desktop-light.png`, `skill-desktop-light.png` — validation
    dashboard.
  - `empty-desktop.png` (light), `empty-desktop-dark.png`, `active-desktop-dark.png`,
    `error-desktop-dark.png`.
  - `wireframe-discover-{overview,empty,pages}-{1440,390}.png`.
- Console/network: `verify:interface` records page exceptions, `console.error`, failed requests, and
  HTTP responses ≥400 and fails when any affects the page; it passed. The OMP browser runs reported
  no page errors in the observed states.
- Findings and fixes during validation:
  - The notification region (fixed 34px above the status bar, 380px wide) covered the last control
    of a Discover page at maximum scroll. Fixed by reserving 56px at the page bottom; documented in
    `DESIGN.md` as a fixed-overlay clearance, and the remote-clear click now reaches the control.
  - `DetailSplit` let a dragged pane measure 159px because Paneforge rounds percentages down. Fixed
    with a 2px buffer above the 160px minimum.
  - A source checkout with no published artifacts never learned `remoteAvailable`, so the documented
    manual-testing strip was absent from the empty page. Fixed by replaying one `discoverState` on
    connect when the gate is open; `server/discover-remote.test.ts` now asserts the replay.
  - Mode labels are checked for overflow and containment inside their tabs at every run.
  - Duplicate information removed: the "run started/completed" notice (the header and active panel
    already say it), the warning banner above the sheet, the sidebar recent-notices list, and the
    skill count. Intentional repetitions kept: the status bar names a running Discover run while
    another mode is visible, and a skill's `edited`/`missing` state appears in navigation while the
    page header states it fully.
  - Spacing audit: Discover now uses 2/4/6/8/10/12/16/24 and 56px overlay clearance; the previous
    18px and 22px layout gaps, 10.5px/11.5px/12.5px type, and 20px empty-body padding are gone.
    Fixed component geometry (180px terminal, 104px fact labels, 200–600px sidebar, 160px split
    minimum) is documented in `DESIGN.md`.
  - No horizontal scroll at 1024×720 or 1440×900; no clipped card, table, or rail label.
- Not run / blocked:
  - A live-model Discover crawl and the remote GitHub smoke procedure. They need a model endpoint
    and network; the operator smoke procedure in `README.md` covers them and is not a pass gate.
  - Storybook: no new story was required because no OpenUI primitive or DTCG token changed; the
    existing `Design System/Overview` story still matches `design/tokens.json` (export diff empty).
- Verdict: pass for the structural, visual, interaction, and accessibility checks listed above;
  live-crawl behavior remains covered by the server suite and the documented operator procedure.

## Issue #228 — skill editor header

- Element: `#workspace-discover .discover-skill__panel .panel__header`.
- Change: the header is now a two-line identity block — the relative path with the skill name in
  `foreground` and `/SKILL.md` muted in `muted-foreground`, over an 11px draft line — with the
  restore and Save controls right-aligned. Save is disabled and titled while the draft matches the
  live text. The path keeps `mono` type and a full-path `title`.
- Commands: `cd .devboard && bun run build`; `cd .devboard && bun run verify:interface`.
- Fixture: the verifier's seeded host served on port 8091 with the worktree `dist`.
- States and viewports:
  - clean, 1440×900 dark — `after-228-header-1440-dark.webp`;
  - clean, 1024×720 dark — `after-228-header-1024-dark.webp`;
  - unsaved draft, 1024×720 dark — `after-228-header-dirty-1024-dark.webp`;
  - unsaved draft, 1024×720 light — `after-228-header-dirty-1024-light.webp`;
  - live file missing, 1024×720 light — `after-228-header-missing-1024-light.webp`;
  - previous header, 1024×720 dark — `before-228-header-1024-dark.webp`.
- Checks: the identity block and actions both fit the 30px header with no clipped text
  (`scrollHeight − clientHeight ≤ 1`); the path stays on one line; the state line changes
  `No unsaved changes` → `Unsaved changes` (warning) → `Live file missing` (error) as the state
  changes; Save is disabled with a reason while clean or missing and enabled while dirty; the
  restore control renders for edited and missing skills only. No console or network error appeared
  in the observed states. `verify:interface` passed, including its updated assertions for the
  draft line and the disabled Save.
- Not run: no OpenUI primitive or DTCG token changed, so no Storybook story or catalog entry was
  required.
- Verdict: pass.

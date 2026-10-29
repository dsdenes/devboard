# Auto Scout agent header — validation

- Page: `/` → Issues mode → `Auto Scout` (`#workspace-issues`,
  `section.agent-page[data-agent="scout"]`, `header[data-testid="agent-header"]`).
- Branch/worktree: `issue-465`, `.worktree/issue-465`.
- Build: `bun run build` in `.devboard` (Vite build, no warnings).
- Dashboard: source server
  `HOST=127.0.0.1 PORT=8181 REPO_DIR=<worktree> ADRS_DIR=<worktree>/adrs
  GOAL_FILE=<worktree>/GOAL.md STATIC_DIR=<worktree>/.devboard/dist
  STATE_DIR=<worktree>/.verify/state AGENT_COMMAND=true bun .devboard/server/index.ts`
  from the worktree root; base URL `http://127.0.0.1:8181/`.
- Browser: OMP managed Chromium (Playwright-backed), shared tab.
- Viewports: 2101×1017, 1440×900, 1024×720, device scale factor 1.25.
- Journeys exercised: read the state (J1), change cadence and limits including invalid input
  (J3/J4 via `verify:agents`), start/stop lifecycle and timer gate (J2 via `verify:agents`),
  failed/recovered forge read (J5 via `verify:agents`). A live Auto Scout run was not started from
  this checkout; `verify:agents` drives the lifecycle against its own fixture and `true` agent
  command.
- States exercised: stopped with `forge read stale` and `never` clocks; Watchdog stopped with
  `forge read ok`, a populated last-read clock, and `unlimited` placeholders; dark and light
  themes; stacked Goal header (dependent page) at 1024.
- Screenshots (in this directory):
  - `wide-2101-dark.png`
  - `wide-1440-dark.png`
  - `narrow-1024-dark.png`
  - `wide-1440-light.png`
  - `narrow-1024-light.png`
  - `watchdog-wide-1440-dark.png`
  - `watchdog-narrow-1024-dark.png`
- Measurements:
  - 2101×1017: header 1694×87; row 44px, footer 41px; one row for identity/state/action and one
    row for both settings groups; `scrollWidth === 2101`; title and subtitle not truncated.
  - 1440×900: header 1034×87; same one-row shape; `scrollWidth === 1440`.
  - 1024×720: header 619×151; the identity row is 74px (state and action wrapped below the
    identity) and the footer is 75px (the two groups stack); `scrollWidth === 1024`; the title
    and the purpose sentence are both whole (`scrollWidth === clientWidth` on each).
  - Limit inputs are 80px so the `unlimited` placeholder is not clipped.
  - Wireframe: `scrollWidth === clientWidth` at 1440 and 390.
- Dependent pages: `PageHeader` internal markup changed for every consumer (the identity/action
  row is now `.page-header__row`). The stacked Goal header renders unchanged at 1024 (title,
  three wrapped subtitle lines, meta, and the three actions on the top-right) and
  `bun run verify:interface` passes its narrow-header, alignment, overflow, theme, split, and
  accessibility checks.
- Console/network: `tab.errors()` empty after the captures; no failed request was observed that
  affected the header.
- Not run:
  - `designmd` MCP research: no MCP server is configured (`.omp/mcp.json` lists only `adrkit`);
    recorded in `.design/research/2026-10-29-agent-scout-header.md`. No design-kit value was
    imported.
  - A live running Auto Scout screenshot: starting the real worker would spawn a scan against this
    checkout. The running/stopping badge and Stop swap are exercised by `verify:agents` instead.
  - A real forged sync failure: `verify:agents` drives the stale/error/recovered transition against
    the stub forge.
- Checks:
  - `bun run check`: 0 errors, 0 warnings (1725 files).
  - `bun test`: 886 pass, 0 fail (66 files), including `bun test client`.
  - `bun run verify:agents`: all ten stages pass, including `shared-page-shape` (updated core id
    order), `cadence-limits`, `lifecycle`, `freshness-and-table`, and `timer-gate`.
  - `bun run verify:interface`: passed.
  - `bunx storybook build`: completed successfully, including `Design System/PageHeader` →
    `BarWithFooter`.
  - UI/UX preflight: applicable, all checks pass; OpenUI and DESIGN.md lint clean.
- Verdict: pass.

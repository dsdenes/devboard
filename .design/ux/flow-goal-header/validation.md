# Validation — Flow goal header

- Page: Flow mode → Overview → `#workspace-flow`, `[data-testid="flow-goal"]`.
- Commit/branch: worktree `.worktree/issue-260`, branch `issue-260`.
- Command: `bun run build`; source dashboard
  `HOST=127.0.0.1 PORT=8199 ADRS_DIR=… REPO_DIR=… GOAL_FILE=… STATIC_DIR=… STATE_DIR=… AGENT_COMMAND=true bun run server/index.ts`.
- Base URL: `http://127.0.0.1:8199/` (saved/dirty fixture) and
  `http://127.0.0.1:8200/` (empty fixture).
- Playwright source: OMP browser (Playwright-backed Chromium), plus
  `bun run verify:interface`.
- Viewports: 1440×900, 1024×720.
- Journeys exercised: create from empty (empty state controls), save an edited draft
  (dirty → Save enabled), replace a saved goal (recreate control), interview-running
  state from the client's derived state.
- States exercised: empty, saved, dirty, collapsed/interview-running derivation, light
  theme, 1024px boundary.
- Dependent pages: no shared component changed. `Button` and `.badge` are reused
  unchanged; the full interface verification covers their existing consumers.
- Screenshots:
  - `saved-dark-1440.png`
  - `dirty-dark-1440.png`
  - `dirty-panel-dark-1440.png`
  - `empty-dark-1440.png`
  - `empty-light-1440.png`
  - `empty-light-1024.png`
- Console/network: no console entries on either fixture; no failed requests affecting
  the header.
- Findings:
  - The header is one 44px row at both viewports; the title and state badge share a
    center line.
  - The empty state's only filled primary is `Create flow goal`; Save is a neutral
    disabled secondary control.
  - The saved state shows a success badge; the dirty state shows a warning badge and
    turns Save into the filled primary.
  - The interview-running state is the same row with an accent badge and the editor
    collapsed by existing behavior.
  - No overflow at 1024×720 (`scrollWidth === clientWidth === 1024`); no horizontal
    scroll.
  - The standalone A2UI wireframe renders at 1440 and 390 with no horizontal overflow
    (`scrollWidth === clientWidth` at both widths).
- Not run / blocked:
  - A live goal interview was not run against a real ACP peer; the running badge is
    derived from the same `flow.goalCreation` state that the existing suite exercises,
    and the editor collapse behavior is unchanged.
  - designmd MCP research could not run because no MCP manager is configured; see
    `.design/research/2026-10-27-flow-goal-header.md`. No token, OpenUI, or Storybook
    change was made.
- Checks:
  - `bun run check`: 0 errors, 0 warnings.
  - `bun test client`: 41 pass, 0 fail.
  - `bun run verify:interface`: passed, including the new header badge, height, and
    alignment assertions.
  - UI/UX preflight: applicable, all checks pass.
- Verdict: pass.

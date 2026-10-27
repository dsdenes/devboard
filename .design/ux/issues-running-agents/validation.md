# Issues overview — running agent list validation

- Issue: #238. Changed surface: the running-agent rows of the Issues overview (`.issues-agent-row`)
  and the row's component entry in `DESIGN.md`.
- Worktree: `.worktree/issue-238`, branch `issue-238` from `origin/main` at `bcef392`.
- Commands, run from `.devboard` in the worktree:

```bash
bun install --frozen-lockfile
bun run build                 # vite build, dist rewritten
bun test                      # 536 pass, 0 fail, 3934 expect() calls, 40 files
bunx tsc --noEmit             # 0 errors
bun run check                 # svelte-check: 1245 files, 0 errors, 0 warnings
bun run verify:issues         # passed, including the new row geometry assertions
```

- Validation dashboard (served the worktree build, not the installed bundle):

```bash
cd .devboard
ADRS_DIR=.tmp/validation/host/adrs REPO_DIR=.tmp/validation/host \
GOAL_FILE=.tmp/validation/host/GOAL.md STATIC_DIR=dist \
STATE_DIR=.tmp/validation/state AGENT_COMMAND="true" PORT=8188 bun run server/index.ts
```

  The fixture state seeded five agents from the live state file with operator-length titles, one
  agent waiting on a question, an empty state, and an expired/elapsed clock. All paths under the
  worktree.

- Viewports: 1440×900 (two overview columns) and 1024×720 (single column, supported floor).
- Journeys exercised:
  1. Read the list: number, title, elapsed time; titles truncate with the full text in the row
     tooltip; rows stay 29.4px tall and never overflow horizontally.
  2. Blocked agent: the question fixture renders the `needs answer` warning badge before the
     elapsed value; other rows carry no badge. The per-row `running` word is gone.
  3. Open an agent: clicking row `#226` opened the agent focus page with `#226` and the same
     title; the tab is titled from the issue.
  4. Empty state: with `agents: []`, the panel renders one padded muted line
     `No issue is running.` and no focusable row.
  5. Keyboard: Tab focuses a row with the 2px ring outline (computed
     `2px solid var(--ring)`, offset 1px), Enter/Space use the same click handler.
  6. Clock: elapsed values advance while the overview is open (8m → 8m), proving the page now
     ticks outside the Agents page.
- Geometry measured in the browser at 1440 and 1024: for all five rows, the issue column's right
  edge ≤ the title's left edge, the title's right edge ≤ the meta group's left edge, and
  `scrollWidth <= row width`. The same checks now run in `verify:issues` against a four-agent
  fixture (issue order `1,2,3,4`, elapsed text present, no overlap, no overflow).
- Duplicate information removed: the hard-coded per-row `running` badge. The lifecycle badge,
  the Automation `Agents · N running` fact, the panel subtitle `N active`, and the mode rail state
  dot still state the state once per surface.
- Console/network: the validation tab reported zero page errors, zero `console.error` entries,
  and `verify:issues` passed its page-error and failed-request gates.
- Screenshots (`.design/ux/issues-running-agents/`):
  - `issues-overview-1440-dark.png`, `issues-overview-1024-dark.png` — full page context.
  - `running-agents-1440-dark.png`, `running-agents-1440-light.png`,
    `running-agents-1024-dark.png` — the panel in both themes and at the supported floor.
  - `running-agents-empty-dark.png` — empty state.
- Not run / blocked:
  - Storybook: no component in `openui.json` and no token changed; the row is a page-level list
    style, so no story was added.
  - The live dashboard on port 8081 was read only for the baseline defect; every capture above
    comes from the worktree build so no stale bundle was mistaken for the change.

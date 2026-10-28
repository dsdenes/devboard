# Watchdog page — validation

- Issue: #362. Changed surface: `#workspace-issues > section.watchdog-page` (the Issues mode's
  Watchdog page), its `DESIGN.md` page entry, and the README's Watchdog page layout contract.
- Worktree: `.worktree/issue-362-redesign`, branch `issue-362-redesign`, based on `origin/main` at
  `20a7cda`.
- Every artifact, fixture, state directory, screenshot, and browser profile stayed inside the
  worktree. The canonical checkout was not edited.

## Commands

Run from `.devboard` in the worktree:

```bash
bun install --frozen-lockfile
bun run build                 # vite build, dist rewritten from this worktree
bunx tsc --noEmit             # 0 errors
bun run check                 # svelte-check: 1709 files, 0 errors, 0 warnings
bun test                      # 751 pass, 0 fail, 4880 expect() calls, 57 files
bun run verify:watchdog       # PASS: page, history, issues, sync, refresh, indicator, popover
```

`verify:watchdog` also asserted `no-console-error` and ran its own empty, seeded, failing-read,
recovered, and freshness phases against the changed page.

## Validation dashboard

The worktree build, not the installed bundle, served every capture:

```bash
cd .devboard
PATH="$PWD/.tmp/visual/bin:$PATH" REPO_DIR="$PWD/.tmp/visual/host" \
ADRS_DIR="$PWD/.tmp/visual/host/adrs" GOAL_FILE="$PWD/.tmp/visual/host/GOAL.md" \
STATIC_DIR="$PWD/dist" STATE_DIR="$PWD/.tmp/visual/state" HOST=127.0.0.1 PORT=8311 \
AGENT_COMMAND=true bun run server/index.ts
```

- `STATE_DIR` held a copy of the canonical watchdog state: 93 retained cycles and 41 filed
  ledger entries, with 0 pending filings.
- `PATH` prefixed a stub `gh` that answered issue state, timeline, commit, and release reads, so
  the page could be observed in its healthy `GitHub read ok` state without depending on the live
  rate limit. The stub wrote nothing outside `.tmp/visual/`.
- The empty and failing-read states were rendered by intercepting `GET /api/watchdog` in the
  browser; no server state was rewritten.

## Viewports and states

- **2101×1017 — two columns.** Primary 1038px (summary over the filed table), history aside
  644px; the body fills the 855px under the header. No page scroll and no horizontal overflow.
- **1440×900 — one column** (page container 1066px). Summary, filed table at its 432px cap, then
  history at its 522px cap; the page scrolls 354px. No horizontal overflow.
- **1024×720 — one column** (page container 651px). The table drops Category, Filed, and Version,
  keeping Issue and State; scrolled to the end shows the whole history panel. No horizontal
  overflow.

- Healthy full data (`GitHub read ok`, 93 cycles, 41 filed rows): wide, 1440 dark/light, 1024.
- Error: red `GitHub read error` badge plus the full-width `HTTP 401: Bad credentials` alert
  above the summary; the summary and both empty panels stay in place.
- First load / empty: `never`, `none`, `0`, `No issue has been filed.`, `No cycle has run yet.`,
  `0 filed`, and a muted pending count.
- Long finding lines ellipsize with the full `[watchdog] <category>: <line>` in the title tooltip.
- Keyboard: five Tab presses from the page body reach `watchdog-issue-title`; the focused anchor
  reports `:focus-visible` true with `2px solid rgb(88, 166, 255)` (dark `ring`) and a 1px offset.
- Console: no page error and no `console.error` in either capture script.

## Duplicate information removed

- `Issues` eyebrow above `Watchdog` — the mode rail and the sidebar already name the mode.
- Pending filing count in the filed-issues subtitle — it now appears once, in the newest-cycle
  stat rail; the table header states only `41 filed`.
- Per-cycle window, finding count, and reason stay out of history rows; the newest-cycle panel
  owns them.

## Evidence files

- `.design/ux/watchdog/watchdog-2101.png` — two-column, healthy, 93 cycles and 41 filed rows.
- `.design/ux/watchdog/watchdog-1440-dark.png`, `watchdog-1440-light.png` — stacked layout in both
  themes.
- `.design/ux/watchdog/watchdog-1024-dark.png`, `watchdog-1024-dark-bottom.png` — supported floor,
  top and scrolled to the end.
- `.design/ux/watchdog/watchdog-empty-1440.png` — first-load state.
- `.design/ux/watchdog/watchdog-error-1440.png` — failed GitHub read with the retained panels.

## Not run / limits

- Storybook: no OpenUI component, token, or story changed; the page is a single-consumer
  composition of existing primitives.
- Mobile viewports: DESIGN.md defines no mobile scale; below 1024×720 the shell's viewport guard
  replaces the workspace.
- The `designmd` MCP manager was unavailable; the configured server was called directly over
  stdio (receipt: `.design/research/2026-10-28-watchdog.md`).

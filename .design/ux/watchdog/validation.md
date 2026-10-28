# Watchdog page — validation

- Issue: #358. Changed surface: `#workspace-issues > section.watchdog-page` (the Issues mode's
  Watchdog page), its `DESIGN.md` page entry, and the README's `watchdog-issues-count` sentence.
- Worktree: `.worktree/issue-358`, branch `issue-358`, based on `origin/main` at `ff61319`.
- Validation command in `.devboard` in the worktree; every artifact, fixture, state directory, and
  screenshot stays inside the repository.

## Commands

```bash
bun install --frozen-lockfile
bun run build                 # vite build, dist rewritten from this worktree
bun test                      # 695 pass, 0 fail, 4701 expect() calls, 53 files
bunx tsc --noEmit             # 0 errors
bun run check                 # svelte-check: 1690 files, 0 errors, 0 warnings
bun run verify:watchdog       # PASS: page, history, issues, sync, refresh, indicator, popover
```

`verify:watchdog` was run twice on the changed page, including after the final layout change; the
last run passed every gate and `no-console-error`.

## Validation dashboard

The worktree build, not the installed bundle, served every capture:

```bash
cd .devboard
ADRS_DIR=.tmp/validation/host/adrs REPO_DIR=.tmp/validation/host \
GOAL_FILE=.tmp/validation/host/GOAL.md STATIC_DIR=dist \
STATE_DIR=.tmp/validation/state AGENT_COMMAND=true PORT=8201 HOST=127.0.0.1 \
PATH="$PWD/.tmp/validation/bin:$PATH" bun run server/index.ts
```

- `STATE_DIR` held a copy of a real watchdog state: 100 retained cycles, 13 filed issues, 0 pending
  filings.
- `PATH` prefixed a stub `gh` that answered the issue-state, release, and timeline reads, so the
  page could be observed in its healthy (`GitHub read ok`) state without depending on the live
  rate limit. The stub wrote nothing outside `.tmp/validation/`.
- A second server on port 8200 used an empty `STATE_DIR` for the first-load state.
- The error state was observed from the live reader before the stub was introduced: red
  `GitHub read error` badge plus the `error-surface` alert, with the cycle and table rows retained.

## Viewports and states

| Viewport | Layout observed |
|---|---|
| 2101×1017 | Two columns; body 855px under the header, both panels fill it, history scrolls internally |
| 1440×900 | One column (page container 1066px); summary, filed table, then history; page scrolls |
| 1024×720 | One column (page container 651px); table drops Category/Filed/Version; title is 515px |

- Healthy full data (`GitHub read ok`, 100 cycles, 13 filed rows): wide, 1440 dark/light, 1024.
- Error: red sync badge and alert above the summary; no panel is hidden.
- First load / empty: `never`, `none`, `0`, `No issue has been filed.`, `No cycle has run yet.`
- Pending filings `0` stays muted; the data-warning rule colors the value only above zero.
- Long finding lines ellipsize with the full issue title in the `title` tooltip.
- Keyboard: Tab reaches each issue and cycle link; the measured ring is
  `2px solid rgb(88, 166, 255)` (dark `ring`) with a `1px` offset. Focus stayed on
  `watchdog-issue-title`.
- 1024 scroll: `page.clientHeight = 694`, `scrollHeight = 1037`; after scrolling to the end the
  cycle-history panel's bottom (678) is inside the 720px viewport, so no content is clipped.
- No horizontal overflow: `scrollWidth == clientWidth` at 2101, 1440, and 1024.

## Duplicate information removed

- `Issues` eyebrow above `Watchdog` — the mode rail and the sidebar already name it.
- Pending filing count in the filed-issues subtitle — it now appears once, in the newest-cycle
  stat rail; the table header states only `13 filed`.
- Per-cycle window, finding count, and reason stay out; the newest-cycle panel owns them.

## Console and network

- Page errors: none.
- `console.error`: none (also asserted by `verify:watchdog`'s `no-console-error`).
- `/api/watchdog`: every request returned `200`; no failed requests in the session.

## Evidence files

- `.design/ux/watchdog/watchdog-2101-healthy.png` — two-column, healthy, full data.
- `.design/ux/watchdog/watchdog-1440-dark.png`, `watchdog-1440-light.png` — stacked layout in both
  themes.
- `.design/ux/watchdog/watchdog-1024-dark.png`, `watchdog-1024-dark-bottom.png` — supported floor,
  top and scrolled-to-end.
- `.design/ux/watchdog/watchdog-empty-1440-dark.png` — first-load state.

## Not run / limits

- Storybook: no OpenUI component, token, or story changed; the page is a single-consumer
  composition of existing primitives.
- Mobile viewports: DESIGN.md defines no mobile scale; below 1024×720 the shell's viewport guard
  replaces the workspace.
- The `designmd` MCP manager was unavailable; the configured server was called directly (receipt:
  `.design/research/2026-10-28-watchdog.md`).

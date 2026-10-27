# Validation — Auto Scout

- Page: Issues mode → Auto Scout, `#workspace-issues`,
  `[data-testid="issues-scout"]`.
- Commit/branch: worktree `.worktree/issue-264`, branch `issue-264`.
- Command: `cd .devboard && bun run build`, then the source dashboard at
  `http://127.0.0.1:8091/` with `PORT=8091`, `STATE_DIR` under the worktree,
  `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, and `STATIC_DIR` pointing into the
  worktree.
- Viewports: 2101×1017 and 1024×720 (the supported floor), dark and light.
- Playwright source: OMP browser (Playwright-backed Chromium), plus
  `bun run verify:scout` and `bun run verify:interface`.
- States exercised:
  - Empty/stopped, dark: `.design/ux/auto-scout/empty-dark-2101.webp`
  - Empty/stopped, light: `.design/ux/auto-scout/empty-light-2101.webp`
  - Populated (three rows, pending and implemented, activity log):
    `.design/ux/auto-scout/populated-dark-2101.webp`
  - Populated at 1024×720: `.design/ux/auto-scout/populated-dark-1024.webp`
  - Failed read plus invalid limits:
    `.design/ux/auto-scout/error-dark-2101.webp`
- Journeys exercised end to end by `bun run verify:scout`: start a scan and
  file significant items, save both limits and survive a reload, read the
  filed rows, update a closed row with a release, surface a failed read, and
  stop the worker. The script also proves an empty table renders its empty
  state before the first scan.
- Dependent pages: no shared component or token changed. `PageHeader`,
  `Button`, and `Input` are reused as-is; `bun run verify:interface` covers
  their other consumers.
- Console/network: no console entries and no failed requests on the Auto
  Scout page at either viewport.
- Findings:
  - The page header states eyebrow, title, origin, lifecycle, read health,
    and last-read time on one surface, with the single Start/Stop action at
    the right.
  - At 2101×1017 the side rail is 360px; the results column takes the rest.
    The table absorbs height changes, and the activity panel stays 210px.
  - At 1024×720 the columns stack in reading order: header, worker, limits,
    filed issues (max 320px), then activity. The page scrolls; the document
    never scrolls horizontally (`scrollWidth === clientWidth === 1024`).
  - Every table cell fits at 1024: `implemented` is 79px inside a 79px cell
    and `v0.1.42` is 80px inside an 80px cell; no clipped labels.
  - Empty table and empty activity states are plain text with no decorative
    container; the table empty state centers in the available area.
  - Long issue titles ellipsize with a `title` tooltip; the table never
    horizontally scrolls.
  - The failed read keeps the last successful time, shows the reason in a
    full-width `role="alert"` banner, and leaves the rows in place.
  - An invalid limit shows the range sentence under the fields and sends
    nothing (covered by `verify:scout`).
  - The A2UI wireframe renders at 1440 and 390 with no horizontal overflow
    (`scrollWidth === clientWidth` at both widths).
- Not run / blocked:
  - designmd MCP research could not run because no MCP manager is configured;
    see `.design/research/2026-10-27-auto-scout.md`. No token, OpenUI, or
    Storybook mutation was made.
  - A live worker process was not left running for the screenshots; the
    populated and error states were replayed from valid `state.json` fixtures,
    and the live worker journey is covered by `verify:scout`.
- Checks:
  - `bun run check`: 0 errors, 0 warnings.
  - `bunx tsc --noEmit`: 0 errors.
  - `bun test`: 602 pass, 0 fail (46 files).
  - `bun run verify:scout`: passed.
  - `bun run verify:interface`: passed.
  - UI/UX preflight: `applicable: true`, no missing prerequisites.
- Verdict: pass.

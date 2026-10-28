# Validation — Discover / Run header

- Page: Discover → Overview (`#workspace-discover`), `section[data-testid="discover-active"]`.
- Branch: `issue-335`; commit: the revision that carries this file (merged to `main` after
  verification).
- Command: `cd .devboard && bun install --frozen-lockfile && bun run build`, then a source
  dashboard from the worktree with `PORT=8144`, `ADRS_DIR`/`REPO_DIR` inside the worktree, and
  `STATIC_DIR=<worktree>/.devboard/dist`.
- Base URL: `http://127.0.0.1:8144/`.
- Browser: OMP browser (Playwright-backed Chromium), default theme then light.
- Viewports: 1724×834 (the issue's 2101×1017 at 1.21875), 1600×1000, 1024×720. Below 1024×720 the
  app replaces the workspace with the viewport guard by design.
- Screenshots: `.devboard/.design/discover-run/shots/` (ignored by `.devboard/.design/.gitignore`).

## Journeys exercised

| Journey | Evidence |
|---|---|
| Confirm the run is alive | Clicked `Discover project`; the panel appeared with a 6px `accent` dot and `Run in progress`; the activity terminal below filled with agent output |
| Read the age | `Started just now` renders at 11px muted with the ISO clock in `title`; the existing 30s `now` tick updates it |
| Stop the run | Clicked `Stop`; the panel disappeared (`isVisible` false), no console errors or failed requests |
| Keyboard | Focused the title and pressed `Tab` once; `document.activeElement` was `[data-testid="discover-stop"]` with the 2px `ring` outline and the error hover/focus fill |
| Light theme | Switched theme; the header keeps `surface-raised`, the dot, and the muted meta with readable contrast; the Stop keeps its quiet resting style |
| Narrow pane | At 1024×720 the header is 628.89px; title, meta, and Stop all fit; `document.documentElement.scrollWidth === 1024` |

## Measurements

- Before (the issue capture, reproduced on the running dashboard): 30px tinted header,
  `accent-surface` fill `rgb(22, 35, 58)`, `accent` bottom edge, `accent` panel border, a two-line
  identity (`DISCOVER` eyebrow over `Run in progress`), and a filled `destructive` Stop whose
  28px height filled 28 of the 30 header pixels; the stop was the strongest element on the page.
- After removal at 1724: header 1110×30; title at x=625 (93.53 wide); started at x=1569.42 (84.14
  wide); Stop 41.44×24 at x=1663.56; header `scrollWidth === clientWidth === 1110`; document width
  1724. The run identifier is not rendered.
- After removal at 1024: header 628.89×30; title x=406.11, started x=844.66 (108.91), Stop x=963.56
  (41.44); no overflow at either axis.
- After header fill `rgb(28, 33, 40)` (`surface-raised`), bottom edge `rgb(48, 54, 61)`
  (`border`); Stop resting 24px/11px, `muted-foreground` text on transparent fill with a
  `border-subtle` outline. Hover/focus takes `error-surface`, `error` text, `error` outline.
- Gaps: header 12px, identity 8px, meta 10px, all on the approved 2px scale; no new spacing value.

## Console/network

- `tab.errors()` empty after start, stop, theme switch, and keyboard navigation; no failed request
  affected the panel.

## Dependent pages

- `Button` is unchanged; this header no longer uses its `destructive` variant. No design-system
  component, token, OpenUI entry, or story changed.
- The page header, discover notices, remote target panel, and the panel body are untouched.
- `bun run check` — 1674 files, 0 errors, 0 warnings. `bun test` — 600 pass, 0 fail across 46
  files. `bun run build` succeeds.

## Not run / blocked

- Missing `startedAt`: the branch is unchanged except for its position in the header; the server
  always supplies it while a run is active, so no fixture was built.
- `verify-interface.ts` drives the Discover page through a stub agent but does not assert this
  header; the browser evidence above covers the changed surface.
- Designmd MCP research: unavailable in this session (see
  `.devboard/.design/research/2026-10-27-discover-run.md`); no design-system artifact beyond the
  `DESIGN.md` component description was changed.

## Verdict

pass (with the missing-start-time branch noted as not exercised).

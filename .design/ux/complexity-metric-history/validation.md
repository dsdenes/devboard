# Metric history panel — validation

## Environment
- Built client bundle: `.devboard/dist` from this worktree (`bun run build`).
- Server: the worktree's `devboard serve` binary serving that bundle against a throwaway fixture
  repository under `.devboard/.test-tmp/smoke/`, with three copied daily snapshots (2026-11-03,
  11-04, 11-05) and its own state directory. The live dashboard on port 8080 was never touched.
- Browser: Chromium through the Playwright-backed browser tool. Views: 2101×1017 (the issue's
  viewport), 1365×768, 1024×720 (the supported floor). Themes: dark (default) and light.

## Checks
| Check | Command | Result |
|---|---|---|
| Client typecheck | `bun run check` (svelte-check, `.devboard/`) | pass — 1694 files, 0 errors, 0 warnings |
| Client unit suite | `bun test client` (`.devboard/`) | pass — 261 tests, 42 files |
| Component unit tests | `bun test client/lib/components/DevboardComplexity.test.ts` | pass — 8 tests |
| Client build | `bun run build` (`.devboard/`) | pass — `dist/assets/index-NlqYWBqG.js`, `dist/assets/index-CMeWhbKk.css` |
| DESIGN.md lint | `node_modules/.bin/design-md lint DESIGN.md` | not run — no local `@google/design.md` install; the skill preflight reported it `unverified`, everything else `pass` |

## Rendered states
| State | Viewport | Evidence | Result |
|---|---|---|---|
| Three recorded days, dark | 2101×1017 | `history-dark-2101.png` | pass — 8 rows, one axis, all rows visible (body 275/275), panel 309px, no scroll |
| Three recorded days, dark | 1365×768 | `history-dark-1365.png` | pass — body scrolls (195/275), axis pinned and visible, rule bounds the clipped row |
| Three recorded days, dark | 1024×720 | `history-dark-1024.png` | pass — 5 rows visible, axis pinned, label and value tracks intact |
| Three recorded days, light | 1365×768 | `history-light-1365.png` | pass — same layout, light token values, no hard-coded color |
| Loading / empty | — | unit test `an empty history renders the loading state…` | pass — no blank chart, one muted line; not captured in the browser because the fixture always has a snapshot |

## Measured evidence (2101×1017)
- Rows: 8 `data-testid="complexity-series"`, 1 `.complexity-series__dates`, 3 `data-date` labels.
- Chart box 1376px wide; `viewBox="0 0 1376 24"`, so the vertical scale is 1:1 and the newest point
  measures 7×7 CSS px — a circle, not the 6:1 ellipse the shipped fixed 240×48 viewBox produced.
- Axis alignment: chart track starts at x=552, first point centre x=558, first label left edge
  x=560; middle point x=1238, middle label centre x=1240; last point x=1918, last label right edge
  x=1920.
- Detail: `--accent` line and newest point, `muted-foreground` older points, no per-series frame,
  no repeated date row.

## Duplicate and glitch review
- No duplicated fact: the newest date, recording clock, and day count stay in the page header; the
  panel adds only the whole-window change and one shared date axis.
- No overlap, clipped label, empty container, scroll trap, or layout shift observed at the three
  viewports. Below 1024×720 the shell's viewport guard replaces the workspace, so no mobile layout
  is claimed.
- Focus, keyboard order, and reduced motion: the panel is read-only and adds no focusable control;
  the existing per-file sort buttons keep the 2px `ring`.
- Console and network: no console entry and no page error was recorded during the capture
  session.

## Not run
- The operator suite `.devboard/e2e` was not run: it drives every background family against the
  live Gitea with `acp-stub`, which this redesign does not touch.
- No design-system artifact was mutated, so the `designmd` MCP research gate did not apply; the
  server is not mounted in this session either way.

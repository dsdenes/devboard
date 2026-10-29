# Dependency graph widget — validation

Scope: `Dependency graph` in Discover › Overview (`MermaidDiagram.svelte`,
`DiscoverOverview.svelte`, `dependency-diagram.ts`, `app.css`) plus its `DESIGN.md` entry. No other
Discover region, Goal view, Flow view, or issue surface changes.

- Worktree/branch: `.worktree/issue-783`, branch `issue-783`, based on `origin/main` at `822d497`.
- Preflight: `bun "$(realpath skill://ui-ux)/scripts/preflight.mjs" .` → `applicable: true`;
  DESIGN.md lint 0 errors, 29 pre-existing warnings; DTCG 65 tokens; OpenUI 5 components;
  Storybook 3 stories.
- Commands, from `.worktree/issue-783/.devboard` unless noted:
  - `bun install --frozen-lockfile`
  - `bun run build` → `.devboard/dist/index.html` and hashed assets
  - `bun run check` → 1761 files, 0 errors, 0 warnings
  - `bun test` → 1079 pass, 0 fail, 6506 expect calls, 83 files
  - `bun test client` → 88 pass, 0 fail after the final component change
  - `bun run verify:design` → all twelve checks pass
  - `bun run verify:interface` → reaches and passes the Discover diagram checks, then fails at
    `scripts/verify-interface.ts:5377` on a pre-existing stale expectation (see below)

A later full-suite rerun on the same shared machine reported 1077 pass / 2 fail, and a bail run
stopped at `server/flow.test.ts` (a 20s event wait in `Flow session lifecycle > two concurrent
starts…`). Neither failure touches this change; the machine is running eighteen concurrent issue
agents and the suite writes temporary state under `/tmp`. The client test files covering this
change pass on their own.

## Interface verifier note

The verifier is failing on `main` before this change. Commit `2ab4600` (already on `main`) made the
stopped poll line read `Tracker sync starting` until the first tracker sync completes
(`poll-status.ts:62`), while the assertion added in `673d9a9` still requires `Not polling`
(`verify-interface.ts:5377`). That check runs after the Discover section, so every dependency
diagram assertion above it executed first and passed. An earlier run stopped even later, at
`verify-interface.ts:4446` (the report picking-mode hint), also after the Discover section. Both
failures are outside this change's surface.

The diagram assertions were replayed directly in the browser against the verifier's own published
fixture host: 2 nodes, 1 edge, label 12px, node radius 4px, canvas `overflow: auto`, legend text
exact, no zoom control, `canvas.scrollWidth === clientWidth` (582 = 582).

## Validation dashboard

An isolated server, never the canonical dashboard:

```text
HOST=127.0.0.1 PORT=18185
ADRS_DIR=.worktree/issue-783/adrs
REPO_DIR=.worktree/issue-783
GOAL_FILE=.worktree/issue-783/GOAL.md
STATIC_DIR=.worktree/issue-783/.devboard/dist
STATE_DIR=.worktree/issue-783/.devboard/.tmp/manual-state
DEVBOARD_UPDATE_INTERVAL_MS=3600000
bun run start
```

The retained `coollabsio~coolify` sheet was copied under `STATE_DIR` and its `architecture`
contexts/dependencies replaced between reloads, so the published read path was exercised, not an
in-memory overlay. All temporary state was removed after the run.

- Browser: OMP Playwright-backed headless Chromium. Base URLs `http://127.0.0.1:18184` (verifier
  fixture) and `http://127.0.0.1:18185` (stress sheets).
- Viewports: 1440×900, 1600×1000, 1024×720. Screenshots carry a 1.25 device scale factor; CSS
  measurements are in CSS pixels.

## States exercised

|State|Evidence|Result|
|---|---|---|
|Fits, 2 nodes|`fixture-2-nodes-dark.png`|168px graph in 582px canvas; no zoom control; no scroll; 12px labels|
|Wide, 24-context chain|`wide-24-actual-dark.png`, `wide-24-scrolled-dark.png`|Natural 4814.8px; opens at actual size; 582px canvas; `Fit width` control; horizontal scroll; page 1440 = clientWidth|
|Wide, fitted|`wide-24-fit-dark.png`|Explicit fit: 565.9px graph, no scroll, `Actual size` control; labels small by the reader's choice|
|Tall, 48 contexts / 8 chains|`tall-48-dark.png`, `tall-48-light.png`|Natural 734×400 at 1600; canvas 742×398 after a readable fit; no zoom control; vertical scroll (scrollHeight 411); page does not scroll|
|Wide at 1440|stress chain|Actual size, canvas 582, scrollWidth 4823, two-axis scroll, tab stop 0|
|Narrow 1024|`narrow-1024-focus-dark.png`|Card 613px; doc 1024 = clientWidth; legend 258px and 24px zoom control on one row; canvas focus ring 2px `ring`|
|Keyboard|stress chain|Canvas focused, `ArrowRight` moved `scrollLeft` to 40|
|Theme switch|`wide-24-actual-light.png`, `tall-48-light.png`|Light node fill `#ffffff`, stroke `#6e7781`, label `#1f2328`; dark `#1c2128`, `#6e7681`, `#e6edf3`; manual zoom choice survives a theme redraw|
|Resize|48-context graph at 1440 → 1600|Automatic mode switched from actual to fit when the fit scale crossed 0.9; no control remained|
|No edges / unknown|unit coverage + render guard; not browser-triggered|No block; the surrounding card stays|
|Render failure|component path; not triggered|One `.empty` line; the canvas is cleared|

## Measurements

- 24-context chain: SVG 4814.8×150.5, canvas 582×166, `scrollWidth 4823`; actual mode sets
  `width: 4814.81px; max-width: none`. Fit mode sets `width: 100%` and `max-width` to the natural
  width, so it shrinks only to the canvas.
- 48-context graph: canvas `max-height` computed 360px at 900px viewport and 400px at 1000px
  (`clamp(220px, 40vh, 400px)`); it scrolls inside rather than growing the card.
- Node geometry: computed `rx: 4px`, 1px `border-strong`; edge stroke `rgb(139, 148, 158)` in dark.
- Label: computed 12px, weight 500, foreground; measured `labelSize` 12 in the verifier fixture.
- No page-level horizontal overflow at 1024 or 1440 (`documentElement.scrollWidth === clientWidth`).
- Console/network: not captured for this widget-only change; the page loaded and rendered each
  state without a visible failure.

## Duplicate and redundancy check

- No context or edge counts are rendered; the nodes and edges are the count.
- The legend states arrow direction once. The `Dependency direction` role row above states the
  project's specific rule; the legend does not repeat it.
- Context names, responsibilities, and entry points stay in the context list; the graph does not
  repeat them.
- The zoom control appears only when a fit would fall below the readable scale; a readable graph
  carries no extra control.

## Spacing and token audit

- New layout values: 4, 8, 24, and 28px, all on the approved scale, plus the documented canvas
  height cap `clamp(220px, 40vh, 400px)` (component geometry, recorded in `DESIGN.md`).
- No new color, type size, radius, shadow, gradient, or animation. Colors come from `background`,
  `surface-raised`, `foreground`, `muted-foreground`, `border-subtle`, `border-strong`, and `ring`.
- No DTCG, OpenUI, or Storybook change: the widget composes the shipped chart library and tokens.

## Accessibility and interaction

- Canvas: `role="group"`, name `Dependency graph canvas`; the drawing keeps `role="img"` and its
  label. It enters the tab order only while it scrolls; a fitted graph adds no tab stop.
- Focus ring: 2px `ring` with 1px offset, not clipped by the canvas overflow.
- Zoom control: ghost 24px button with an action-specific `aria-label`; the word carries the state.
- Arrow keys scroll the focused canvas. No motion is added; no focus trap is introduced.

## Findings and fixes during validation

1. The first build shrunk even a six-node graph to 68% because the SVG was always `width: 100%`.
   Fixed by measuring the natural width and opening at actual size when the fit would fall below
   0.9.
2. The toggle initially appeared for an 8px width difference. Tied its visibility to the same
   readable-scale rule, so a graph that fits readably carries no control.
3. `tabindex="0"` on the canvas produced an a11y compiler warning and added a tab stop to every
   graph. The canvas now sets its own tab stop only while it scrolls.
4. A fit chart could paint once at the wrong scale before the effect ran. Sizing is now applied
   synchronously after the SVG insertion as well as on mode change.

## Artifacts updated for consistency

- `.design/ux/discover-dependency-graph/`: brief, content inventory, significance, structure,
  component requirements, this validation, and the screenshots.
- `.design/a2ui/discover-dependency-graph.{a2ui.jsonl,wireframe.html}`: widget-level structure and
  its neutral wireframe.
- `.design/research/2026-10-29-discover-dependency-graph.md`: research receipt and the missing
  `designmd` MCP note.
- `.design/ux/discover-bounded-contexts/`: corrected the pre-schema claims about a missing edge
  list and diagram.

## Not run

- A live-model Discover crawl. The change is presentational; the deterministic stub and retained
  sheets publish schema-valid data, and the crawl rules are untouched.
- Storybook. No OpenUI primitive, story, or DTCG token changed.
- Mobile layout. The interface has no mobile shell below 1024×720.

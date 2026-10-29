# Dependency graph — component requirements

Scope: `MermaidDiagram.svelte`, the `Dependency graph` sub-block in `DiscoverOverview.svelte`, the
`dependencyChart` builder and its `diagramMode` rule. No other Discover region changes.

## Presentation

- The sub-block keeps its `h3` `Dependency graph` overline. The widget adds one 11px
  `muted-foreground` legend: `Arrows point from a context to the context it uses.`
- The canvas is `background` with a 1px `border-subtle`, 4px radius, 8px padding, and
  `max-height: clamp(220px, 40vh, 400px)`. It owns both scroll axes. It is a tab stop only while
  `scrollWidth`/`scrollHeight` exceed its client box, and its focus ring is the shared 2px `ring`.
- The zoom control is a 24px ghost button in the bar above the canvas. It reads `Actual size`
  while fitted and `Fit width` while at actual size. It renders only while a fit would fall below
  the readable scale.
- Nodes use Mermaid's rounded shape, styled with a 4px radius, `surface-raised` fill, 1px
  `border-strong` outline, and 12px foreground label at weight 500. Edges and arrowheads use
  `muted-foreground`. Mermaid spacing is 16px node / 28px rank / 8px padding.
- Light and dark both read their colors from the shipped theme variables at render time; a theme
  change redraws the graph.

## Sizing rule

- Measure the natural graph width from the SVG's `max-width` (fallback: its `viewBox` width) and
  the canvas's available inner width.
- A graph fits only while `available / natural >= 0.9` (12px labels never render below 10.8px).
  Otherwise it opens at actual size: `width = natural`, `max-width: none`, inside the scrolling
  canvas.
- An explicit `Actual size` / `Fit width` choice always wins. It resets to automatic when the
  chart changes, not on a theme redraw or a canvas resize.
- A canvas resize re-measures and re-evaluates the automatic mode. A manual choice persists.
- Changing modes resets the canvas scroll to the top-left.

## Data variety to survive

- 0 contexts, 1, 2, 24 contexts; chains, fans, cycles, and isolated nodes.
- 0 edges: no graph. Unknown dependencies: no graph.
- Long context names (up to the sheet's leaf limit); quotes and hostile Mermaid syntax.
- A graph narrower than the canvas, one that overflows horizontally, and one that overflows
  vertically beyond the cap.
- 1440×900 and 1024×720; dark and light themes.
- A repeated render after `data-theme` changes; a new chart for a different project.

## Accessibility

- The canvas exposes `role="group"` with the name `Dependency graph canvas`; the drawing inside
  keeps `role="img"` and the `label` prop as its accessible name.
- Keyboard focus reaches the canvas only when it scrolls; arrow keys scroll it.
- The zoom control carries an action-specific `aria-label`; color never carries the fitted state,
  the button's word does.
- No motion is added.

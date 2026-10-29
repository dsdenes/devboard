# Dependency graph — structure

|State|Structure|
|---|---|
|Default, graph fits|Legend line, graph canvas, no zoom control; whole graph visible at 12px labels|
|Wide graph, auto|Legend line, `Fit width` control; canvas opens at actual size with two-axis scroll|
|Wide graph, fitted|Legend line, `Actual size` control; whole graph visible, labels scaled with the graph|
|Tall graph|Canvas capped at `clamp(220px, 40vh, 400px)` and scrolls vertically; no page scroll|
|No edges|Block absent; the context list and role rows remain|
|Unknown dependencies|Block absent; the card's unknown note remains|
|Render failure|Empty line: `The dependency diagram could not be rendered.`|
|Loading|The page-level run region owns loading; the block stays absent until the sheet publishes|
|Partial data|Invalid or stale edges are filtered by `dependencyEdges`; valid nodes and edges still draw|
|Permission denied|Not applicable; the dashboard has no per-region permission model|
|Success|The published sheet is the success state; no toast or badge inside the block|

## Layout

- The block sits after the context list and boundary role rows, at the card's full body width.
- A 24px bar holds the legend on the left and the optional zoom control on the right, 8px apart.
  The legend never truncates; the control never shrinks.
- The canvas is level 0: `background` fill, 1px `border-subtle`, 4px radius, 8px padding.
- Nodes are level 2 rounded rectangles: `surface-raised` fill, 1px `border-strong` outline, 4px
  radius, 12px label at weight 500.
- Edges and arrowheads are `muted-foreground`; no edge labels or decorations.
- Fitted graphs centre in the canvas; actual-size graphs start at the top-left so scrolling
  exposes every node.

## Why this structure

- **Readability over a universal fit.** The shipped diagram always shrank to the column. A wide
  graph then drew 12px labels at a few pixels, so the graph was present but unreadable. The canvas
  now opens at actual size when a fit would take the labels below 0.9 of their drawn size.
- **A bounded canvas, not a growing card.** The graph can be thousands of pixels wide or tall; a
  cap plus internal scroll keeps the card and the page stable.
- **One control, not a toolbar.** The reader has one choice: see the shape or read the labels. A
  ghost control toggles between the two and disappears when there is no difference.
- **A legend, not a title.** The heading already says `Dependency graph`; the useful new sentence
  is the arrow direction.

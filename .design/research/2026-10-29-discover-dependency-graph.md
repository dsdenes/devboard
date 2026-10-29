# Design research receipt — Discover dependency graph

Date: 2026-10-29
Scope: `MermaidDiagram.svelte`, the dependency graph sub-block in `DiscoverOverview.svelte`, the
`dependencyChart` builder, and their styles in `.devboard/client/app.css`. Read-only research;
nothing was uploaded or downloaded.

## Calls

The `designmd` MCP server is not exposed in this run's tool set, so no `search_design_kits` or
`get_design_kit` call could be recorded. No DESIGN.md token, DTCG entry, OpenUI component, or
Storybook story changes in this work, so the design-system mutation gate does not apply; the change
is widget-level composition. The project's existing research receipts
(`.design/research/2026-10-26-discover-bounded-contexts.md`, `-discover-redesign.md`) remain the
research record for the surrounding Discover surface.

## Constraints carried from the existing design system

- Dense operator console: 11–13px type, 1px borders, depth from `background` → `surface` →
  `surface-raised`, 4px radius on functional surfaces, no shadows or gradients.
- `muted-foreground` for supporting text and non-interactive structure; `foreground` for content;
  `border-strong` for a control or container edge that must read against a surface.
- `flow-dependency` is the one teal reserved for dependency semantics in the Flow map; the
  Discover graph does not introduce a new hue and carries direction with an arrow plus a word.
- The shell owns scroll per panel; a widget with unbounded content caps itself and scrolls inside.

## Adopted

- A bounded canvas (level 0) with an internal scroll, so the card and page never grow with the
  graph.
- Rounded `surface-raised` nodes with a `border-strong` outline; the node is the content, not a
  decorative card.
- `muted-foreground` edges with matching arrowheads, so labels and nodes carry the visual weight.
- A single worded legend for arrow direction; no legend key or color coding.

## Rejected

- Shrinking every graph to the column: the shipped behavior that made 12px labels unreadable.
- A fixed zoom toolbar with percentages: one fit/actual choice serves the two declared goals; more
  controls compete with the graph.
- A dependency matrix: the sheet records a sparse directed graph, and a matrix replaces the shape
  the crawl evidences with a table the card already avoids.
- Recoloring edges by dependency kind: the sheet has no edge kinds, so any color would be invented.

# Dependency graph widget — brief

## Page identity

- Route: `/` in Discover mode, Overview tab, inside the `Bounded contexts` card.
- Title: `Dependency graph`, under the card's context list and role rows.
- Auth/role: none; the shipped dashboard has no per-region permission model.
- Entry points: Discover overview after a crawl; a retained remote project; re-discovery.
- Read-only: the widget draws the sheet; it edits nothing.

## Primary goal

Read the recorded context-to-context dependencies and know which way each import points. The
observable success signal: the reader can name an edge as "this context uses that context" without
hovering, clicking, or guessing an arrow direction.

## Secondary goals

- See the whole topology at a glance when it fits.
- Read every context label at its drawn type size when the graph does not fit.

They support the primary goal; the readable graph is never traded for an overview that cannot be
read.

## Arrival context

- The reader has just crawled the repository or reopened a published sheet and is scanning for
  orientation.
- They know the repository's modules, not necessarily the crawler's graph vocabulary.
- Partial data is normal: the crawl may record no edges, an unknown graph, or many isolated
  contexts.
- Desktop only: the shell requires at least 1024×720.
- The card sits in a 583–744px column on the supported widths, so a graph is usually wider than
  the column.

## Relationship to other pages

- Upstream: the Discover run and `architecture.dependencies` in `sheet.json`.
- Sibling: the context list and boundary role rows in the same card; the graph adds edges, it
  does not repeat responsibilities or entry points.
- Downstream: the glossary is grouped by the same context names.

## User journeys

### Journey 1 — Read the dependency direction

1. Trigger: open Discover › Overview after a crawl.
2. Find the `Dependency graph` block under the context list.
3. Read the arrow legend, then follow one arrow from a context to the context it uses.
4. Decision point: does the arrow point the way the reader expected?
5. Success: the reader knows which context may import the other.
6. Failure: the graph is unknown or absent; the page keeps the surrounding card readable.
7. Recovery: re-discover; inspect the recorded dependency direction sentence.
8. Exit: proceed with the change, or raise the coupling.

### Journey 2 — Read a graph wider than the card

1. Trigger: the crawl records many contexts or a long chain.
2. The block opens at actual size; the canvas shows the left edge and scrolls both ways.
3. The reader scrolls or uses arrow keys to reach a node.
4. Decision point: read one edge, or take the whole shape in.
5. Success: labels stay at their drawn size; arrows remain traceable.
6. Failure: the reader wants the overview; the `Fit width` control returns the whole graph.
7. Recovery: `Actual size` returns to readable labels.
8. Exit: leave the block, or scroll on.

### Journey 3 — Empty or unknown graph

1. Trigger: a sheet with `dependencies: []`, or an unknown dependencies leaf.
2. No block renders; the context list and role rows carry the card.
3. Success: absence never reads as a fabricated graph.
4. Failure: a stale sheet draws an invalid edge; the client filters it and keeps the rest.
5. Exit: re-discover, or rely on the observed groups only.

## Non-goals

- Editing contexts, edges, or the direction rule.
- Inventing an edge the sheet does not record.
- Per-edge labels, weights, or evidence in the graph.
- Replacing the context list, boundary roles, or glossary.
- Mobile layout below the supported 1024×720 shell.

## Assumptions

- `architecture.dependencies.value` is a list of `{ from, to }` records, each endpoint naming a
  context in the same sheet; the server rejects anything else.
- The crawler sorts edges canonically; the graph preserves the node order the chart builder gives
  it.
- The card width is between roughly 580 and 750 CSS pixels on the supported viewports.

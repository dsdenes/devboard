# Bounded contexts widget — content inventory

Candidates come from `sheet.architecture` and from the shipped widgets. Journeys refer to
`brief.md`. The test: removing this item must not remove a declared decision.

The sheet's architecture reaches Discover as three widgets: the `Bounded contexts` list card, the
`External boundaries` card, and the `Shared kernels` card. The inventory records what those widgets
render; A3 and A7 are candidates the interface dropped, each naming the issue that removed it.

|ID|Information|Source|Journey|Enables decision/action|Keep?|Reason|
|---|---|---|---|---|---|---|
|A1|Context name|`architecture.contexts[].name`|1, 2|Place the change in a domain area|yes|The primary label; nothing else names the area|
|A2|Context responsibility|`architecture.contexts[].responsibility`|1|Confirm the match between requirement and context|yes|Without it a name is a guess|
|A3|Context path|`architecture.contexts[].path`|1, 2|Open the code|no|Removed by #230: the card renders name, responsibility, and entry-point chips only|
|A4|Context entry points|`architecture.contexts[].entryPoints`|1|Know which files or directories to read first|yes|The only locator the card renders; chips under the responsibility|
|A5|Shared kernels|`architecture.sharedKernels`|2|Decide whether code is shared deliberately|yes|One `Shared kernels` card in the rail, one chip per kernel|
|A6|External boundaries|`architecture.externalBoundaries`|2|Know which outside systems the change crosses|yes|One `External boundaries` card in the rail, one chip per system|
|A7|Dependency direction|`architecture.dependencyDirection`|2|Know which way an import may point|no|Removed by #1091 with the dependency-direction fact row; no Discover widget renders it|
|A8|Unknown reason per boundary group|leaf `reason`|4|Tell missing observation from real absence|yes|Each boundary card states its own reason in place of chips; absence must not read as "none exists"|
|A9|"None detected." chip per empty group|`leafLines([])`|2|—|no|Empty arrays already mean none; each boundary card states its own emptiness in one line|
|A10|Two symmetric group boxes|shipped layout|2|—|no|Equal boxes imply equal weight; each boundary group is its own card with its own header|
|A11|Context count in the card header|derived|1|—|no|The list is the count; already scored P3 in the page inventory (C46)|
|A12|Four-column context table|shipped layout|1|—|no|A narrow table squeezes responsibility and entry points into ellipses and wraps|
|A13|Evidence chips per value|leaf `evidence`|2|Verify a claim|no|Not rendered by any sibling card; changing that is a page-level decision, not this widget's|
|A14|Confidence badge on the card|leaf `confidence`|4|Weigh trust|no|The leaves disagree (observed vs inferred); one badge would misstate some of them|
|A15|Context-to-context edges|`architecture.dependencies`|2|Know which way imports point|no|The sheet records the edges, but #2ee5ffb6 dropped the dependency graph widget, so nothing draws them|
|A16|Glossary term counts per context|glossaries|1, 2|—|no|Glossary owns this; duplication would drift|
|A17|Ordering of contexts by name|schema canonical order|1|Scan predictably|yes|Keep the crawler's canonical order; no re-sorting in the view|

## Conflicts and resolutions

- **Empty group text.** An unknown leaf renders its reason in place of the chips. An observed
  empty list renders the card's own line: `None detected.` for external boundaries and
  `No shared kernel was detected.` for shared kernels. Neither fabricates a value.
- **Path vs entry point.** The path lost its own element to #230, so entry-point chips are the
  only locator the card renders. A chip that repeats the recorded path is kept, because no other
  element would show it.
- **Grouping.** Kernels and external systems are group-level facts about the sheet, not per-context
  values: each is its own rail card, and neither is nested inside a context row.

## Duplicate check

- A4 is the only locator: A3 is absent from every widget (#230), so no path element repeats a
  chip.
- A5 and A6 each appear once, in their own card; A7 has no card (#1091).
- A1 also names glossary contexts, but on a different page and for a different decision; not
  duplicated inside this widget.

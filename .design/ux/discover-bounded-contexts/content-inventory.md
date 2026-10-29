# Bounded contexts widget — content inventory

Candidates come from `sheet.architecture` and from the shipped card. Journeys refer to
`brief.md`. The test: removing this item must not remove a declared decision.

|ID|Information|Source|Journey|Enables decision/action|Keep?|Reason|
|---|---|---|---|---|---|---|
|A1|Context name|`architecture.contexts[].name`|1, 2|Place the change in a domain area|yes|The primary label; nothing else names the area|
|A2|Context responsibility|`architecture.contexts[].responsibility`|1|Confirm the match between requirement and context|yes|Without it a name is a guess|
|A3|Context path|`architecture.contexts[].path`|1, 2|Open the code|yes|The only locator for the context|
|A4|Context entry points|`architecture.contexts[].entryPoints`|1|Know which files or directories to read first|yes|Distinguishes the public seam from the rest of the path|
|A5|Shared kernels|`architecture.sharedKernels`|2|Decide whether code is shared deliberately|yes|Directly answers "may another context import this?"|
|A6|External boundaries|`architecture.externalBoundaries`|2|Know which outside systems the change crosses|yes|Names the coupling the card exists to expose|
|A7|Dependency direction|`architecture.dependencyDirection`|2|Know which way an import may point|yes|The rule that makes the other groups actionable; currently never rendered|
|A8|Unknown reason per boundary group|leaf `reason`|4|Tell missing observation from real absence|yes|Absence must not read as "none exists"|
|A9|"None detected." chip per empty group|`leafLines([])`|2|—|no|Empty arrays already mean none; the chip is noise and was the shipped ugliness|
|A10|Two symmetric group boxes|shipped layout|2|—|no|Equal boxes imply equal weight; empty boxes dominate the card|
|A11|Context count in the card header|derived|1|—|no|The list is the count; already scored P3 in the page inventory (C46)|
|A12|Four-column context table|shipped layout|1|—|no|A narrow table squeezes responsibility and entry points into ellipses and wraps|
|A13|Evidence chips per value|leaf `evidence`|2|Verify a claim|no|Not rendered by any sibling card; changing that is a page-level decision, not this widget's|
|A14|Confidence badge on the card|leaf `confidence`|4|Weigh trust|no|The leaves disagree (observed vs inferred); one badge would misstate some of them|
|A15|Context-to-context edges|`architecture.dependencies`|2|Know which way imports point|yes|The later schema records observed edges; the dependency graph widget draws them|
|A16|Glossary term counts per context|glossaries|1, 2|—|no|Glossary owns this; duplication would drift|
|A17|Ordering of contexts by name|schema canonical order|1|Scan predictably|yes|Keep the crawler's canonical order; no re-sorting in the view|

## Conflicts and resolutions

- **Empty group text.** `leafLines([])` yields "None detected." while an unknown leaf yields a
  reason. Winner: an unknown group carries its reason; an observed empty group renders no group at
  all, and a single card line covers the all-empty case. Neither fabricates a value.
- **Path vs entry point.** The crawl may record the context path as its only entry point. Winner:
  the path line; an entry point equal to the path is not repeated as a chip.
- **Count vs list.** The shipped subtitle counts contexts. Winner: the list; the count is dropped.

## Duplicate check

- A3 appears once per context as the locator; A4 never repeats A3 after the equality filter.
- A5, A6, A7 each appear once, in one role row per group.
- A1 also names glossary contexts, but on a different page and for a different decision; not
  duplicated inside this widget.

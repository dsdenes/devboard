# Bounded contexts widget — structure

The sheet's architecture reaches the Discover Overview as three cards: the `Bounded contexts` list
card in the main column, and the `External boundaries` and `Shared kernels` cards in the facts rail
beside it. The page frame, the other Discover cards, and the rail are unchanged.

## Regions and order

|Order|A2UI ID|Region|Journey|Items|Priority|
|---|---|---|---|---|---|
|1|region_contexts_card|`Bounded contexts` card, main column, last card: one stacked row per context|1, 2|A1 A2 A4|P0|
|2|region_contexts_empty|Missing or empty context state inside the same card|4|A8|P1 conditional|
|3|region_external_boundaries_card|`External boundaries` card in the facts rail: one chip per outside system|2|A6 A8|P1|
|4|region_shared_kernels_card|`Shared kernels` card in the facts rail: one chip per shared kernel|2|A5 A8|P1|

A context row is a stacked unit, not a grid row: the name on the first line, the responsibility on
the second, the entry-point chips on a third. Rows are separated by a hairline; there is no table
header and no column grid, so long responsibilities never collide. The card renders no per-context
path (#230) and no dependency-direction row (#1091).

The two boundary cards sit in the rail below `Stack`. Each owns its header, an optional count
subtitle, a chip list, its unknown-reason line, and its own empty line. A boundary card renders
whenever the sheet carries its leaf, observed or unknown.

Visual order at wide width is the facts rail on the left (Platform, Delivery, Stack, then the two
group cards) and the wide main column on the right, whose last card is the context list. When the
sheet collapses to one column, the rail cards come first and the context list follows them.

## State coverage

|State|Structure|
|---|---|
|Default (observed)|Context rows with name, optional responsibility, optional entry-point chips; each boundary card renders one chip per value and a count subtitle|
|Empty (no contexts)|`No bounded context was detected.` in place of the list; the boundary cards are unaffected|
|Unknown contexts|The contexts leaf's reason replaces the list; the boundary cards are unaffected|
|Empty boundaries|The `External boundaries` card renders `None detected.`; the `Shared kernels` card renders `No shared kernel was detected.`|
|Unknown boundaries|The affected card renders its leaf's reason in place of chips; the other card is unaffected|
|Partial row|A context with no responsibility or no entry points renders its name alone|
|Missing boundary leaf|That boundary card is absent; the other cards still render|
|Missing section|No architecture card renders, as shipped; the page already omits an absent section|
|Loading|The page-level run region owns loading; these cards stay absent until the sheet publishes|
|Error|The page-level error owns failure; the last published cards stay readable|
|Permission denied|Not applicable: the dashboard has no per-region permission model|
|Success|The published sheet is the success state; no toast or badge inside a card|

## Responsive order

- Wide workspace: the sheet is two columns. The facts rail is the narrow left column (320–420px),
  holding Platform, Delivery, Stack, External boundaries, and Shared kernels in that order; the
  main column is the wide right column, holding Commands, Testing, Quality gates, and Bounded
  contexts in that order.
- 1240px and narrower: the sheet collapses to one column. Both column wrappers become
  `display: contents`, so the cards flow in document order — rail cards first, then the main
  column's cards. Chip lists wrap; long responsibilities use the full width.
- There is no mobile layout below 1024×720; the shell is replaced by the viewport guard.

## Primary action

None. The cards are read-only; the page keeps exactly one filled action in its header. The widget
adds no control, so focus order and keyboard paths in the shell are unchanged.

## Rationale

- **List beats table.** In the shipped four-column table at a 630px card width, responsibility and
  entry points wrapped into two or three lines while the header consumed a row; scanning a name
  meant reading across the grid. Stacked rows put the name first and let the explanation use the
  full width. Selected over the alternative of two-column context tiles: tiles lose density above
  four contexts and make responsibilities ragged.
- **One card per boundary group beats role rows.** Kernels and external systems are group-level
  facts, not per-context values. Two identical boxes inside the context card implied equal,
  isolated status; a separate card per group gives each its own header, count, chip list, and
  empty or unknown line, and a missing leaf removes one card instead of a row inside another.
- **No diagram.** The sheet records context-to-context edges, but #2ee5ffb6 dropped the dependency
  graph widget and nothing in Discover draws them. A graph would have to invent edges the crawl
  did not observe.
- **Removed: the context path.** #230 dropped the per-context path chip; entry-point chips are the
  locator the card renders.
- **Removed: the dependency direction.** #1091 dropped the direction fact row; the sheet still
  carries the value, and restoring it as a rendered fact is a page-level decision, not this
  widget's.
- **Rejected: keep the table and restyle it.** Styling the table cannot fix column pressure at the
  supported minimum width, and it preserves the header row as a second naming layer.
- **Rejected: a count in the header.** The list is the count; the page inventory already scored
  the count P3.
- **Rejected: empty-state boxes per group.** A box that only says "Not observed." occupies more
  attention than the observed data; one line per card is the honest minimum.

# Bounded contexts widget — structure

The widget replaces the body of the existing architecture card. It stays in the main column of the
Discover Overview, sixth region of the page; the page frame, cards around it, and rail are
unchanged.

## Regions and order

|Order|A2UI ID|Region|Journey|Items|Priority|
|---|---|---|---|---|---|
|1|region_contexts|Context list, each row one bounded context|1, 2|A1 A2 A3 A4|P0|
|2|region_contexts_empty|Missing or empty context state|4|A8|P1 conditional|
|3|region_boundary_map|Role rows: shared kernels, external boundaries, direction|2|A5 A6 A7|P1|
|4|region_boundary_unknown|One line naming groups the crawl did not observe|4|A8|P1 conditional|

A context row is a stacked unit, not a grid row: name and path share the first line, responsibility
the second, entry-point chips a third. Rows are separated by a hairline; there is no table header
and no column grid, so long responsibilities and paths never collide.

The boundary map is a definition list of role rows. Each role label owns its items; items are
chips for the two string lists and a sentence for the direction. The map is separated from the
context list by a hairline and starts with the roles that describe what a context may touch,
ending with the rule that governs the direction.

Reading order: what exists → what is shared → what is outside → which way imports may point.

## State coverage

|State|Structure|
|---|---|
|Default (observed)|Context rows, then the role rows that carry values; empty observed groups are omitted|
|Empty (no contexts)|`No bounded context was detected.` in place of the list; the boundary map still renders if it carries values|
|Empty (no boundaries)|Context rows, then the dependency-direction row alone; observed-empty groups are omitted rather than shown as empty boxes|
|Missing section|The card is absent, as shipped; the page already omits an absent section|
|Unknown group|The known rows render; one line names the unknown groups and the crawl's reason; the reason is stated once, not per group|
|Unknown contexts|The reason replaces the list; boundary rows still render|
|Partial values|Only observed, non-empty groups render; no placeholder row per empty group|
|Loading|The page-level run region owns loading; this card stays absent until the sheet publishes|
|Error|The page-level error owns failure; the last published card stays readable|
|Permission denied|Not applicable: the dashboard has no per-region permission model|
|Success|The published sheet is the success state; no toast or badge inside the card|

## Responsive order

- Wide workspace: one stacked card in the main column, unchanged order; role labels take a fixed
  104px label column, as the shipped fact lists do.
- 1024×720: the page collapses to one column; the card keeps its order. Role labels keep the
  104px column; chips wrap; a context head wraps name and path onto two lines when needed.
- There is no mobile layout below 1024×720; the shell is replaced by the viewport guard.

## Primary action

None. The card is read-only; the page keeps exactly one filled action in its header. The widget
adds no control, so focus order and keyboard paths in the shell are unchanged.

## Rationale

- **List beats table.** In the shipped four-column table at a 630px card width, responsibility and
  entry points wrapped into two or three lines while the header consumed a row; scanning a name
  meant reading across the grid. Stacked rows put the name first, the locator beside it, and let
  the explanation use the full width. Selected over the alternative of two-column context tiles:
  tiles lose density above four contexts and make responsibilities ragged.
- **Roles beat symmetric group boxes.** Two identical boxes for kernels and boundaries implied an
  equal, isolated status and produced two empty boxes with "None detected." on the shipped fixture.
  A labeled role list shows exactly the groups that exist, states a missing group in one line, and
  lets the dependency direction join them as the rule that binds the groups.
- **No diagram in this list.** The role list carries no mapping from a boundary to a context, so
  a graph beside it would have to invent those edges. The observed context-to-context edges are
  drawn by the separate dependency graph widget below the role list. A role list states exactly
  what the crawl observed.
- **Dependency direction promoted.** It was present in the sheet and rendered nowhere. It is the
  sentence that turns the group list into a decision about where a change belongs.
- **Rejected: keep the table and restyle it.** Styling the table cannot fix column pressure at the
  supported minimum width, and it preserves the header row as a second naming layer.
- **Rejected: a count in the header.** The list is the count; the page inventory already scored
  the count P3.
- **Rejected: empty-state boxes per group.** Two boxes that only say "Not observed." occupy more
  attention than the observed data; one line is the honest minimum.

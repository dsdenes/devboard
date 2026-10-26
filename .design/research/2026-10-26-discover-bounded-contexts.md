# Design research receipt — bounded contexts widget

Date: 2026-10-26
Scope: `.devboard/client/lib/components/DiscoverOverview.svelte` architecture card and its styles in
`.devboard/client/app.css`. Read-only research; nothing was uploaded or downloaded.

## Calls

- `designmd.search_design_kits` with `dense dark developer console data table`,
  `architecture diagram boundaries grouped data`, `developer tool dark dashboard`,
  `information dense enterprise`, `dense`, and `dashboard` + tag `devtools`.
  Several literal queries returned `[]`; the tag search and `dense` returned kits.
- `designmd.list_popular_kits` and `designmd.list_tags` to confirm the service was reachable.
- `designmd.get_design_kit` for `chef/violet-issue` and `chef/octo-code`.

## Relevant findings

- **Violet Issue** (dense devtools): row-based lists instead of card grids for repeated records,
  identifiers in mono against sentence-case titles, group headers at 11px uppercase, no visible
  row borders except hairlines, and status meaning always carried by text. Source:
  https://designmd.ai/chef/violet-issue
- **Octo Code** (GitHub-dark): depth from `background` → `surface` → `surface-raised` rather than
  shadow, mono for every identifier and path, one accent reserved for interactive elements, and
  compact single-line metadata rows. Source: https://designmd.ai/chef/octo-code

## Adopted

- Keep the repeated record (a bounded context) on its own row with the name in sentence case and
  the locator in mono, following both kits' list treatment.
- Keep depth and grouping to existing borders and surfaces; add no shadow, tint, or new color.
- Keep the role labels as uppercase micro-labels, which both kits use for group headers.

## Rejected

- Chip-heavy boundary boxes: both kits use chips for attributes, not for prose-valued groups; the
  role label plus plain values reads better for a direction sentence.
- Any diagram or connector language: neither kit supplies a non-fabricating pattern for edges the
  data does not contain.
- New accent colors per role: the project reserves color for state, and boundaries have no state.

## Mutation

No DESIGN.md token, DTCG file, OpenUI entry, or Storybook story changes. The change is page-level
composition only; this receipt exists because the card's presentation is being reworked.

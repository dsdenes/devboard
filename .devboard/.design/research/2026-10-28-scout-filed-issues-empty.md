# Design research — Filed issues empty state (2026-10-28)

- **Task:** Redesign the Auto Scout table's empty state (issue #284, selected element
  `div.scout-issues__empty` inside the Filed issues panel) so an empty results area reads as a
  deliberate state instead of two short lines floating in a 590px panel.
- **MCP status:** no MCP manager is configured in this session (`mcp://` reports none), so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No design-kit value
  was invented or imported. This receipt records the limitation rather than claiming research
  that did not happen.
- **Sources of truth used instead:** `DESIGN.md`, `design/tokens.json`, `openui.json`, the
  shipped `.devboard/client/app.css`, the shared `.panel`/`.badge`/`.empty` primitives, the
  existing empty states (`.issues-agents-empty`, `.discover-empty`, `.goal-empty-state`), the
  Lucide icon usage in `ActivityBar.svelte` and `FeedbackOverlay.svelte`, `scripts/verify-scout.ts`,
  and the rendered interface at 2101×1017 and 1024×720 in both themes.
- **Observed problem:** the old block was left-aligned and vertically centered in a 1320×590
  region, with a 12px title and one muted line. At 2101×1017 it read as stranded content, and the
  title was smaller than every other empty-state title in the interface.
- **Direction adopted from the existing system:** one compact stack centered on both axes, a
  decorative 20px muted Lucide inbox mark, a 13px/600 title matching `.issues-agents-empty__title`
  and `.discover-empty h2`, and one 12px muted line. The stack is capped at 360px with 24px 16px
  padding. No frame, fill, shadow, or action is added: the panel header owns the count and the page
  header owns Start/Stop.
- **Rejected:** a full-width strip or banner (the page already has no banner and the region is
  large), a second Start control in the empty state (duplicates the page's single primary action),
  repeating the filing limits (the side rail already states them), a dashed or tinted container
  (adds a container without information), and new tokens or a shared component (one consumer).
- **Effect on DESIGN.md / tokens / components:** no token, DTCG, OpenUI, or Storybook change. The
  local `.scout-issues__empty` composition is documented as one DESIGN.md component bullet. The
  Auto Scout A2UI structure and component requirements are synchronized with the new copy and
  composition.

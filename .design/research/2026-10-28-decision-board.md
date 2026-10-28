# Design research — Decision board header (2026-10-28)

- **Task:** Redesign the Flow Decision board header (issue #351) within the existing devboard
  design system: title, board state, and Save.
- **MCP status:** no MCP manager is configured in this session (`mcp://` reports none), so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No design-kit value
  was invented or imported. This receipt records that limitation rather than claiming research
  that did not happen.
- **Sources of truth used instead:** `DESIGN.md`, `design/tokens.json`, `openui.json`, the
  shipped `.devboard/client/app.css`, the Flow goal header precedent (issue #260), and the
  rendered interface.
- **Observed problem:** the 30px panel header holds a two-line identity (12px title over an
  11px state) while a 28px Save top-aligns. The state is bare text with no shape, and the empty
  state shows a disabled blue primary Save, so the unavailable control reads as the surface's
  main action.
- **Direction adopted from the existing system:** one identity line (18px `section-title` plus a
  labeled status badge), a 44px header for a page-leading editor surface, 12px horizontal
  padding, and Save filled only while the draft is unsaved and neutral while unavailable.
- **Rejected:** keeping the two-line identity (the crowding the issue reports), a new token or
  component (the badge and button already exist), moving state into the editor (separates it
  from the action it explains), and adding an error state (the Flow notice region owns errors).
- **Effect on DESIGN.md / tokens / components:** tokens, DTCG, OpenUI, and Storybook are
  unchanged. Only the Decision board header composition and its documented description change;
  no shared component API is modified.

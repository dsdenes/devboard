# Design research — Flow goal header (2026-10-27)

- **Task:** Redesign the Flow overview's goal header (issue #260) within the existing
  devboard design system: title, goal state, create/recreate, and save.
- **MCP status:** no MCP manager is configured in this session (`mcp://` reports none),
  so `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No
  design-kit value was invented or imported. This receipt records that limitation
  rather than claiming research that did not happen.
- **Sources of truth used instead:** `DESIGN.md`, `design/tokens.json`,
  `openui.json`, the shipped `.devboard/client/app.css`, and the rendered interface.
- **Observed problem:** the 30px panel header holds a two-line identity (12px title
  over an 11px state) while 28px actions top-align. The state is a bare text line with
  no shape, and the empty state pairs a disabled blue primary Save with an outline
  Create action, so the disabled control reads as the primary action.
- **Direction adopted from the existing system:** one identity line (title plus a
  labeled status badge), 44px of header height for a full-page lead surface, actions
  centered on the row, and a single filled primary that follows the current state.
- **Rejected:** a page-header component (would add a second page title), a new token or
  component (the badge and buttons already exist), a file path in the header (the
  Session panel owns session facts), and keeping the two-line identity (the crowding
  the issue reports).
- **Effect on DESIGN.md / tokens / components:** tokens, DTCG, OpenUI, and Storybook
  are unchanged. Only the Flow goal header composition and its documented description
  change; no shared component API is modified.

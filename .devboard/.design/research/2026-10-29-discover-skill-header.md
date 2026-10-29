# designmd.ai research — Discover skill header (2026-10-29)

- **Task:** Redesign the Discover skill editor's `panel__header` (issue #786) so a 30px row
  carries the file identity, the draft state, Save, and the recovery control without the
  two-line crowding and the disabled-blue-primary emphasis.
- **Tools and arguments:** `mcp://` reports no MCP manager in this session, so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No design-kit value
  was invented or imported.
- **Candidates:** none retrieved; no MCP transport is configured.
- **Adopted:** the repository's own normative sources — `DESIGN.md`, `design/tokens.json`,
  `openui.json`, `.devboard/client/app.css`, and the shipped Flow goal and Decision board
  headers.
- **Rejected:** a state badge (the sidebar already flags edited/missing and the prior operator
  feedback removed the badge), a new token or component, a 44px lead-surface header, and a
  second page title.
- **Why:** the existing Button, panel header, mono title, and state-line grammar already express
  the information; only their composition and emphasis authority were wrong.
- **Effect on DESIGN.md / tokens / components:** no token, DTCG, OpenUI, or Storybook change.
  Only the documented Discover skill header composition changes; the Button API is untouched.

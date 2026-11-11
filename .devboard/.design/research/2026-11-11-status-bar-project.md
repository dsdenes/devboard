# designmd.ai research — status bar project identity (2026-11-11)

- **Task:** Redesign the status bar's project item (issue #1790) so the repository identity reads as
  a deliberate, sealed token in a 26px strip rather than a bare run of 12px mono text behind a
  12px folder glyph with a 2px gap.
- **Tools and arguments:** this session mounts no `designmd` MCP server, so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run (`No such tool`).
  No design-kit value was invented or imported.
- **Candidates:** none retrieved; no MCP transport is configured.
- **Adopted:** the repository's own normative sources — `DESIGN.md`, `design/tokens.json`,
  `openui.json`, `.devboard/client/app.css` (the shared `.code-chip`), and the shipped Discover
  skill header, which already pairs a path chip with a state pill.
- **Rejected:** a new component or chip variant (the shared `.code-chip` already is the
  identifier treatment); an invented token or border colour; an inline full path or owner/repo
  qualifier; a click action for the item; a second divider between connection and project.
- **Why:** the information is a repository identifier, and the interface already has exactly one
  treatment for identifiers. The defect was composition — 2px icon gap, a 12px mono word that
  out-shouted every 11px state word, and two vertical rules 4px apart — not missing vocabulary.
- **Effect on DESIGN.md / tokens / components:** the status bar bullet changes to describe the
  chip composition and the 18px geometry. No token, DTCG, OpenUI, or Storybook change; the Button
  API is untouched.

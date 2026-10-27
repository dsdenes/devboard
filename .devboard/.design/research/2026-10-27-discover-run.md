# Design research — Discover / Run header (2026-10-27)

- Source: `skill://ui-ux` Step 5.
- MCP status: no MCP manager is available in this session (`mcp://` reports
  `No MCP manager available`), so `designmd_search_design_kits` and
  `designmd_get_design_kit` could not run.
- Consequence: no design-system artifact or token is mutated by this change. `DESIGN.md` updates
  one component description to match the shipped panel; `design/tokens.json`, `openui.json`, and
  the Storybook stories stay byte-identical. The header composes existing documented classes.
- Normative inputs actually used:
  - `DESIGN.md` — colors, type scale, 2px spacing scale, 4px radii, panel and badge contracts,
    "state color never alone", "one primary action per surface", density rules.
  - `design/tokens.json` — no additions needed.
  - `openui.json` — the `Button` entry confirms no variant is added.
  - `.devboard/.design/steering/`, `.devboard/.design/overview/decision-board/` — established
    artifact location, scoring, and validation pattern.
  - `.issues-agent-row__close` in `app.css` and `DESIGN.md` — the established quiet destructive
    control this header reuses instead of the filled `destructive` button.
- Evidence for the redesign: the captured issue DOM at 2101×1017 (`@1.21875`) plus a live browser
  at 1600×1000 (DPR 1.25) against the running dashboard. The header measured 30px tall, 1204px
  wide, with an `accent-surface` fill, an `accent` bottom edge, a two-line identity, and a
  `Button destructive` that filled 28 of the 30 header pixels.

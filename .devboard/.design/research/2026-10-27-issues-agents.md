# Design research — Issues / Agents (2026-10-27)

- Source: `skill://ui-ux` Step 5.
- MCP status: no MCP manager is configured in this session (`mcp://` reports none), so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run.
- Prior receipts used instead: `.design/research/2026-10-26-design-system.md` (Octo Code:
  dark-first GitHub surfaces, hairline borders, no shadows; Violet Issue: dense 28px controls)
  and `.design/research/2026-10-27-operator-ui-tweaks.md` (Command Center: one state word per
  surface; WattVision: monospace value over a muted label, alert as a tinted surface with its own
  edge).
- Normative inputs actually used:
  - `DESIGN.md` — colors, type scale, 2px spacing scale, 4px panel radius, page-header contract,
    density rules, "state colour never alone".
  - `design/tokens.json` — no additions needed.
  - `openui.json` — `PageHeader`, `Button`, `Input` entries.
  - `.devboard/.design/overview/` — the established artifact location and prior operator review
    (no redundant chrome, keep every fact once).
- Evidence for this redesign: the captured issue DOM at `2101×1017`, the previous redesign at
  `fdda380` (which still repeats `running`/`needs answer` badges per card and gives every log the
  same 96px window), and live browser measurements of the card grid at 1440, 1024, and 2101.
- What transfers: activity becomes a labeled stat block (WattVision), the card keeps the panel
  layering and 4px radius (Octo Code), and the fleet state is stated once in the header (Command
  Center) instead of once per card.
- Design-system effect: `DESIGN.md` gains one component entry for the fleet card. No token,
  `design/tokens.json`, OpenUI catalog, or Storybook change is made; the card remains a
  page-level composition.

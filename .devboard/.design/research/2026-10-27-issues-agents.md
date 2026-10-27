# Design research — Issues / Agents (2026-10-27)

- Source: `skill://ui-ux` Step 5.
- MCP status: no MCP manager is configured in this session (`mcp://` reports none), so
  `designmd_search_design_kits` and `designmd_get_design_kit` could not run.
- Consequence: no design-system artifact or token is mutated by this change. `DESIGN.md` and
  `design/tokens.json` stay byte-identical; the page composes existing catalog components and
  documented classes.
- Normative inputs actually used:
  - `DESIGN.md` — colors, type scale, 2px spacing scale, 4px panel radius, page-header contract,
    density rules, "state color never alone".
  - `design/tokens.json` — no additions needed.
  - `openui.json` — `PageHeader`, `Button`, `Input` entries.
  - `.devboard/.design/overview/` — the established artifact location and prior operator review
    (no redundant chrome, keep every fact once).
- Evidence for the redesign: captured issue DOM at `2101×1017` plus a live browser measurement of
  the current page showing `167px` cards with `Status` at `y=267`, below the `134px` card box, and a
  `220px` max-height log collapsed to `21px` with `scrollHeight=4143`.

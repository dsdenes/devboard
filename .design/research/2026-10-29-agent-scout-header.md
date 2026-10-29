# Design research — Auto Scout agent header (2026-10-29)

- **Task:** Redesign the selected element
  `#workspace-issues > section.agent-page > header.page-header.page-header--bar` (issue #465)
  within the existing devboard design system.
- **MCP status:** no `designmd` MCP server is configured in this session (`.omp/mcp.json` lists
  only `adrkit`), so `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No
  design-kit value was invented or imported. This receipt records that limitation instead of
  claiming research that did not happen.
- **Sources of truth used instead:** `DESIGN.md`, `design/tokens.json`, `openui.json`, the shipped
  `.devboard/client/app.css`, `stories/page-header.stories.ts`, and the rendered source dashboard
  at 1024, 1440, and 2101 CSS pixels.
- **Observed problem:** the bar mixed identity, five status facts (lifecycle, forge read, last
  read, last run, next run), the run action, two interval/limit groups, and two save controls in
  one flex row. At 2101px it fit into 46px but read as an undifferentiated wall of 11px labels; at
  1024px it broke into four fragments (identity, status cluster, Start alone, settings) and grew
  to 139px. When the status cluster shared the identity line, the title itself was the flex item
  that truncated (`Aut…`), so the page name lost to the status.
- **Direction adopted from the existing system:** keep the dense operator console and its
  `surface`/`border` frame; split the header into a 44px identity/state/action row and a 40px
  footer band (reusing `surface-raised`-style sub-band geometry already documented for panel
  sub-headers, but at the header's own surface level with a `border-subtle` hairline). Group the
  footer by decision (Cadence, Filing limits), give each group an `overline` title, and place each
  save control beside the fields it commits. Protect the page name with a 300px identity floor and
  let the status/action cluster wrap instead.
- **Rejected:** keeping one row and shrinking type (the design system has no size between steps and
  the labels were already 11px); a disclosure or dialog for the settings (hides the current
  interval and limits that J1 answers with one glance); a side rail (takes width from the filed
  table); a third badge for the sync reason (the existing alert below the header owns the
  sentence); a new component (the shared `PageHeader` already owns the frame and gains one
  optional footer slot).
- **Effect on DESIGN.md / tokens / components:** tokens and DTCG are unchanged. `PageHeader` gains
  the optional `footer` snippet and a documented 300px identity floor; `openui.json` and
  `stories/page-header.stories.ts` are synchronized; DESIGN.md documents the footer band and the
  agent settings groups. No new token, color, radius, or font is introduced.

# Design research — Auto Scout (2026-10-27)

- **Task:** Redesign the Auto Scout workspace (issue #264, selected element
  `#workspace-issues > section.issues-scout`) inside the existing devboard design
  system: page identity, worker facts, actions, limits, filed issues, and activity.
- **MCP status:** no MCP manager is configured in this session (`mcp://` reports none),
  so `designmd_search_design_kits` and `designmd_get_design_kit` could not run. No
  design-kit value was invented or imported. This receipt records the limitation rather
  than claiming research that did not happen.
- **Sources of truth used instead:** `DESIGN.md`, `design/tokens.json`, `openui.json`,
  the shipped `.devboard/client/app.css`, the `PageHeader`/`Button`/`Input` sources,
  `scripts/verify-scout.ts`, and the rendered interface at 2101×1017 in both themes.
- **Observed problem:** five full-width panels stacked with equal weight. The page title
  is a 18px h1 with the lifecycle badge floating at the far right; the worker panel
  holds one Start button and six label/value pairs spread across a 1,700px strip; the
  filing limits are a bare inline row of two 96px inputs; an empty Filed issues panel
  collapses to 67px while Scan activity has a fixed 190px. The result reads as a list of
  loose strips with no primary action, no reading column, and a large empty middle.
- **Direction adopted from the existing system:** reuse the shared `PageHeader` so the
  lifecycle and read-health badges share one meta line with a single filled Start/Stop
  action at the right; put facts and editable limits in a 360px side rail; give the
  results column the remaining width with the table scrolling and the activity log at a
  fixed 210px. This mirrors the Issues overview's side/main split and the Issues
  running-agents page header.
- **Rejected:** a new card/table component (one consumer), a second token set (the
  existing panel, badge, table, and log styles already cover the surface), keeping the
  scan id in the worker facts (it duplicates the activity heading), keeping the raw ISO
  timestamps (a formatted local time is readable in a narrow rail), and a full-width
  limits form (two numbers do not need a page-wide row).
- **Effect on DESIGN.md / tokens / components:** tokens, DTCG, OpenUI, and Storybook are
  unchanged. Only the Auto Scout page composition and its page-scoped CSS change; no
  shared component API is modified.

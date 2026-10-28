# Design research — ADR start control (2026-10-28)

- Issue: #401, redesigned element `main > section.run > button.start-button` on the Decision
  records page.
- Source: the ui-ux skill's page/component workflow. The `skill://ui-ux` document is not installed
  in this session, so its artifact structure was taken from the repository's own receipts
  (`.design/ux/issues-queue-row/`, `.design/ux/watchdog/`) and its normative inputs were used
  directly.
- MCP status: `mcp://` reports no MCP manager, so `designmd_search_design_kits` and
  `designmd_get_kit` could not run. No design-kit receipt is claimed.
- Normative inputs:
  - `DESIGN.md` — dark-first GitHub surfaces, `control` typography, the 2px spacing scale,
    4px functional radius, the 24px `sm` control, one filled `primary` per surface, disabled at
    45% opacity, and "state a fact once per screen".
  - `design/tokens.json` — `button-*`, `control` type, `rounded.md`, and `spacing` values; no token
    change is needed.
  - `openui.json` — the `Button` entry: `default` is the filled primary and "must appear at most
    once per surface"; `outline` is low-emphasis; `sm` is 24px with 11px type.
  - `.design/overview/` — the operator review that removed redundant chrome and repeated facts.
- Evidence for the change: live measurements of the shipped table at 1440, 1024, and light/dark,
  plus the before state from the issue capture.
  - Before: each pending row rendered a bare 20px `button.start-button` at a 3px radius, 11px
    text with the cell's inherited 26px line-height, `0 6px` padding, and a filled `primary`
    background. Three identical blue controls competed with the record titles.
  - Before: every resolved row printed `Resolved` in the action column, repeating the
    Implementation column's word on the same line.
- What transfers from prior receipts: use the shipped `Button` primitive instead of a bespoke
  control (issues queue row and watchdog pages compose existing primitives); keep one state word
  per row (Command Center receipt); let the row's existing `Next` marker drive emphasis instead of
  painting every row equally (agent fleet card and queue receipts).
- Design-system effect: `DESIGN.md` gains one component entry for the Decision record start
  control. No token, `design/tokens.json`, OpenUI, or Storybook change is made; the control is a
  composition of the shipped `Button` primitive.

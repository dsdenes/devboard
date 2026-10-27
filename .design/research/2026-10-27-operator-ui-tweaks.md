# Design research — operator UI tweaks (2026-10-27)

Design-system mutation receipt for the batch of operator issues #191–#201. Tokens stay unchanged;
the changes are geometry, semantic color use, and one relocated control.

## Sources consulted (`designmd` MCP)

- `search_design_kits` — query "dense operator console dark dashboard sidebar menu danger zone
  destructive badge status" returned no kits, so the popular list supplied the candidates.
- `frknaykc/command-center` (dark dashboard, security): shell framing separates chrome from
  workspace; navigation items use a comfortable `6px 12px` padding rather than edge-to-edge text;
  status badges pair a tinted background with its own foreground; the shell never carries a
  second saturated brand color.
- `groquispe100inf-max/design-md-sistema-de-monitoreo-el-ctrico-wattvision` (dark monitoring
  dashboard): alerts are a tinted error surface with an error-colored left edge and error-colored
  text; KPI stats use a monospace value over a muted label; spacing is a small fixed scale.

## What transfers

- **Mode rail padding (#198).** Command Center's `nav-item` padding (`6px 12px`) is the reasoning
  behind giving each mode tab a real inset instead of a zero-padding box whose label touches the
  edge. Devboard's own scale (2/4/6/8/10/12/14/16/24/28) supplies `6px` and `4px`; the rail keeps
  a fixed shell width and the tab gains height so the label keeps its 10px `overline` treatment.
- **Danger zone color (#197).** WattVision's alert pattern maps directly onto Devboard's existing
  `--error` / `--error-surface` pair: tinted header, error border, error title, and the word
  "Destructive" kept as a badge so color never carries meaning alone.
- **Status badges (#194).** Command Center's status badges show one word with one tone. Devboard
  already has `data-tone` tones; the record header therefore shows the document status once,
  colored by its meaning, instead of a second "Resolved/Pending" badge that repeats it.
- **Navigation icons (#192).** Both kits use icons for a control's own affordance, not as a
  leading decoration on a navigation item; decorative chevrons are dropped, the disclosure
  chevron stays because it toggles a group.
- **Stats (#199).** WattVision's KPI pattern (monospace value, muted label) is what the Tests card
  already uses; the happy-path figure is another stat in the same row, and per-level counts stay
  in the table.

## Constraint kept

No new token, color, font, radius, or elevation is introduced. Spacing values are on the approved
scale. DESIGN.md is updated for the geometry and the semantic uses that changed.

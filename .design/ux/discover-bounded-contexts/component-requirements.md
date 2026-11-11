# Bounded contexts widget — component requirements

The widget is a page-level composition of shipped primitives, not a new design-system component.
No OpenUI entry, Storybook story, DTCG token, or `DESIGN.md` token changes; only the card's internal
markup and styles change.

|Need|Decision|OpenUI entry|Storybook story|Data/state requirements|Accessibility|Token needs|
|---|---|---|---|---|---|---|
|Card frame|Reuse|n/a (`.panel`, `.discover-card`)|n/a|Absent when the sheet has no architecture section|`section` with a heading; `data-field="architecture"`, `data-field="external-boundaries"`, `data-field="shared-kernels"`|`surface`, `border`, `rounded.md`|
|Context list|Compose (`ul` + shipped heading/chip styles)|n/a|n/a|0, 1, many contexts; long name, responsibility; 0–n entry points; duplicate entries; unknown leaf|Real list; `data-testid="discover-contexts"`; one `data-context` per item; name is text, not a link|`foreground`, `muted-foreground`, `border-subtle`, `mono-small`, `label`|
|Boundary card|Reuse panel chrome|n/a|n/a|One card per group; header title and optional count subtitle; chips 0–n; unknown reason in place of chips; the card's own empty line|`section` with a heading; the group's `data-field`; chip values are definition text|`muted-foreground`, `border-subtle`, `body-small`, `mono-small`|
|Unknown line|Reuse `.empty` typography|n/a|n/a|One unknown leaf per boundary card; its reason follows `unknown —`; no reason renders `unknown`|Plain paragraph, no color-only signal|`muted-foreground`, `body-small`|
|Chips|Reuse `.discover-chip`|n/a|n/a|Short path or system name; a path value the checkout contains maps through `overviewLinks`; long value wraps inside the row|`code` chip; a checkout path is a link titled `Open in VS Code`, a system name stays plain text|`border-subtle`, `mono-small`, `rounded.sm`|

## Composition rules

- Reuse the shipped chip, panel, and empty-text styles. Do not introduce a card, badge, or token.
- The context name is not a control: there is no per-context page and no glossary deep link in this
  change, so no hover or focus affordance is added.
- Entry-point and shared-kernel chips are the widget's only locators: a chip whose trimmed value
  maps through the server's `overviewLinks` to an existing file or directory in the host
  checkout renders as an anchor to that `vscode://file/` handoff, titled `Open in VS Code`. A
  value with no link — a missing, absolute, or escaping path, or any chip while a remote target
  is shown — stays a plain `code` chip. External-boundary chips are always plain text: a system
  name is not a checkout path, and the repository link helper resolves package names, not paths.
- The context list is the last card of the main column; the boundary cards follow `Stack` in the
  facts rail, external boundaries first, then shared kernels.
- A boundary card renders when its leaf exists, unknown or observed; an absent leaf removes that
  card alone.

## Data variety to survive

- 0 contexts; 1; 8 with long names.
- Responsibility up to the 160-character leaf limit; an entry point up to the same limit.
- Duplicate entry points; no entry points; a context with neither responsibility nor entry points.
- Empty boundary arrays (observed none); unknown leaves with and without a reason; a missing
  boundary leaf.
- Values that are long service names, paths, or a full sentence.
- Card width from the wide main column and 320px facts rail down to the single-column 1024×720
  workspace.
- Dark and light themes; reduced motion (no motion is added).

## Verification requirements

- `cd .devboard && bun run build` and `bun test`.
- Browser evidence at 1440×900 and 1024×720, dark and light, with observed, empty, and unknown
  states; recorded in `.design/ux/discover-bounded-contexts/validation.md`.
- No console errors, no failed requests, no horizontal overflow, no clipped labels.

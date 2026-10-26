# Bounded contexts widget — component requirements

The widget is a page-level composition of shipped primitives, not a new design-system component.
No OpenUI entry, Storybook story, DTCG token, or `DESIGN.md` token changes; only the card's internal
markup and styles change.

|Need|Decision|OpenUI entry|Storybook story|Data/state requirements|Accessibility|Token needs|
|---|---|---|---|---|---|---|
|Card frame|Reuse|n/a (`.panel`, `.discover-card`)|n/a|Absent when the sheet has no architecture section|`section` with a heading; `data-field="architecture"`|`surface`, `border`, `rounded.md`|
|Context list|Compose (`ul` + shipped heading/chip styles)|n/a|n/a|0, 1, many contexts; long name, path, responsibility; 0–n entry points; repeated path/entry; unknown leaf|Real list; `data-testid="discover-contexts"`; one `data-context` per item; name is text, not a link|`foreground`, `muted-foreground`, `border-subtle`, `mono-small`, `label`|
|Boundary role rows|Compose (`dl` + shipped chip styles)|n/a|n/a|0–3 rows; chips 0–n; direction as a sentence; observed-empty group omitted|`dl`/`dt`/`dd`; role label is the term; values are definition text|`muted-foreground`, `border-subtle`, `body-small`, `mono-small`|
|Unknown-group line|Reuse `.empty` typography|n/a|n/a|One or more unknown groups; one shared reason; no reason|Plain paragraph, no color-only signal|`muted-foreground`, `body-small`|
|Chips|Reuse `.discover-chip`|n/a|n/a|Short path or system name; long value wraps inside the row|`code` element, no link (a boundary is not necessarily a package repository)|`border-subtle`, `mono-small`, `rounded.sm`|

## Composition rules

- Reuse the shipped chip, panel, and empty-text styles. Do not introduce a card, badge, or token.
- The context name is not a control: there is no per-context page and no glossary deep link in this
  change, so no hover or focus affordance is added.
- Entry points are plain `code` chips, never repository links: the shipped link helper resolves
  package names, and a path or external system would resolve to the wrong repository.
- Role rows appear in reading order: shared kernels, external boundaries, dependency direction.

## Data variety to survive

- 0 contexts; 1; 8 with long names.
- Responsibility up to the 160-character leaf limit; path and entry point up to the same limit.
- Entry point equal to the path; duplicate entry points; no entry points.
- Empty boundary arrays (observed none); unknown leaves with and without a reason; all groups empty.
- Values that are long service names, paths, or a full sentence.
- Card width from the wide main column down to the single-column 1024×720 workspace.
- Dark and light themes; reduced motion (no motion is added).

## Verification requirements

- `cd .devboard && bun run build` and `bun test`.
- Browser evidence at 1440×900 and 1024×720, dark and light, with observed, empty, and unknown
  states; recorded in `.design/ux/discover-bounded-contexts/validation.md`.
- No console errors, no failed requests, no horizontal overflow, no clipped labels.

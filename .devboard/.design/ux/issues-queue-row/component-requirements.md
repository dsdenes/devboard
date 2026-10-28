# Issues queue row — component requirements

Scope: one list row in `section.issues-queue-page` within Issues mode. No new
component, no token change, no OpenUI or Storybook mutation.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Row container | Modify page-level CSS (`.issues-queue__item`) | none — layout class, not a catalog component | n/a | 0–n rows; 1–2 trailing badges; long title | Native `li` inside `ol`; reading order number → title → meta | `border-subtle`, `row-hover`, 2px spacing scale |
| Tracker link | Reuse native anchor inside the row | none — anchors are not a component | n/a | Always present; URL from `queue[].url` | Opens in a new tab; global `a:focus-visible` ring; the visible text is `#<n>` | `muted-foreground`, `foreground` |
| Attribute/state badge | Reuse `.badge` with `data-tone` | none — `.badge` is already a shipped page primitive and has no OpenUI entry today; not added here because it is not a Svelte component with props | n/a | `goal` accent; `pending` pending; `running` accent; `handled` success | The badge text is the meaning; color never carries it alone | Existing badge tones only |
| Meta group | Modify page-level CSS (new `.issues-queue__meta`) | none | n/a | Optional goal badge, exactly one state badge, 6px gap, never wraps | Inline group; no focus target | `spacing.snug` 6px |
| Empty line | Reuse `.issues-queue__empty` | none | n/a | Empty queue | Plain text in the list | `muted-foreground` |

Verification of the existing component set: `openui.json` lists `Button`,
`IconButton`, `Input`, `PageHeader`, and `StageTrack`; none carries a list row or
a badge, and the row needs neither. The row composes existing page primitives
(`ol`/`li`, anchor, `.badge`) with three CSS classes. No design-system artifact
is mutated, so no designmd research receipt is required.

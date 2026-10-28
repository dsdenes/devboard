# Component requirements — Discover / Run header

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Panel header identity | Reuse | `.panel__header`, `.panel__title`, `.discover-run__dot` (DESIGN.md) | n/a (shared page CSS) | running only; long title at narrow widths | `h2` stays the section heading; dot is `aria-hidden`, the title words the state | `surface-raised`, `accent`, `border` |
| Relative start time | Reuse | `.discover-run__started` (page CSS) | n/a | absent while `startedAt` is null; updates every 30s; long relative labels | Plain text; ISO clock in `title` | `muted-foreground` |
| Stop control | Compose | Quiet destructive page control, same pattern as `.issues-agent-row__close` (DESIGN.md), not `Button` | n/a (page CSS) | native disabled support; single click | Visible word `Stop`; hover/focus state; global focus-visible ring | `border-subtle`, `muted-foreground`, `error-surface`, `error` |
| Header row layout | Compose | `.panel__header` + flex groups | n/a | 30px height; 8px padding; 8px identity gap; 10px meta gap | DOM order: heading, meta, action | `spacing.base`, `spacing.snug`, `spacing.relaxed` |

Catalog gaps: none. `design/tokens.json` is unchanged; `openui.json` is unchanged because `Button`
is untouched and the Stop is a page-level quiet destructive control, exactly the composition the
running-agent row already documents. No new Storybook story is warranted for a page header; the
existing `Button` story is not exercised by this panel.

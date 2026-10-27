# Component requirements — Overview / Running agents

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Panel shell, header, section title | Reuse | none (`.panel` in `app.css`) | — | empty, one, many; light/dark | `h2` in the header, list under it | `surface`, `border`, `panel-title` |
| Warning count and `needs answer` badge | Reuse `.badge` | none (`.badge` in `app.css`) | — | 1 waiting, 2+ waiting; none waiting | word always present; `data-tone="warning"` | `warning` |
| Row select control | Modify `.issues-agent-row` | none (documented CSS component in `DESIGN.md`) | — | rest/hover/selected/focus; long titles; 0/1/many; 1024 and 2101 widths | native `button`, `aria-current`, `title` tooltip | `row-hover`, `accent-surface`, `accent`, `border-subtle` |
| Row close control | Modify (plain button, following `.skill__delete`) | none | — | enabled/disabled; hover/focus tint | `aria-label="Close issue #N"`, `title` names `not planned`, visible word | `muted-foreground`, `error-surface`, `error` |
| Empty state | Reuse list item styling | — | — | zero agents | plain text, no control | `muted-foreground` |

No new component, no new variant, no OpenUI or Storybook addition. The row and its close control
are already documented in `DESIGN.md`; this change corrects their treatment there. No token
changes, so no DTCG regeneration and no designmd mutation receipt is required.

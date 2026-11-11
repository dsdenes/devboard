# Component requirements — status bar project identity

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Project identity as one sealed token (glyph + name) | Compose: `.status-item.status-project` takes the shared `.code-chip` treatment | none (`.code-chip` is CSS chrome, not an OpenUI primitive; no catalog addition) | none (the footer has no story; the whole bar is exercised in the browser) | default name, empty `No project`, 320px-capped long name, connecting/disconnected state on the neighbour item | decorative glyph is `aria-hidden`; the full path stays the item's `title` | `background`, `border-subtle`, `foreground`, `muted-foreground`, `rounded.sm`, `mono` |
| Bare button for the provider control beside it | Reuse | `Button` (`bare` form) | `stories/design-system.stories.ts` | selection none / `opencode-go` / `openrouter`; long provider label | `aria-label` names the provider and the dialog it opens | unchanged |
| State dot beside the connection word | Reuse | none (CSS dot, documented in `DESIGN.md` principle 4) | none | open / connecting / closed | dot is `aria-hidden`; the word carries the state | `success`, `warning`, `error` |

## Data variety the project item must survive

- **Empty:** `connection.projectPath` blank → `No project` inside the same 18px chip (measured 99px
  wide in the browser).
- **Long text:** a 538px-wide name ellipsizes inside a 320px-capped chip; the footer's scroll width
  stays equal to its client width at 1024px.
- **Zero/one/many:** not applicable — the item states one repository.
- **Narrow container:** 1024px viewport keeps the chip and both P0 items; the metrics group is the
  flexible side.
- **Theme:** dark is normative; the light theme reads `background` white and `border-subtle`
  `#eaeef2`, so the chip keeps a hairline on the light `surface-raised` bar.
- **Localization / RTL:** the item already ellipsizes from the end with a tooltip; no new layout
  assumption.
- **Reduced motion:** no motion is added.

No new component, variant, token, DTCG, OpenUI, or Storybook change is required: the change
composes an existing shared treatment and adjusts one component's geometry.

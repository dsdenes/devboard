# Component requirements — Flow / Decision board header

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Panel shell and header | Reuse | none (`.panel`, `.panel__header` in `app.css`) | `stories/design-system.stories.ts` covers the primitives | saved, dirty, empty; light/dark | `h2` names the panel | `surface`, `border`, `panel-title` |
| State line | Reuse the Discover skill header geometry | none (documented CSS in `DESIGN.md`) | — | saved, dirty, empty; long content; narrow pane | plain text, `data-state` for styling only; the words carry the meaning | `success`, `warning`, `muted-foreground` |
| Save action | Reuse `Button` `default` | existing button catalog entry | existing button stories | enabled/dirty, disabled/saved or empty, disabled/failed transport | native `button`, `disabled`, `title` explains why | `primary`, `primary-hover`, `primary-foreground` |

No new component, variant, token, OpenUI entry, or Storybook story. The header composes the
existing panel header and Button, and follows the Discover skill header's draft-line treatment
that `DESIGN.md` documents. No design-system mutation means no designmd research receipt; no DTCG
regeneration.

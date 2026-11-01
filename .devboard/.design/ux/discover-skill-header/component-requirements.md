# Discover skill header — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Leading identity | Compose | none; `.panel__header` + `.panel__title` in `app.css` | `design-system.stories.ts` covers the panel header | Path from `activeSkill`; truncates with full-path `title` | `<h2>` names the file | `mono`, `foreground`, `muted-foreground` |
| Chrome band | Compose | none; `.discover-skill__header` | — | Always rendered around the header row | Carries no meaning of its own | `surface-raised`, `border` |
| Draft state dot | Compose | none; `.discover-skill__state-dot` | — | 6px dot: `success` clean, `warning` dirty, `error` missing | `aria-hidden`; the word states the state | `success`, `warning`, `error` |
| Draft state word | Compose | none; `.discover-skill__state` | — | Clean, dirty, missing; warning/error color | Always a word; color never alone | `muted-foreground`, `warning`, `error` |
| Save | Reuse | `Button` | `design-system.stories.ts` | Disabled clean/missing; `secondary` clean/missing; `default` dirty | Native button, disabled attribute, `title` states why | `secondary`, `primary` |
| Restore | Reuse | `Button` | `design-system.stories.ts` | Visible when edited or missing; `outline` edited; `default` missing | Native button with an action-specific label | `outline`, `primary` |

## Component details

### Header row

- Decision: compose from the shipped panel header, title, state dot and word, and Button
  primitive on the level-2 `surface-raised` band.
- Why this decision: the band gives the editor chrome a surface distinct from the pane, the 34px
  row gives the 28px controls breathing room, and the dot pairs with the existing state word
  instead of adding a label.
- Real API: `.panel__header.discover-skill__header` plus `.discover-skill__identity`,
  `.discover-skill__state`, `.discover-skill__state-dot`, and `.discover-skill__actions` in
  `app.css`.
- Data shapes: `activeSkill: string`, `skillState: "generated" | "edited" | "missing"`,
  `skillDirty: boolean`.
- States: clean/generated, clean/edited, dirty, missing.
- Edge cases: long skill name, two actions, over-wide sidebar, restored mode/tab.
- Accessibility: heading carries the path; the dot is `aria-hidden` and the state text is
  visible; focus ring comes from Button.
- Tokens: existing only; no DTCG change.
- Storybook story to add/update: none; the primitive stories already cover the controls.
- OpenUI entry to add/update: none.

### Save and Restore emphasis

- Decision: modify the variant selection, not the component.
- Why: the disabled primary was the reported visual defect; a filled primary must follow the
  state that can act.
- Real API: `Button variant="default" | "secondary" | "outline"`.
- Data shapes: variant derived from `skillDirty` and `skillState`.
- States: see the state coverage in `structure.md`.
- Edge cases: dirty and missing cannot both own Save; Recreate becomes the only primary.
- Accessibility: the state word and `title` explain the disabled control.
- Tokens: existing `primary`, `secondary`, `border-strong`, `warning`, `error`.
- Storybook story to add/update: none.
- OpenUI entry to add/update: none.

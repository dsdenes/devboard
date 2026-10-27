# Component requirements — Flow / Steering

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Panel header identity + state line | Reuse | `.panel__header`, `.panel__title`, `.panel__subtitle` (DESIGN.md) | n/a (shared page CSS) | empty, waiting 1/many, all read; long bounded text | Heading stays `h2`; state is text, not color alone | `muted-foreground`, `warning`, `success` |
| Note field | Reuse | `.textarea` (DESIGN.md) | n/a | empty, whitespace, long text, many lines | Existing `aria-label="Steering note"`; visible focus | `background`, `border-strong`, `ring` |
| Send action | Reuse | `Button` (`default`) | `stories/design-system.stories.ts` | disabled on empty; enabled on draft; repeated submits | Accessible name `Send`; disabled is native | `primary`, `primary-foreground` |
| Composer layout | Compose | `Button` + `.textarea` in a column | n/a | 6px gap; action right-aligned; narrow width | DOM order textarea then button | `spacing.snug` |
| Note row | Reuse | `.steering-note`, `.steering-meta` (existing page CSS) | n/a | zero, one, many; new/read; long text; source and timestamp present | Status word is text; notes are static content | `border-strong`, `accent`, `muted-foreground` |

Catalog gaps: none. The panel is a page composition of the documented `Button`, `.textarea`,
`.panel__*`, and `.steering-note` styles. No new primitive, token, or Storybook story is needed;
`Button` is unchanged and its existing story covers the variants used here.

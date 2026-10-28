# Decision board — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Save control | Reuse | `Button` | `stories/design-system.stories.ts` covers the primitive | `default` while dirty, `secondary` while disabled; disabled derives from `flow.decisionsDirty` | Native button with stable `data-command`; visible focus ring; disabled is non-interactive | None |
| Board state | Compose | — (`.badge` CSS primitive, not an OpenUI component) | Existing badge specimens in the design-system overview | `data-state` = empty/saved/dirty; `data-tone` = none/success/warning; word always present | Text carries the meaning; color is redundant | Existing `success`, `warning`, `border-strong`, `muted-foreground` tokens |
| Header identity | Compose | — | — | One `h2` and one badge; no new component API | `h2` remains the section heading; badge is inline text | Existing spacing and typography tokens |
| Decision board header | Modify | — | — | Page composition and `.flow-decisions__*` rules in `app.css` | Native heading and button; focus visible | Existing spacing (10, 12), typography, and color tokens |

## Component details

### Button
- Decision: reuse the single existing instance.
- Why: the primitive already covers filled, secondary, disabled, and focus states.
- Real API: `.devboard/client/lib/components/ui/button.svelte`; `variant`, `size`, `class`,
  native attributes, and `onclick`.
- States: default (dirty) and disabled secondary (empty or saved). There is no loading state on
  this action; the draft remains dirty until the save confirmation arrives.
- Edge cases: a long localised label stays on one line; the action group never shrinks.
- Accessibility: native button with the existing title; disabled Save is not focusable, which is
  the product's existing convention.
- Tokens: existing button tokens only.

### Status badge
- Decision: compose from the existing `.badge` class; no OpenUI or Storybook change because
  `.badge` is not a catalogued component.
- Why: the badge already renders a word with a semantic tone across Goal, Issues, and Discover.
- Data shapes: `data-state` keeps driving tests; `data-tone` drives color. The empty state has no
  `data-tone` so the base muted badge applies.
- States: empty (muted), saved (success), dirty (warning).
- Edge cases: all labels are short and fit beside the title; the badge never shrinks.
- Accessibility: the word is the state; color is redundant.
- Tokens: `success`, `warning`, `border-strong`, `muted-foreground`.

### Decision board header
- Decision: modify the page composition and its page-scoped CSS; add no shared component.
- Why: one surface uses this header, and the Flow goal header already establishes the pattern.
- Real API: `.devboard/client/FlowMode.svelte` decisions branch; `.flow-decisions__*` rules in
  `.devboard/client/app.css`.
- States: empty, saved, and dirty.
- Edge cases: the 1024px workspace, a changing state that must not move the title, and a disabled
  Save that must stay a neutral control.
- Accessibility: `h2` heading, inline state text, native button, visible focus.
- Tokens: existing spacing (10, 12), `section-title` typography, and color tokens only.
- Storybook/OpenUI: unchanged; no shared component was added or modified.

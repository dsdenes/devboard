# Flow goal header — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Create/recreate control | Reuse | `Button` | `stories/design-system.stories.ts` covers the primitive | variant switches from `default` when no goal exists to `outline` otherwise; label switches to `Recreate flow goal` when a goal exists | Native button with a stable `data-command`; visible focus ring | None |
| Save control | Reuse | `Button` | `stories/design-system.stories.ts` covers the primitive | `default` while dirty, `secondary` while disabled; disabled attr from `flow.goalDirty` | Native button; disabled is non-interactive; 45% opacity | None |
| Goal state | Compose | — (`.badge` CSS primitive, not an OpenUI component) | Existing badge specimens in the design-system overview | `data-state` = empty/saved/dirty/running; `data-tone` = default/success/warning/accent; word always present | Text carries the meaning; badge does not rely on color alone | Existing success, warning, accent, border, muted tokens |
| Header identity | Compose | — | — | One `h2` and one badge; no new component API | `h2` remains the section heading; badge is inline text | Existing spacing, typography, surface, border tokens |

## Component details

### Button
- Decision: reuse both instances.
- Why: the existing primitive already covers filled, outline, secondary, disabled, and
  focus states; a new control would duplicate it.
- Real API: `.devboard/client/lib/components/ui/button.svelte`; `variant`, `size`,
  `class`, native attributes, and `onclick`.
- States: default, disabled. No loading state exists on these actions.
- Edge cases: a long label (`Recreate flow goal`) stays on one line; the action group
  does not shrink because `Button` is `shrink-0`.
- Accessibility: native buttons with names; disabled Save is not focusable, which is
  the existing product convention.
- Tokens: existing button tokens only.

### Status badge
- Decision: compose from the existing `.badge` class; no OpenUI or Storybook entry
  changes because `.badge` is not a catalogued component.
- Why: the badge already renders a word with a semantic tone and is used across Goal,
  Issues, and Discover.
- Data shapes: `data-state` drives tests; `data-tone` drives color. The tone is absent
  for the empty state so the base muted badge applies.
- States: empty (muted), saved (success), dirty (warning), interview running (accent).
- Edge cases: all labels are short and fit beside the title; the badge never shrinks.
- Accessibility: the word is the state; color is redundant.
- Tokens: `success`, `warning`, `accent`, `border-strong`, `muted-foreground`.

### Flow goal header
- Decision: modify the page composition and its page-scoped CSS; no new shared
  component.
- Why: one page uses this header; promoting it to the design system would invent a
  component without a second consumer.
- Real API: `.devboard/client/FlowMode.svelte` `goalPanel` snippet; `.flow-goal__*`
  rules in `.devboard/client/app.css`.
- States: empty, saved, dirty, running, and collapsed while the interview is active.
- Edge cases: wide workspace (the action group stays at the far right), 1024px
  workspace, long button labels, and a state change that must not shift the title.
- Accessibility: `h2` heading, inline state text, native controls, visible focus.
- Tokens: existing spacing (8, 12), typography, and color tokens only.
- Storybook/OpenUI: unchanged; no shared component was added or modified.

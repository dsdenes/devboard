# Decision board — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Board state badge | Compose | — (`.badge` CSS primitive, not an OpenUI component) | Existing badge specimens in the design-system overview | `data-state` = empty/saved/restoring; `data-tone` = none/success/accent; word always present | Text carries the meaning; color is redundant | Existing `success`, `accent`, `border-strong`, and `muted-foreground` tokens |
| Header identity | Compose | — | — | One `h2` and one badge; no new component API | `h2` remains the section heading; badge is inline text | Existing spacing and typography tokens |
| Read-only board body | Reuse | — (`.flow-document__text` page CSS primitive, not an OpenUI component) | — | `flow.decisions` bytes in a `<pre>`; `data-testid="flow-decisions"`; empty string renders an empty body | `<pre aria-label="Decision board">`; selectable, not editable; no focus target of its own | Existing `background`, `foreground`, and monospace tokens |
| Restoring notice | Compose | — | — | Replaces the body while `flow.restoring`; one paragraph; `data-testid="flow-decisions-restoring"` | Plain paragraph read in document order; no action | Existing body text tokens |
| Decision board section | Modify | — | — | Page composition and `.flow-decisions__*` rules in `app.css`; section testid `flow-decisions-section` | Native `h2` heading; the readable text is the page's content | Existing spacing (10, 12), typography, and color tokens |

## Component details

### Board state badge
- Decision: compose from the existing `.badge` class; no OpenUI or Storybook change because
  `.badge` is not a catalogued component.
- Why: the badge already renders a word with a semantic tone across Goal, Issues, and Discover.
- Real API: `.devboard/client/lib/components/DecisionBoard.svelte`; `data-state` drives tests,
  `data-tone` drives color, and the label is the state word.
- Data shapes: `flow.decisions` decides saved versus empty after `trim()`; `flow.restoring`
  wins over both, so a restore frame never reads as a settled empty board.
- States: empty (muted), saved (success), restoring (accent).
- Edge cases: a whitespace-only board is empty; a long board still reads `Saved`; the label is
  short and never shrinks beside the title.
- Accessibility: the word is the state; color is redundant.
- Tokens: `success`, `accent`, `border-strong`, `muted-foreground`.
- Storybook story to add/update: none; the design-system badge specimens already cover the
  primitive.
- OpenUI entry to add/update: none.

### Read-only board body
- Decision: reuse the existing `.flow-document__text` document primitive inside a `<pre>`.
- Why: Goal and Discover already render their documents as read-only bytes with the same rule,
  so the board needs no new surface styling.
- Real API: `.devboard/client/lib/components/DecisionBoard.svelte` renders
  `<pre class="flow-document__text mono" data-testid="flow-decisions" aria-label="Decision board">`;
  the rule lives in `.devboard/client/app.css`.
- Data shapes: one string; Svelte escapes markup, so decision text that contains `<`, `>` or
  `&` renders literally.
- States: empty (no bytes), one line, and a long board that scrolls inside the body.
- Edge cases: zero decisions; one decision; many decisions; long unbroken lines stay on one line
  under `white-space: pre` and scroll horizontally.
- Accessibility: the `<pre>` carries the `Decision board` label; the text is selectable and is
  not a form control, so the surface exposes no editable or focusable document target.
- Tokens: existing `background`, `foreground`, and monospace typography.
- Storybook story to add/update: none; the primitive is shared page CSS, not a design-system
  component.
- OpenUI entry to add/update: none.

### Restoring notice
- Decision: compose the existing `.flow-goal-onboarding` paragraph block; add no component.
- Why: the Flow goal panel already uses the same block to explain a restore, and the board must
  not render stale or empty bytes while a restore is in flight.
- Real API: `.devboard/client/lib/components/DecisionBoard.svelte` restoring branch; the copy is
  `This dashboard holds a Flow session that is still being restored. Its decision board appears
  as soon as the restore finishes.`
- Data shapes: no data; presence is driven by `flow.restoring`.
- States: shown only while restoring; replaced by the `<pre>` as soon as the frame settles.
- Edge cases: a board text that arrived before the restore frame never wins over the notice; a
  settled board never shows the notice.
- Accessibility: plain paragraph text; no action and no focus change.
- Tokens: existing body text color and spacing.

### Decision board section
- Decision: modify the page composition and its page-scoped CSS; add no shared component.
- Why: one surface uses this section, and the Flow goal panel already establishes the header
  pattern.
- Real API: `.devboard/client/FlowMode.svelte` decisions branch renders
  `.devboard/client/lib/components/DecisionBoard.svelte`; `.flow-decisions__*` rules live in
  `.devboard/client/app.css`.
- States: empty, saved, and restoring.
- Edge cases: the 1024px workspace, a changing state that must not move the title, and a long
  board that scrolls instead of clipping.
- Accessibility: `h2` heading, inline state text, labeled document body.
- Tokens: existing spacing (10, 12), `section-title` typography, and color tokens only.
- Storybook/OpenUI: unchanged; no shared component was added or modified.

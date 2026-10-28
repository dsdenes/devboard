# Decision record start control — component requirements

Scope: the action cell of `table.adr-table` on Goal mode's Decision records page. No new
component, no token change, no Storybook mutation, no OpenUI mutation.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Row action | Reuse `ui/button.svelte` | Existing `Button`; no change | None; the page composes a catalogued primitive | `record.pending`; `goal.next === record.file`; no click for resolved rows | Native `<button type="button">`; visible `Start`; `aria-label` names the record; pointer cursor while enabled | `primary`, `primary-hover`, `primary-foreground`, `border-strong`, `secondary`, `secondary-hover`, `foreground`, `ring` |
| Control size | `size="sm"` | Existing size enum | None | n/a | 24px control inside a 28px row | `rounded.md` 4px; `control` type at 11px/500 |
| Emphasis | `variant="default"` on the `Next` record, `outline` on other pending records | Existing variant enum | None | Exactly one filled primary per surface, guaranteed by `goal.next` | Emphasis never replaces the label | Same tokens as the row action |
| Action cell | Modify `AdrTable.svelte` CSS (`.adr-action`) | n/a — layout class | n/a | One child or none; 24px line-height centers the control | Cell keeps the table's reading order; no focus target of its own | `spacing` cell padding from the shared `td` rule |
| Resolved cell | Remove the `Resolved` text | n/a | n/a | `record.pending === false` | State remains in the Implementation column | None |
| Disabled state | Native `disabled` from `goal.runStartDisabled` | Existing prop | None | Creation, revision, skills preparation, manual run | 45% opacity, pointer events removed, label intact; `title` explains prerequisites when present | Existing disabled rule |
| Focus | Primitive focus ring | Existing base classes | None | Keyboard and pointer | 2px `ring` with 1px offset; row focus stays separate | `ring`, `background` |

Verification of the existing component set: `openui.json` lists `Button` with the `sm` size and
`default`/`outline` variants used here, and its `Button` description already states that
`variant=default` must appear at most once per surface. The action cell is a table-cell layout,
not a reusable component, so it stays in `AdrTable.svelte`. The control is a page composition of
the catalogued primitive; no design-system artifact is mutated, so no designmd research receipt
is required.

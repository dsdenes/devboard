# Draft goals body — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Empty body state | Compose `.panel` body with local `.issues-drafts__placeholder*` styles and a Lucide `NotebookPen` mark | — | — | zero drafts; title plus one copy line; 2101 and 1024 widths; light and dark | `aria-hidden` mark, real text title/copy, no focus target | muted-foreground, foreground, type sizes, spacing |
| Selection empty state | Compose the same stack with a Lucide `MousePointerClick` mark | — | — | drafts present, no selection; same widths and themes | `aria-hidden` mark, real text | same tokens |
| Proposed goals panel | Reuse | `.panel`, `.panel__header`, `.panel__body` | design-system overview specimens | header title + one `sm` primary; optional creation band; rows or empty stack | headings and native controls unchanged | panel, button |
| Draft row | Reuse | — (unchanged) | — | idle/running/succeeded/failed/stopped; long file names and headings; blocker tooltips | unchanged | unchanged |
| Draft detail | Reuse | — (unchanged) | — | unchanged | unchanged | unchanged |

## Component details

### Empty stack

- Decision: compose the existing panel body; no new component, because the stack has two consumers
  on one page and no API.
- Structure: one column, 4px gap, 360px maximum width, with a 4px extra step under the icon;
  centered on both axes by the panel body.
- Content: `No drafts yet` at 13px/600, then one 12px/400 `muted-foreground` line in sentence case:
  `Create one with New goal, or propose it from a report. Each draft becomes a goal you can
  elaborate here.`
- The icon is a 20px Lucide `NotebookPen` at 1.5 stroke width, `muted-foreground`, and
  `aria-hidden="true"`; it never carries meaning alone.
- States: zero drafts only; a nonzero list removes the stack and mounts the rows. There is no
  hover, focus, or interactive state.

### Selection stack

- Decision: compose the same classes, with a 20px Lucide `MousePointerClick` mark and the title
  `No draft selected`.
- Copy: `Choose a draft from Proposed goals to read its proposal and elaborate it.`
- It renders only while drafts exist and `issues.draft === null`; selecting a row replaces it with
  the detail panel without remounting the page. Removing the last draft replaces both with the
  one-panel empty state.

### Panel and layout

- Reuse `.panel`, `.panel__header`, `.panel__body`, and `panel__body--flush`.
- The grid keeps `minmax(240px, 340px) minmax(0, 1fr)` with a 12px gap while drafts exist.
- `data-empty="true"` collapses the grid to `minmax(0, 1fr)` and removes the detail column.
- Below 1100px the existing one-column override continues to stack the panels.

## Design-system action

- No token, DTCG, color, radius, typography, OpenUI, or Storybook change.
- `Button`, `.panel`, `.badge`, `.issues-draft-row`, and `.issues-draft-detail` are reused.
- The new composition is documented as one `DESIGN.md` component bullet; no shared component is
  introduced for one page.
- No `designmd` mutation receipt is required because no design-system artifact changes.

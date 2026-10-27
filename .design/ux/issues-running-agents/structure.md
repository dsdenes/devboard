# Issues overview — running agent list structure

## Region

The list stays the second panel of `.issues-overview__body`, beside Automation and under the page
header. No region moves and no new container appears; the panel body becomes flush so the list
rows own their full width, matching the queue and runs lists.

```
panel (surface, 1px border, 30px header)
├─ panel header: "Running agents" + "N active" (C9)
└─ panel body (flush, scrolls)
   └─ ol.issues-agent-summary
      └─ li
         └─ button.issues-agent-row            (one target per agent, C1/C2/C4/C5)
            ├─ issue number   44px mono, muted                 (C1, P0)
            ├─ title          minmax(0,1fr), one line ellipsis  (C2, P0)
            └─ meta           auto, gap 6px                     (C4/C5, P1/P0)
               ├─ needs answer badge (only with a question)     (C5)
               └─ elapsed mono-small, tabular, muted            (C4)
```

## Order and hierarchy

- Identity left, content middle, changing facts right. The eye lands on `#number`, then reads the
  operator-authored title, then checks the right edge for a block or a long run.
- The row is one button, so the whole strip is the target; there is no separate link or icon.
- Rows sort by issue number through the existing store; the list never re-sorts and never
  animates.
- Row height is 28–30px with 6px 10px padding and a `border-subtle` rule between rows. The
  header sits directly above the first row, and a `secondary` fill marks hover.

## States

| State | Rendering |
|---|---|
| Default row | Issue number, title, elapsed |
| Long title | One line, ellipsis, full text in the `title` tooltip; no column resize, no wrap |
| Question waiting | Adds a `needs answer` warning badge before the elapsed value |
| Hover | `secondary` fill from the row's left to right edge |
| Keyboard focus | 2px `ring` outline with 1px offset on the row |
| Empty | One muted line `No issue is running.` with row padding; not focusable |
| Malformed `startedAt` | The raw value renders in the elapsed slot |
| Many agents | The panel body scrolls; rows keep their height and the header stays fixed |

## Responsive priority

- ≥1100px: two overview columns; the list is the right column and keeps the flexible title.
- <1100px: single column; the list moves below Automation at full width. The fixed 44px number
  column keeps titles aligned at both widths.
- The supported floor is 1024×720. The title absorbs every width change; the number and meta
  columns never shrink and the row never scrolls horizontally.

## Accessibility

- A native `button` per row; Tab order follows issue order, Enter and Space activate.
- Visible text supplies the accessible name (`#225`, title, `needs answer`, `5m`); the badge is
  a word, not a colour-only mark; elapsed uses tabular figures but keeps mono-small type.
- The full title is available through the row's tooltip and the focus page heading.
- The empty state is a plain list item, not an interactive target.

## Out of scope

Panel header copy, the `Open Agents` button, the Automation panel, the Agents card grid, and the
Runs page list keep their current structure. No token, OpenUI entry, or Storybook story changes.

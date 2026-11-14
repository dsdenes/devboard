# Issues overview — running agent list component requirements

Catalog read: `openui.json` (Button, IconButton, Input, PageHeader, StageTrack) and
`stories/` (design-system overview, PageHeader, StageTrack). The row is a list control, like the
runs and queue rows, so it is a page-level style over a native button; the `Button` primitive
sizes and paddings do not fit a full-width list row and wrapping the row in it would add a
second focus target.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Running-agent row: number, title, elapsed, question badge | **Modify** the page-level list row style (`.issues-agent-row`) | None (list row, not a catalog primitive) | — (page-level; the badge and the ticking elapsed cell are covered by `client/lib/components/IssuesWorkspaceAgentRow.test.ts`) | 0 agents; 1 agent; 5+; long titles; missing title (`Issue N`); malformed `startedAt`; question 0/1; narrow and wide panel | Native `button`; visible text names the row; tooltip carries the full title; global focus ring; badge text states the meaning | `foreground`, `muted-foreground`, `border-subtle`, `secondary`, `warning`, `mono-small` |
| Panel body | **Reuse** `.panel__body--flush` and `.panel` | Panel (existing) | — | Empty list, many rows, scroll | Scrolling stays inside the panel | none |
| Count | **Reuse** `.panel__subtitle` | Existing | — | 0/1/many | Text, no colour-only meaning | `muted-foreground` |

## Data variety

- Rows: zero (empty line), one, and the live five-agent overview; the worker supports more and
  the body scrolls.
- Titles: short fixture titles and 120-character operator sentences; `Issue N` fallback when the
  queue has no title; tooltip always available.
- Time: 0s, minutes, hours; a non-ISO `startedAt` renders verbatim.
- Question: absent on most rows, present on at least one; the badge appears and disappears with
  the state push while the elapsed value stays.
- Width: 1440×900 two columns and 1024×720 single column; the fixed columns never shrink.

## Catalog additions

None. No token changes: every value maps to an existing custom property and the approved 2px
spacing scale (6px, 8px, 10px, 12px) plus the documented 44px identifier column. `DESIGN.md`
gains one component entry for the row; `design/tokens.json` is untouched and its projection
remains current.

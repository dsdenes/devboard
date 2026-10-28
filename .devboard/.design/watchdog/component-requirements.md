# Watchdog page — component requirements

Catalog read: `openui.json` (PageHeader, Button, IconButton, Input, StageTrack) and the stories
under `stories/`. The summary band and both tables are page-level compositions, like the Auto Scout
results table; they are not catalog primitives.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Page header | **Reuse** `PageHeader` + `.badge`; no code change | PageHeader | `page-header` story | `ok`, `error`, `stale` sync states; `never` last read | `h1` title, meta words | existing |
| Newest-cycle summary | **Compose** `.panel` + `.panel__header` + `.panel__body` + `.badge` + `.kv` facts | None (page composition) | — (covered by `verify:watchdog` summary assertions) | no cycle; `none`/`filed`/`duplicate`/`commented`/`failed`; reason present/absent; 0–3 findings; 0–many pending; invalid date | Badge text is the action word; facts use `dt`/`dd` | `surface`, `border`, `border-subtle`, `muted-foreground`, `success`, `accent`, `error`, `mono-small`, `overline`, spacing 2/4/6/8/12 |
| Filed-issue table | **Modify** the page-level `watchdog-table`: labelled header, fixed widths, sticky header, 28px rows, row hover, quiet link | None (page composition) | — (`verify:watchdog` table assertions) | 0, 1, 12, 100+ rows; long generated titles; `pending`/`implemented`/unknown; version `—`; malformed dates; failed GitHub read keeps rows | Real `table`/`th` scopes, anchor with full title, `time` with `datetime` | `background`, `surface`, `border`, `border-subtle`, `row-hover`, `foreground`, `accent`, `muted-foreground`, `mono-small`, spacing 4/8/12 |
| Cycle-history table | **Modify** the page-level list into a three-column labelled table with the same row treatment | None (page composition) | — (`verify:watchdog` cycle assertions) | 0 cycles; 1; 3; 100; no window/findings/reason cells; 0/1/many linked issues; long issue URLs; unknown action; invalid dates | Real `table`, `th` scope, row `aria-label` retaining the action and ISO start, anchors with `title` and an issue-number label, `target="_blank"` | same as the filed table |
| Empty states | **Compose** the `.scout-issues__empty` pattern with a Lucide mark | None (page composition) | — (state assertions) | no cycles; no filed issues; independent of the other panel | Decorative icon `aria-hidden`; the title is the state word | `muted-foreground`, spacing 4/16/24 |
| Action/state badges | **Reuse** `.badge`; map actions by meaning | None (CSS primitive) | `design-system` story | `filed`/`commented`/`duplicate`/`none`/`failed`; `pending`/`implemented`/unknown | Every badge carries the word | existing |

## Data variety

- Cycles: zero, one, three fixture rows, the live 100-row cap; an unknown action; no linked issues,
  one issue, and several issues per cycle; a relative or absolute URL; an unparsable date renders
  verbatim. The row has no window, count, or reason: the newest values are in the summary.
- Filed issues: zero, one, twelve; titles from 20 to 160 characters; categories of 6–30
  characters; `pending`, `implemented`, and unknown; version present, blank, and `—`.
- Viewports: 2101×1017 (two columns), 1440×900 and 1024×720 (one column of two flexible panels).
- Themes: dark and light; every color is an existing custom property that has both values.

## Catalog additions

None. Every visual element is an existing `openui.json` entry, an `app.css` primitive, or a
page-level composition. No token is added or changed, so `design/tokens.json` needs no
regeneration. `DESIGN.md` gains one component entry for the summary band and the two labelled
tables.

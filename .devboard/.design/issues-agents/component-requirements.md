# Issues — Agents fleet page component requirements

Catalog read: `openui.json` (Button, IconButton, Input, PageHeader, StageTrack) and the stories
under `.devboard/.storybook/stories/`. The agent card is a page-level composition, like the
running-agent row in the Overview; it is not a catalog primitive.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Fleet card | **Modify** the page-level `.issues-agent` card: head, fixed two-line title, meta, labeled activity, stretch | None (page composition) | — (covered by `verify:interface` card geometry and content assertions) | 0, 1, 3, many agents; one- and two-line titles; no activity; malformed start; question present/absent; narrow 360px and wide 2101px | `article` + `aria-labelledby`; real link and button | `surface`, `border`, `border-subtle`, `muted-foreground`, `accent`, `warning`, `warning-surface`, `mono-small`, spacing 2/4/6/8/10/12 |
| Page header with counts | **Reuse** `PageHeader` and `.badge` | PageHeader | `page-header` story | 0/1/many running; 0/1/many waiting; singular/plural copy | Words in each badge; heading is `h1` | existing |
| Focus action | **Reuse** `Button` `outline` | Button | `design-system` story | 0/1/many cards; disabled never needed | Native button, 28px target | existing |
| Issue link | **Reuse** the anchor style `.issues-agent__issue` | None (native link) | — | Any issue number; a missing tracker URL renders plain text with no link target | Accessible name includes number and title; plain text carries neither | `accent`, `muted-foreground`, `font-mono` |
| Activity preview | **Reuse** `IssuesAgentLog` with a new `overflow`-safe wrapper and an overline label | None (page composition) | — | Empty, one line, many lines; appends while visible; narrow card | `<pre>` text, follows newest line | `mono`, `muted-foreground` |
| Question answer | **Reuse** `IssuesAgentQuestion` unchanged | Input, Button | `design-system` story | No options, one option, many; empty answer disables submit | Native form, input label, text choices | existing |
| Empty fleet | **Reuse** `.panel` and `Button` | Button | — | Zero agents; start from Overview recovery | Plain text + one action | existing |

## Data variety

- Agents: zero, one, three fixtures, and the live fleet of more than ten.
- Titles: one-line fixture titles and 120-character operator sentences; `Issue N` fallback.
- Time: seconds, minutes, hours; a non-ISO `startedAt` renders verbatim.
- Activity: no lines, two lines, long command lines; the block clips at the card edge and scrolls
  internally without widening the card.
- Questions: absent, one option, two options with descriptions and a recommended label; answers
  clear only the submitting card.
- Width: 1024×720 (one column), 1440×900 (two columns), 2101×1017 (four columns).

## Catalog additions

None. Every component is an existing `openui.json` entry or a page-level composition. No token is
added or changed: every value maps to an existing custom property and the approved spacing scale.
`DESIGN.md` gains one component entry for the fleet card; `design/tokens.json` stays current
without regeneration.

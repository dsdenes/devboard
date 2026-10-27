# Component requirements — Issues / Agents

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Page identity and fleet summary | Reuse | `PageHeader` | `stories/page-header.stories.ts` | eyebrow, title, repo subtitle, 0–2 badges; long repo text; 0 or many agents | `h1` once; subtitle text; badges are text | None |
| Fleet count badge | Reuse | `.badge` (documented under Components) | `stories/design-system.stories.ts` | zero, one, many; count always followed by `running` | Word is present; tone is supplementary | None |
| Needs-answer badge | Reuse | `.badge` | `stories/design-system.stories.ts` | hidden at zero; 1–N questions | Word states the condition | `warning`, `warning-surface` |
| Issue action | Reuse | `Button` (`outline`) | `stories/design-system.stories.ts` | one per card; many cards; keyboard tab order | Accessible name `Focus`; issue context from the card heading | None |
| Issue link | Compose | Native `<a>` (`.mono`) | n/a | missing URL, long URL never shown, external target | Link text `#N` plus `aria-label` with the issue title | `accent`, `mono-small` |
| Agent card | Compose | `.panel` surface + `border` + radius 4 | n/a | content-sized; failed/running/question states; 1–20 cards | `<article>` with `aria-labelledby`; status word; no click-only card | `surface`, `border`, `error`, `warning`, radius 4 |
| Card log | Reuse | `IssuesAgentLog` page component | n/a | 0 lines, 1 line, thousands of lines; scrolled-up follow behaviour; failed run absent | `<pre>` remains a scroll region; no focus trap | None |
| Elapsed time | Compose | `body-small`/`mono-small` text | n/a | <1 minute, hours, invalid timestamp | Exact ISO in `title`; visible word `elapsed` | None |
| Pending question | Reuse | `IssuesAgentQuestion` page component | n/a | one/many options; recommended marker; free text; submit disabled while empty | Existing labelled input and buttons | Reuses `.choice`, `warning-surface` |
| Empty state | Compose | `.panel` + `Button` (outline) | n/a | zero agents | Heading and instruction; Overview recovery control | None |

Catalog gaps: none. `PageHeader`, `Button`, `Input`, `.badge`, and `.panel` already cover the
surface. `IssuesAgentLog`, `IssuesAgentQuestion`, and the card itself are page compositions, not
new design-system primitives. No token addition is needed; every value maps to
`design/tokens.json`.

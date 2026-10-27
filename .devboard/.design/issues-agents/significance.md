# Issues — Agents fleet page significance inventory

Scores follow the skill formula:
`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`.

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| C5 | Question text, options, answer field | 5 | 5 | 3 | 5 | 5 | 94 | P0 | Inline warning block at the card bottom, always expanded |
| C2 | Issue title | 5 | 4 | 5 | 5 | 2 | 89 | P0 | Two-line reserved slot, ellipsis, tooltip |
| C1 | Issue number | 5 | 3 | 5 | 4 | 3 | 84 | P0 | Card head, mono accent link to the tracker |
| C10 | `Focus` action | 4 | 4 | 4 | 3 | 2 | 76 | P1 | Card head, right-aligned outline control |
| C8 | Latest activity preview | 4 | 3 | 5 | 4 | 2 | 75 | P1 | Labeled monospace block that fills the card body |
| C6 | Elapsed run time | 3 | 3 | 4 | 5 | 4 | 71 | P1 | Meta line, muted tabular mono |
| C12 | Waiting-question count | 4 | 3 | 4 | 2 | 4 | 69 | P1 | Header warning badge |
| C11 | Running count | 3 | 2 | 5 | 2 | 2 | 58 | P2 | Header accent badge |
| C9 | Tracker link | 2 | 2 | 2 | 4 | 1 | 44 | P2 | The issue number is the link; no second affordance |
| C7 | Absolute start clock | 2 | 2 | 3 | 3 | 3 | 50 | P2 | Second value on the meta line after a dot |
| C14 | Empty state | 3 | 2 | 1 | 5 | 2 | 50 | P2 | Bounded panel, `No agents running` + recovery |
| C13 | Page identity | 2 | 1 | 5 | 1 | 1 | 38 | P3 | Existing page header; kept as mode context |

Dropped after scoring: per-card `running` word (C3, duplicate of the header and the page's own
purpose), per-card `needs answer` pill (C4, the question block and warning border already name
it), run identifier (C15, owned by the focus page), ACP diagnostics (C16, not an operator
decision), per-card status colour (C17, colour-only duplicate).

Order follows the score: identity (number, title) first, then the action and the live evidence
(activity, elapsed), then the aggregate counts in the header, then supporting context. The
question precedes every other card element because it is the only item that changes the
operator's next action.

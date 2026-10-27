# Issues overview — running agent list significance inventory

Scores follow the skill formula:
`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`.

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|
| C1 | Issue number | 5 | 3 | 5 | 4 | 3 | 84 | P0 | First column, mono, fixed width |
| C2 | Issue title | 5 | 4 | 5 | 5 | 2 | 89 | P0 | Flexible column, one line, tooltip |
| C4 | Elapsed run time | 3 | 3 | 4 | 5 | 4 | 71 | P1 | Right meta group, muted mono |
| C5 | Question waiting | 5 | 5 | 2 | 5 | 5 | 91 | P0 | Right meta group, warning badge |
| C9 | Running count | 3 | 2 | 5 | 2 | 2 | 58 | P2 | Panel subtitle |
| C10 | Empty state | 3 | 2 | 1 | 5 | 2 | 50 | P2 | One muted row |

Dropped after scoring: per-row `running` badge (C3, no goal/action value, duplicate), run id
(C6, unique but owned by other surfaces), ACP details (C7, diagnostics), GitHub link (C8,
duplicate affordance), per-row status colour (C11).

The order follows the score: identity first, then the flexible title, then the two facts that
change the operator's next action. The question signal outranks elapsed time and therefore takes
the right edge closest to the title where a blocked row is noticed during a scan; both share one
meta group and never wrap.

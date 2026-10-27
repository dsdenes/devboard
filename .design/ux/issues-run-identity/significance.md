# Issues agent focus — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C4 | Activity lines | 5 | 4 | 5 | 5 | 2 | 89 | P0 | Panel body; unchanged. |
| C5 | Pending question | 4 | 5 | 2 | 5 | 3 | 80 | P0 | Panel body below the log; unchanged. |
| C3 | Run status | 4 | 4 | 4 | 3 | 2 | 73 | P1 | Page-header badge; unchanged. |
| C1 | Run identifier | 3 | 4 | 4 | 5 | 2 | 72 | P1 | Output panel header, as a code chip with the full value in the tooltip. |
| C2 | Run start time | 2 | 3 | 3 | 4 | 1 | 52 | P2 | Output panel header, as a short relative label beside C1. |
| C6 | Issue number and title | 3 | 2 | 3 | 3 | 1 | 51 | P2 | Page header h1 and tab title; unchanged. |

C6 is already present and carries the operator's chosen issue. It stays in the page header and is
not repeated in the panel header; C1 and C2 are the panel header's whole content.

No item scores in the drop band. The header keeps two P1/P2 items and nothing else: the identity
and its age. C3 stays at page level so the panel header never repeats a state word.

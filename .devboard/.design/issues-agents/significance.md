# Significance inventory — Issues / Agents

Score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk).

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C5 | Pending question | 5 | 5 | 4 | 5 | 5 | 97 | P0 | Question block on the card; warning edge and `needs answer` badge |
| C1 | Issue number + link | 5 | 4 | 5 | 4 | 2 | 86 | P0 | First line of the card; linked |
| C4 | Status word | 4 | 4 | 5 | 4 | 4 | 83 | P0 | Badge beside Focus; tone by state, word always present |
| C13 | Focus control | 5 | 4 | 5 | 3 | 2 | 83 | P0 | One per card, top-right |
| C12 | Agents needing answers (count) | 4 | 4 | 4 | 5 | 3 | 81 | P0 | Header meta badge, only when non-zero |
| C2 | Issue title | 5 | 3 | 5 | 4 | 1 | 79 | P1 | Two-line clamp; full title in tooltip |
| C6 | Elapsed time | 4 | 3 | 5 | 3 | 3 | 73 | P1 | Card meta line |
| C8 | Activity stream | 3 | 3 | 5 | 3 | 2 | 64 | P1 | Bounded live log (96px, own scroll); Focus holds the tall log |
| C11 | Fleet count | 4 | 2 | 5 | 3 | 1 | 64 | P1 | Header badge |
| C14 | Empty-state explanation | 3 | 3 | 3 | 4 | 2 | 61 | P1 | Empty panel with Overview action |
| C10 | Repository | 2 | 1 | 4 | 3 | 2 | 44 | P2 | Page-header subtitle; no card repetition |
| C7 | Exact start timestamp | 2 | 2 | 3 | 2 | 1 | 41 | P2 | Elapsed tooltip only |
| C9 | Run identifier | 1 | 1 | 2 | 2 | 2 | 28 | Drop | Internal; visible in Focus output header |

Deduplication after scoring:

- C3 is C1's link and is not a separate row.
- C7 is represented by C6's `title`; both do not render as text.
- C9 is dropped; no card line restates the run id.
- C12 is a summary of C5 and stays only in the header; cards do not count themselves.

# Decision board — significance inventory

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| C2 | Board state: saved, empty, or restoring | 4 | 5 | 5 | 4 | 2 | 84 | P0 | Keep as a labeled status badge beside the title. |
| C3 | Board content: the decision markdown bytes | 5 | 4 | 5 | 5 | 1 | 87 | P0 | Keep as the read-only body below the header. |
| C1 | Surface name | 5 | 3 | 5 | 3 | 1 | 76 | P1 | Keep as the header title. |

## Deduplication
- C2 and C3:
- Kept: both.
- Removed: no second state line or draft marker anywhere in the page.
- Why: the state says whether the bytes are settled, empty, or still restoring, while the bytes
  carry the decisions themselves; neither can stand for the other.

## Notes
- Score is information importance, not visual size.
- The restore notice is C2 at work, not a fourth piece of information: it reports that the board
  has not settled yet.

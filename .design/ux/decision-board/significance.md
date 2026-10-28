# Decision board — significance inventory

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| C3 | Save action and availability | 5 | 5 | 4 | 3 | 4 | 89 | P0 | Keep; filled primary only while the draft is unsaved. |
| C2 | Board state | 5 | 5 | 5 | 4 | 2 | 91 | P0 | Keep as a labeled status badge beside the title. |
| C1 | Surface name | 5 | 3 | 5 | 3 | 1 | 76 | P0 | Keep as the header title. |

## Deduplication
- C2 and the editor's dirty marker:
- Kept: C2 in the header.
- Removed: no second textual dirty line in the header.
- Why: `flow.decisionsDirty` is one fact; the badge states it once and the editor keeps its own
  unsaved indicator inside the text surface.

## Notes
- Score is information importance, not visual size.
- Three P0 items are enough for a single-surface editor header; they stay on one compact row.

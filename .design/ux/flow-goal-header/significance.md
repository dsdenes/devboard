# Flow goal header — significance inventory

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C2 | Goal state | 5 | 5 | 5 | 4 | 2 | 91 | P0 | Keep as a labeled status badge beside the title. |
| C4 | Save action and availability | 5 | 5 | 4 | 3 | 4 | 89 | P0 | Keep; primary only while the draft is unsaved. |
| C3 | Create/recreate action | 5 | 5 | 3 | 3 | 4 | 86 | P0 | Keep; primary only when no goal exists. |
| C1 | Surface name | 5 | 3 | 5 | 3 | 1 | 76 | P0 | Keep as the header title. |

## Deduplication
- C2 and the editor's dirty state:
- Kept: C2 in the header.
- Removed: no second dirty marker in the header.
- Why: `flow.goalDirty` is one fact; the badge states it once.

## Notes
- Score is information importance, not visual size.
- The header has four P0 items because creation and saving are the only critical-path
  actions on this surface; they remain one compact row.

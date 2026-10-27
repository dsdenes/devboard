# Significance inventory — Flow / Steering

Score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk).

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C2 | Draft note | 5 | 5 | 5 | 5 | 2 | 94 | P0 | Full-width composer at the top of the panel body |
| C3 | Send action | 5 | 5 | 5 | 4 | 3 | 93 | P0 | Primary button directly under the field, right-aligned |
| C8 | Waiting summary | 5 | 4 | 4 | 4 | 3 | 85 | P0 | Header state line, 11px, word plus tone |
| C7 | Note status word | 4 | 3 | 5 | 4 | 2 | 74 | P1 | Meta row of each note |
| C4 | Note text | 4 | 2 | 4 | 5 | 1 | 67 | P1 | One line per note below the composer |
| C1 | Panel title | 4 | 2 | 5 | 2 | 1 | 61 | P1 | Header title |
| C9 | Read timing | 3 | 3 | 4 | 3 | 1 | 59 | P2 | Header state line while empty |
| C10 | Empty-state line | 3 | 3 | 3 | 4 | 1 | 59 | P2 | Panel body when no notes exist |
| C5 | Note source | 3 | 2 | 3 | 3 | 1 | 51 | P2 | Meta row |
| C6 | Note timestamp | 2 | 1 | 3 | 2 | 1 | 36 | P3 | Compact meta row; kept for correlation |
| C11 | Sidebar count | 4 | 2 | 5 | 3 | 1 | 64 | P1 | Sidebar only |
| C12 | Note identifier | 1 | 1 | 2 | 2 | 2 | 28 | Drop | Internal |
| C13 | Raw error text | 2 | 2 | 2 | 2 | 3 | 42 | P2 | Existing notification region |

Deduplication after scoring:

- C8 summarizes C7 and is the only header fact; no total count is added there (C11 is the count).
- C9 appears only while C8 has nothing to report, so the header never carries two state lines.
- C6 remains one compact value; it is optional detail, never the primary line.
- C13 stays in the global notification region, not in the panel.

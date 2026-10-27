# Significance inventory — Flow / Decision board header

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Panel title | 2 | 0 | 5 | 1 | 0 | 20×(0.7+0+0.75+0.15+0) = 32 | P3 | present as panel chrome |
| C2 | Draft state | 5 | 5 | 5 | 4 | 2 | 20×(1.75+1.25+0.75+0.6+0.2) = 91 | P0 | 11px state line under the title |
| C3 | `Save` action | 5 | 5 | 3 | 3 | 2 | 20×(1.75+1.25+0.45+0.45+0.2) = 82 | P0 | right-aligned primary |
| C4 | Save disabled state | 3 | 4 | 5 | 2 | 1 | 20×(1.05+1.0+0.75+0.3+0.1) = 64 | P1 | native `disabled`, 45% |
| C5 | Save tooltip | 2 | 2 | 2 | 2 | 0 | 20×(0.7+0.5+0.3+0.3+0) = 36 | P3 | tooltip only |
| C6 | Sidebar unsaved badge | 3 | 2 | 4 | 3 | 0 | 20×(1.05+0.5+0.6+0.45+0) = 52 | P2 | unchanged; navigation region |
| C7 | Editor dirty dot | 2 | 2 | 4 | 2 | 0 | 20×(0.7+0.5+0.6+0.3+0) = 42 | P2 | unchanged editor chrome |

The score separates the fact (C2) from its control projection (C4): the header must state the
state in words, and Save must refuse a no-op write. Neither alone is sufficient, which is why the
shipped header lost the thread — it offered a permanently enabled Save and no state at all.

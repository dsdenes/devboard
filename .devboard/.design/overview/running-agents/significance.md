# Significance inventory — Overview / Running agents

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Panel title | 2 | 0 | 5 | 1 | 0 | 20×(0.7+0+0.75+0.15+0) = 32 | P3 | present, panel chrome |
| C3 | Waiting count | 4 | 4 | 3 | 5 | 2 | 20×(1.4+1.0+0.45+0.75+0.2) = 76 | P1 | header badge, only when > 0 |
| C4 | Issue number | 3 | 3 | 5 | 3 | 0 | 20×(1.05+0.75+0.75+0.45+0) = 60 | P1 | first column |
| C5 | Issue title | 5 | 5 | 5 | 4 | 0 | 20×(1.75+1.25+0.75+0.6+0) = 87 | P0 | primary scan target |
| C6 | `needs answer` badge | 4 | 4 | 3 | 4 | 2 | 20×(1.4+1.0+0.45+0.6+0.2) = 73 | P1 | row meta |
| C7 | Elapsed short | 2 | 2 | 5 | 3 | 0 | 20×(0.7+0.5+0.75+0.45+0) = 48 | P2 | row meta, tabular |
| C8 | Started clock | 1 | 1 | 2 | 3 | 0 | 20×(0.35+0.25+0.3+0.45+0) = 27 | P3 | tooltip only |
| C9 | Selection marker | 5 | 4 | 5 | 4 | 0 | 20×(1.75+1.0+0.75+0.6+0) = 82 | P0 | row surface + edge |
| C10 | Close-issue control | 1 | 5 | 1 | 5 | 4 | 20×(0.35+1.25+0.15+0.75+0.4) = 58 | P2 | quiet, always reachable, word kept |
| C11 | Empty state | 3 | 2 | 1 | 5 | 0 | 20×(1.05+0.5+0.15+0.75+0) = 49 | P2 | visible only when empty |

Dropped by the content inventory: fleet count (duplicate of the Automation fact), run id, worker
facts, a second Agents link, per-row status words.

The close control scores P2: it is rare and not part of the primary pick, but it is irreversible on
the tracker and must stay discoverable, so it is never hidden behind hover — it is only quieted.

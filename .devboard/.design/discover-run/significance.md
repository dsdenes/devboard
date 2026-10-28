# Significance inventory — Discover / Run header

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Run state | 5 | 4 | 4 | 4 | 1 | 20×(1.75+1.0+0.6+0.6+0.1) = 81 | P0 | panel title in words |
| C2 | Stop action | 4 | 5 | 1 | 5 | 3 | 20×(1.4+1.25+0.15+0.75+0.3) = 77 | P1 | quiet destructive control, right-aligned |
| C4 | Relative start time | 3 | 3 | 3 | 3 | 0 | 20×(1.05+0.75+0.45+0.45+0) = 54 | P2 | 11px muted meta beside the identity |
| C3 | Run identifier | 1 | 2 | 2 | 4 | 0 | 20×(0.35+0.5+0.3+0.6+0) = 35 | Drop | removed; server logs keep it |
| C5 | Mode label `Discover` | 0 | 0 | 3 | 0 | 0 | 20×(0+0+0.45+0+0) = 9 | Drop | removed |
| C6 | Accent tint and border | 0 | 0 | 0 | 0 | 0 | 0 | Drop | removed |

The state (81) is the reason the panel exists; Stop (77) is the only action, so it stays in the
header although it is used rarely. Start time (54) sits below the fold of attention: present on
one line, quiet, and never widening the header. The identifier, the mode label, and the tint carry
no information the operator lacks, so they are removed rather than restyled.

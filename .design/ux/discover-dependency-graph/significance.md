# Dependency graph — significance

|ID|Information|Goal 0–5|Action 0–5|Frequency 0–5|Unique 0–5|Risk 0–5|Score 0–100|Priority|Decision|
|---|---|---|---|---|---|---|---|---|---|
|G1|Context nodes|5|3|3|4|1|75|P1|Drawn rounded node|
|G2|Directed edges|5|4|3|5|2|83|P0|Drawn arrow, end at the used context|
|G3|Arrow direction sentence|4|3|3|4|1|66|P1|11px legend above the canvas|
|G4|Fit / actual-size control|3|4|2|5|1|64|P1|Ghost control only while overflowing|

## Band reading

- **P0.** G2 is the answer the widget exists for: an edge with a readable direction. It must not be
  hidden by a scale that makes labels unreadable, and it must never be invented.
- **P1.** G1 gives the edge its endpoints. G3 removes the only ambiguity in a dependency arrow.
  G4 is P1 because it serves the secondary overview goal and is absent when the graph fits.
- G5–G8 were dropped in the inventory; they add no decision.

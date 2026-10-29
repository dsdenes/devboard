# Dependency graph — content inventory

|ID|Information|Source|Journey|Enables decision/action|Keep?|Reason|
|---|---|---|---|---|---|---|
|G1|Context nodes|`architecture.contexts[].name`|1, 2|Know what can depend on what|yes|The graph has no meaning without its participants|
|G2|Directed edges|`architecture.dependencies[].from/to`|1|Know which context reaches which|yes|The only observed dependency evidence|
|G3|Arrow direction sentence|derived from G2|1|Read an arrow without guessing|yes|One legend removes arrow ambiguity|
|G4|Fit / actual-size control|derived from G1,G2|2|Read labels or see the shape|yes|A wide graph cannot serve both goals at one scale|
|G5|Context count|derived|—|—|no|The nodes are the count|
|G6|Edge count|derived|—|—|no|The edges are the count|
|G7|Per-edge evidence and confidence|leaf `evidence`, `confidence`|1|Weigh trust|no|The card's role rows own provenance; the graph is one drawing|
|G8|Responsibility and entry points|`architecture.contexts[]`|—|—|no|The context list directly above already carries them|

## Decisions

- G1 and G2 are the whole graph. G3 is the only added sentence; it states the one fact a reader
  cannot infer from a path.
- G4 exists only while a fit would fall below the readable scale; it is not shown for a graph that fits readably.
- Isolated contexts stay as nodes. Removing them would misstate the context set; adding an edge to
  connect them would fabricate one.
- No derived counts. They would repeat the drawn nodes and edges.

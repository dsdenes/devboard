# Content inventory — Discover / Run header

Candidates come from the shipped header markup and the issue capture. The body of the panel is
out of scope except where it owns information the header should not repeat.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Run state (`Run in progress`) | `discover.active` | 1 | Yes: tells the operator the crawl is live | Keep | Primary fact of the surface; stated in words |
| C2 | Stop action | `discover.stop()` | 3 | Yes: the only action the header owns | Keep | One action per active-run surface |
| C3 | Run identifier | `discover.runId` | 2 | Helps correlate with server logs | Keep, demoted | Supporting detail; truncates, tooltip carries the whole value |
| C4 | Relative start time | `discover.startedAt` | 4 | Yes: distinguishes a fresh run from a stalled one | Keep, demoted | 11px muted meta with the exact clock as tooltip |
| C5 | Mode label `Discover` | constant | — | No: the rail, sidebar, and page title already name the mode | Drop | Duplicate fact; it consumes a second header line |
| C6 | Accent-tinted header and accent panel border | CSS | — | No: decoration, not information | Drop | State is already worded; the tint makes a selected-row cue out of a status |
| C7 | Progress detail | `discover.activity` | 1 | Terminal content | Drop from header | The terminal below owns it; repeating it would duplicate |
| C8 | Run ownership note | constant in the body | — | No decision in this header | Out of scope | Stays in the panel body, unchanged |

Retained: C1, C2, C3, C4. The header carries one identity, one state word, two low-weight meta
items, and one action.

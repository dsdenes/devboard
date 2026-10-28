# Draft detail — significance

Scores follow `20 × (0.35·Goal + 0.25·Action + 0.15·Frequency + 0.15·Unique + 0.10·Risk)`.

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Draft heading | 5 | 5 | 5 | 3 | 0 | 84 | P0 | Header title |
| C2 | File name / path | 3 | 4 | 4 | 4 | 0 | 65 | P1 | Header second line |
| C3 | Status for this draft | 5 | 4 | 5 | 4 | 0 | 82 | P0 | Header badge, filtered by path |
| C4 | Start elaboration | 5 | 5 | 3 | 5 | 0 | 84 | P0 | Header primary |
| C5 | Stop elaboration | 4 | 4 | 2 | 5 | 3 | 75 | P1 | Header quiet destructive while running |
| C6 | Start blocker reason | 2 | 4 | 2 | 3 | 1 | 51 | P2 | Start tooltip; list owns the visible reason |
| C7 | Draft / peer error | 3 | 5 | 2 | 5 | 3 | 73 | P1 | Alert directly under the header |
| C8 | Proposal text | 5 | 5 | 5 | 5 | 0 | 90 | P0 | First reading block |
| C9 | Context facts | 4 | 3 | 4 | 4 | 0 | 67 | P1 | Fact grid above the evidence |
| C10 | Visible text | 3 | 3 | 3 | 4 | 0 | 57 | P2 | Inline below the facts |
| C11 | DOM excerpt | 3 | 3 | 3 | 5 | 0 | 60 | P1 | Inline, scroll-bounded |
| C12 | Exact draft bytes | 1 | 1 | 1 | 5 | 2 | 34 | P3 | Collapsed source disclosure |
| C13 | Activity stream | 4 | 3 | 5 | 4 | 1 | 72 | P1 | Section below the proposal while a run exists |
| C14 | Question message | 5 | 5 | 3 | 5 | 2 | 88 | P0 | First block after the header while pending |
| C15 | Question options | 4 | 5 | 3 | 4 | 1 | 76 | P1 | Inside the question block |
| C16 | Free-text answer | 3 | 4 | 2 | 4 | 0 | 59 | P2 | Inside the question block |
| C20 | No-context empty state | 2 | 2 | 1 | 3 | 0 | 36 | P3 | Shown only when the marker is absent |

Dropped: C17 nested activity header (score below 20, duplicate identity), C19 `No
elaboration` subtitle (score below 20, adds no decision).

## Duplicates after scoring
- C8 and C12 carry the same bytes. C8 wins the primary surface (90 vs 34); C12 survives
  only because the README and `verify:interface` contract require the exact bytes in the DOM.
- C1 and C2 both identify the draft; both stay because one is recognisable and the other is
  durable and matches the list and the spec outcome.
- C3 is unique only after filtering by the selected path; the unfiltered global status is a
  false signal and is not a candidate.

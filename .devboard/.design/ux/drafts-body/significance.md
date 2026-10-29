# Draft goals body — significance

Scores follow `20 × (0.35·Goal + 0.25·Action + 0.15·Frequency + 0.15·Unique + 0.10·Risk)`.

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | No drafts exist | 5 | 3 | 5 | 5 | 1 | 82 | P0 | Centered empty-state title |
| C2 | Ways to create a draft | 4 | 3 | 4 | 4 | 0 | 67 | P1 | One line under the title |
| C3 | Notebook mark | — | — | — | — | — | — | decorative | Not scored; `aria-hidden` |
| C4 | Draft rows | 5 | 5 | 5 | 5 | 1 | 89 | P0 | Left panel, unchanged |
| C5 | A draft must be selected | 4 | 4 | 4 | 5 | 0 | 74 | P1 | Centered selection state |
| C6 | Pointer mark | — | — | — | — | — | — | decorative | Not scored; `aria-hidden` |
| C9 | Row `Start` | 5 | 5 | 3 | 5 | 2 | 85 | P0 | Row action, unchanged |
| C7 | Page identity/status/count | — | — | — | — | — | — | outside | Stays in the page header |

Dropped: C8 (second empty panel, adds no decision), C10 (duplicate creation action), C11
(duplicated count).

## Duplicates after scoring

- C1 subsumes the old `No drafts exist.` line and the count's zero value in the body.
- C2 names the two creation paths once; the header owns the `New goal` control.
- C4 and C5 are complementary: the list is the content, the selection state is the explanation for
  the detail column's current emptiness.

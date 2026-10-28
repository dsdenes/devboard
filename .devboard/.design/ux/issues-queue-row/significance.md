# Issues queue row — significance

Score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk).

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| Q2 | Issue title | 5 | 4 | 5 | 5 | 1 | 87 | P0 | First screen, flexible middle track |
| Q1 | Issue number + tracker link | 4 | 5 | 5 | 5 | 1 | 85 | P0 | First screen, leading 44px track |
| Q6 | Lifecycle `running` | 4 | 4 | 5 | 3 | 1 | 74 | P1 | Trailing badge in the meta group |
| Q4 | Goal label | 3 | 3 | 2 | 4 | 1 | 56 | P2 | Small badge, same meta group, ahead of the state |
| Q5 | Lifecycle `pending` | 2 | 3 | 5 | 3 | 0 | 53 | P2 | Same P1 slot as Q6; the state slot is always present |
| Q11 | Repository label | 3 | 1 | 4 | 4 | 0 | 50 | P2 | Page header, one occurrence |
| Q12 | Pending / open counts | 3 | 2 | 3 | 3 | 0 | 49 | P2 | Page header and sidebar, one occurrence each |
| Q7 | Lifecycle `handled` | 2 | 3 | 2 | 3 | 1 | 46 | P2 | Same state slot; rare but not omitted |

Rules applied:

- Q5 and Q7 score below Q6 because running is the decision-changing state; they
  still share the trailing state slot so the row's grammar never changes.
- Q4 stays small and secondary to the state word: it is an attribute, and the
  accent tone already marks it without competing with the title.
- Q11 and Q12 are page-level and appear once; the row does not repeat them.
- Nothing on the row is dropped after scoring; the row carries exactly the
  identifiers, the title, one attribute, and one state.

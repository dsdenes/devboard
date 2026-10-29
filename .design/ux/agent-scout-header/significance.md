# Auto Scout agent header — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Page name `Auto Scout` | 5 | 3 | 5 | 5 | 1 | 82 | P0 | Header identity; never truncates. |
| C2 | One-sentence purpose | 4 | 1 | 5 | 4 | 1 | 62 | P1 | Inline with the name on wide rows; ellipsizes at the guard. |
| C3 | Lifecycle word | 5 | 5 | 5 | 4 | 3 | 93 | P0 | Header status cluster; badge with the word. |
| C4 | Forge sync word | 4 | 3 | 5 | 4 | 3 | 76 | P1 | Header status cluster, beside C5. |
| C5 | Last read clock | 3 | 2 | 5 | 3 | 2 | 59 | P2 | Header status cluster; the age of C4. |
| C6 | Last scan clock | 2 | 2 | 4 | 3 | 1 | 47 | P2 | Footer, cadence group. |
| C7 | Next scan clock | 2 | 2 | 4 | 3 | 1 | 47 | P2 | Footer, cadence group. |
| C8 | Start/Stop | 5 | 5 | 5 | 5 | 4 | 98 | P0 | Header action; the only filled primary. |
| C9 | Scan interval field | 4 | 4 | 3 | 3 | 1 | 68 | P1 | Footer, cadence group. |
| C10 | Save cadence | 3 | 4 | 3 | 2 | 1 | 58 | P2 | Footer, immediately after C9 and the clocks. |
| C11 | Hourly filing cap | 4 | 4 | 3 | 3 | 2 | 70 | P1 | Footer, limits group. |
| C12 | Open-issues cap | 4 | 3 | 3 | 3 | 2 | 65 | P1 | Footer, limits group. |
| C13 | Save limits | 3 | 4 | 3 | 2 | 1 | 58 | P2 | Footer, immediately after the limit fields. |
| C14 | Cadence validation | 2 | 3 | 2 | 3 | 2 | 48 | P2 | Alert below the header (existing position). |
| C15 | Limits validation | 2 | 3 | 2 | 3 | 2 | 48 | P2 | Alert below the header (existing position). |
| C16 | Sync failure reason | 3 | 4 | 3 | 5 | 3 | 71 | P1 | Alert below the header; the header keeps the word. |
| C17 | Worker error | 3 | 4 | 2 | 4 | 4 | 67 | P1 | Alert below the header. |
| C18 | Legacy timer block | 4 | 5 | 1 | 5 | 4 | 79 | P1 | Conditional banner below the header. |

## Placement

- **P0** (C1, C3, C8) forms the header row: the page is named, its run state is stated, and the
  only run action sits beside that state.
- **P1** (C2, C4, C9, C11, C12) stays on the page. C2 joins the identity line; C4 joins the status
  cluster; C9, C11, and C12 occupy the header footer beside their own save controls.
- **P2** (C5, C6, C7, C10, C13, C14, C15) is supporting: the clocks and save controls sit inside
  the group they qualify; validation messages appear only after a rejected save, in the existing
  alert position below the header.
- **Outside the header** (C16, C17, C18) allows the header to stay one identity row plus one
  settings band; a long failure sentence or a conditional unblock control never inflates it.

No item is dropped: each retained fact belongs to a declared journey, and no two items enable the
same decision from different sources.

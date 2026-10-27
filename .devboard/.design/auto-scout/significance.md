# Auto Scout — significance inventory

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C4 | Start/Stop action | 5 | 5 | 4 | 3 | 4 | 89 | P0 | Keep; the only filled action in the page header. |
| C3 | Lifecycle state | 5 | 4 | 5 | 4 | 3 | 88 | P0 | Keep; badge in the header meta line beside the title. |
| C15 | Filed issue title and link | 5 | 4 | 3 | 4 | 2 | 80 | P0 | Keep; first table column, the link target. |
| C5 | GitHub-read state | 4 | 4 | 4 | 4 | 3 | 78 | P1 | Keep; second header badge after lifecycle. |
| C14 | Limits validation error | 4 | 4 | 3 | 4 | 2 | 73 | P1 | Keep; inline alert under the fields. |
| C22 | Worker error | 4 | 4 | 3 | 4 | 2 | 73 | P1 | Keep; full-width alert banner under the header. |
| C19 | Scan activity | 4 | 3 | 4 | 4 | 2 | 71 | P1 | Keep; right column, below the table. |
| C1 | Surface title | 5 | 2 | 5 | 3 | 1 | 71 | P1 | Keep; the page's single `h1`. |
| C7 | Last read error | 4 | 3 | 3 | 4 | 2 | 68 | P1 | Keep; named banner with `role="alert"`. |
| C8 | Pending issues count | 3 | 4 | 4 | 3 | 2 | 66 | P1 | Keep; the lead fact in the worker panel. |
| C12 | Limits values | 3 | 4 | 2 | 4 | 3 | 65 | P1 | Keep; two labeled inputs and Save. |
| C10 | Next attempt | 3 | 3 | 3 | 4 | 2 | 61 | P1 | Keep; worker fact, formatted as a local time. |
| C16 | Created, category, state, shipped | 3 | 3 | 3 | 3 | 2 | 58 | P2 | Keep; remaining table columns, read-only. |
| C2 | Repository origin | 3 | 3 | 2 | 4 | 2 | 58 | P2 | Keep; header subtitle. |
| C17 | Filed issues count | 3 | 3 | 3 | 3 | 1 | 56 | P2 | Keep; table panel header. |
| C6 | Last successful read | 3 | 2 | 3 | 3 | 1 | 51 | P2 | Keep; beside the read badge. |
| C13 | Limits explanation | 2 | 4 | 2 | 3 | 1 | 51 | P2 | Keep; one hint under the fields. |
| C21 | Filing notice | 3 | 2 | 3 | 3 | 1 | 51 | P2 | Keep; success banner after a filing pass. |
| C18 | Empty table state | 2 | 2 | 2 | 4 | 1 | 44 | P2 | Keep; two lines, no decorative container. |
| C9 | Worker pid and version | 2 | 2 | 2 | 3 | 1 | 41 | P2 | Keep; one compact worker fact. |
| C20 | Activity empty state | 2 | 2 | 2 | 3 | 1 | 41 | P2 | Keep; one muted line inside the log. |
| C11 | Scan identity | 2 | 2 | 2 | 2 | 1 | 38 | P3 | Keep once, as the activity panel subtitle; not in the worker facts. |

## Deduplication
- C8 and C17 count different sets (open scout issues versus every filed row); labels say
  so, and neither is repeated elsewhere.
- C5 and C6 form one read-health unit; C7 carries the failure reason in the banner.
- C11 appears only in the activity header, not again among the worker facts.

## Notes
- Score is information importance, not visual size.
- The page has three P0 items: the action, the lifecycle, and the filed-issue title. They
  occupy the header and the first table column, both visible before scrolling.

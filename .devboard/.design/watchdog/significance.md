# Watchdog page — significance inventory

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`.

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| C6 | Newest cycle action | 5 | 4 | 5 | 5 | 4 | 93 | P0 | First line of the summary, badge plus word |
| C7 | Newest cycle reason | 5 | 3 | 5 | 4 | 4 | 86 | P0 | Beside the action, 12px foreground |
| C2 | GitHub sync state | 4 | 3 | 5 | 5 | 5 | 85 | P0 | Page header meta badge |
| C17 | Filed issue title and link | 4 | 5 | 4 | 4 | 4 | 84 | P0 | First table column, the only link |
| C8 | Newest cycle findings | 4 | 3 | 5 | 3 | 3 | 75 | P1 | Compact facts line |
| C9 | Newest cycle pending filings | 4 | 3 | 4 | 4 | 4 | 76 | P1 | Compact facts line |
| C20 | Filed issue state | 3 | 4 | 4 | 5 | 4 | 78 | P1 | State badge column |
| C21 | Shipped version | 3 | 3 | 3 | 5 | 3 | 68 | P1 | Mono column, `—` when absent |
| C14 | Cycle action | 4 | 3 | 4 | 3 | 3 | 71 | P1 | Labelled column with badge |
| C16 | Cycle reason | 3 | 2 | 4 | 3 | 3 | 60 | P1 | Labelled column, muted |
| C11 | Newest cycle age | 4 | 2 | 5 | 3 | 3 | 72 | P1 | Summary panel header |
| C22 | Filed/pending counts | 3 | 2 | 4 | 2 | 3 | 56 | P2 | Filed panel subtitle |
| C10 | Newest cycle start | 2 | 1 | 4 | 2 | 2 | 42 | P2 | Compact facts line, exact clock |
| C12 | Cycle start | 2 | 1 | 4 | 1 | 2 | 40 | P2 | History column |
| C13 | Cycle window | 2 | 1 | 2 | 3 | 1 | 36 | P3 | History column, muted, tooltip-free |
| C15 | Cycle findings | 3 | 1 | 4 | 1 | 2 | 49 | P2 | History column, tabular |
| C18 | Issue category | 2 | 1 | 3 | 2 | 2 | 38 | P3 | Narrow mono column |
| C19 | Issue filed time | 2 | 1 | 3 | 1 | 2 | 36 | P3 | History-style mono column |
| C3 | Last read | 2 | 1 | 4 | 1 | 3 | 42 | P2 | Header meta, 11px muted |
| C4 | Sync error | 4 | 4 | 1 | 5 | 5 | 81 | P0 | Alert under the header, only on failure |
| C5 | Page read error | 4 | 3 | 1 | 4 | 4 | 73 | P1 | Alert under the header, only on failure |
| C23 | Empty history | 3 | 1 | 1 | 4 | 2 | 47 | P2 | Centered empty stack |
| C24 | Empty filed issues | 3 | 1 | 1 | 4 | 2 | 47 | P2 | Centered empty stack |
| C1 | Page identity | 2 | 1 | 5 | 1 | 1 | 38 | P3 | Existing page header |

## Bands

- **P0** (80–100): sync state, newest action and reason, sync error, the filed-issue link. These
  occupy the page header and the summary band, above the fold.
- **P1** (60–79): counts, issue state and version, history action/reason, newest age, page read
  error. They fill the two panels in the main flow.
- **P2** (40–59): exact clocks, history findings, counts subtitle, empty states.
- **P3** (< 40): category, filed time, window, page identity. They stay because they are contract
  columns or page chrome, but they never take emphasis from P0/P1.

Deduplicated twice: no item repeats the newest action in a second visual form, and the summary
does not repeat every history field. The history row for the newest cycle is retained because the
panel is the complete audit list.

## Order

Header (identity + trust) → summary (last outcome in one sentence) → filed issues (the outcome the
operator acts on) → cycle history (the audit). Width follows the same order: the filed-issue table
takes the larger column on wide viewports.

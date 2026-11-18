# Watchdog page — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

Scores describe the shipped surface: the shared agent page for the `watchdog` family and the
status-bar indicator.

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| D1 | Forge read state | 5 | 5 | 5 | 5 | 4 | **96** | P0 | Header badge, first fact |
| D2 | Last successful read | 5 | 4 | 5 | 5 | 3 | **91** | P0 | Beside D1 in the header |
| D3 | Lifecycle and peers | 5 | 5 | 5 | 4 | 3 | **93** | P0 | Bar dot, Start/Stop, peers badge |
| D7 | Pending filings | 5 | 5 | 4 | 5 | 4 | **95** | P0 | Filed-issues subtitle |
| D9 | Filed issue title anchor | 5 | 5 | 5 | 3 | 3 | **90** | P0 | First table column and popover link |
| D12 | Tracker state | 5 | 4 | 3 | 2 | 3 | 75 | P1 | Table badge |
| D14 | Retained cycle history | 4 | 4 | 3 | 4 | 2 | **73** | P1 | Expanded activity log |
| D15 | Newest action and age | 4 | 4 | 5 | 5 | 3 | **84** | P1 | Status-bar indicator |
| D16 | Newest cycle summary, reason, issues | 4 | 4 | 3 | 4 | 2 | **73** | P1 | Indicator popover |
| D17 | Errors, notice, gate, timer block | 3 | 5 | 2 | 5 | 4 | 75 | P1 | Alerts and blocks under the header |
| D4 | Live worker versions | 3 | 2 | 4 | 3 | 1 | 54 | P2 | Header chips |
| D5 | Cadence and clocks | 3 | 3 | 3 | 2 | 2 | 55 | P2 | Settings footer |
| D6 | Filing limits | 2 | 2 | 2 | 1 | 1 | 35 | P2 | Settings footer |
| D8 | Filed count | 3 | 3 | 3 | 1 | 1 | 50 | P2 | Panel subtitle |
| D10 | Filed issue category | 3 | 2 | 3 | 2 | 1 | 47 | P2 | Table column |
| D11 | Filed time | 3 | 3 | 3 | 2 | 1 | 52 | P2 | Table column |
| D13 | Shipped version | 4 | 2 | 2 | 2 | 2 | 51 | P2 | Table column |
| D18 | "No prompt" explanation | 1 | 1 | 1 | 1 | 1 | 20 | P2 | Prompt disclosure |

## Resulting hierarchy

- **P0 — first screen, no scroll:** the forge read and its last read (header), the family's
  lifecycle and peers (bar), the pending filings and filed count (panel subtitle), and the filed
  issue titles. The header and the first table column carry them.
- **P1 — one click or one scroll:** the tracker state column, the retained cycle history in the
  bar's log, the indicator's action and age with its popover, and the error, notice, gate, and timer
  blocks.
- **P2 — supporting detail:** worker versions, cadence and clocks, filing limits, the category,
  filed time, and shipped version columns, the filed count on its own, and the prompt explanation.

## Deduplication after scoring

- No newest-cycle panel or stat rail: the bar's line, the indicator, and the popover state the
  newest cycle at three densities without a fourth summary card.
- Pending filings are stated once, in the filed-issues subtitle; the bar's lines and the popover
  state counts where they already are.
- No separate cycle-history table: the retained history is the activity log, one line per cycle,
  and it repeats no column that the filed-issues table owns.
- The generation history of the retired two-column page is not a fact of the shipped surface, so
  the packet carries no width or breakpoint that another packet could contradict.

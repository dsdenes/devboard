# Watchdog page — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Sync state | 5 | 5 | 5 | 5 | 4 | **96** | P0 | Page header meta, first fact |
| C2 | Last successful read | 5 | 4 | 5 | 5 | 3 | **91** | P0 | Beside C1 in the header |
| C3 | Newest cycle start / age | 5 | 4 | 5 | 4 | 2 | **86** | P0 | Newest-cycle header and stat |
| C4 | Newest cycle action | 5 | 4 | 5 | 4 | 3 | **88** | P0 | Badge in the newest-cycle header |
| C5 | Newest cycle reason | 4 | 5 | 4 | 5 | 3 | **84** | P0 | One muted line under the stats |
| C6 | Newest finding count | 4 | 3 | 5 | 3 | 1 | **68** | P1 | Stat in the newest-cycle body |
| C7 | Pending filings | 5 | 5 | 4 | 5 | 4 | **93** | P0 | Stat in the newest-cycle body |
| C8 | Sync / endpoint error text | 3 | 5 | 2 | 5 | 4 | **72** | P1 | Alert below the header |
| C9 | Retained cycle rows | 3 | 4 | 3 | 5 | 2 | **67** | P1 | Bounded panel, right column |
| C10 | Cycle issue links | 3 | 3 | 3 | 4 | 1 | **56** | P2 | Third track of each cycle row |
| C11 | Filed issue title anchor | 4 | 4 | 3 | 3 | 2 | **68** | P1 | First column of the table |
| C12 | Filed issue category | 3 | 2 | 3 | 2 | 1 | **47** | P2 | Muted second column |
| C13 | Filed issue time | 3 | 3 | 3 | 2 | 1 | **52** | P2 | Third column |
| C14 | Filed issue state | 5 | 4 | 3 | 2 | 3 | **75** | P1 | Badge column |
| C15 | Filed issue version | 4 | 2 | 2 | 2 | 2 | **51** | P2 | Last column, mono |
| C16 | Filed count | 3 | 3 | 3 | 1 | 1 | **47** | P2 | Panel header |

## Resulting hierarchy

- **P0 — first screen, no scroll:** sync state + last read (header meta), newest-cycle age,
  action, pending filings, and its reason. These become one header plus one compact summary
  panel.
- **P1 — main flow:** the deployed-fix state (C14) and the filed issue rows (C11), then the
  bounded cycle history (C9, with C10 one panel scroll away).
- **P2 — supporting columns:** findings, category, filed time, version, filed count. They stay
  visible as table columns and a stat, never as separate cards.
- C17–C22 from the inventory are dropped; no retained item scores below 40.

## Deduplication after scoring

- Pending filings (C7) is stated once, in the newest-cycle summary. The filed panel's subtitle
  names only its own row count (C16); it no longer repeats the pending count.
- The `Issues` eyebrow is dropped because the rail's selected tab and the sidebar entry name the
  mode. The `Watchdog` title stays as the page's only h1.
- History rows keep only time, action, and links; a per-row reason or finding count would repeat
  the summary for the newest row and add 100 lines of low-value text.

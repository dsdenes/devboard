# Discover mode — significance inventory

Scores follow the skill formula:
`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`.

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Project name, full path on demand | 4 | 2 | 5 | 4 | 3 | 71 | P1 | Keep in the page header and sidebar |
| C2 | Freshness: commit and discovery time | 4 | 3 | 5 | 5 | 3 | 79 | P1 | Keep beside the project name |
| C3 | Stale marker | 5 | 4 | 4 | 5 | 4 | 90 | P0 | Keep in the header identity |
| C4 | One-line project definition | 4 | 2 | 5 | 5 | 2 | 72 | P1 | Keep under the title |
| C5 | Run control and disabled reason | 5 | 5 | 4 | 5 | 4 | 95 | P0 | Keep in the header, one primary action |
| C6 | Active run: id, start, stop | 5 | 5 | 3 | 5 | 5 | 94 | P0 | Keep as the first region while active |
| C7 | Activity stream | 3 | 3 | 2 | 5 | 2 | 61 | P1 | Keep inside the active-run region |
| C8 | Question and answer | 5 | 5 | 1 | 5 | 4 | 86 | P0 | Keep immediately below the run region |
| C9 | Error | 5 | 5 | 2 | 5 | 5 | 91 | P0 | Keep at the top of the page body |
| C10 | Interrupted-run notice | 4 | 4 | 1 | 5 | 4 | 74 | P1 | Keep as a single line under the header |
| C11 | Transition notice | 2 | 2 | 2 | 4 | 1 | 44 | P2 | Removed; the run tag already reports a live run |
| C12 | Warnings count and entry | 4 | 3 | 3 | 5 | 4 | 75 | P1 | Sidebar entry only, with count |
| C13 | Commands table | 5 | 5 | 5 | 5 | 3 | 96 | P0 | First card in the main column |
| C14 | Testing summary, levels, suite command | 5 | 4 | 4 | 5 | 3 | 88 | P0 | Second card in the main column |
| C15 | Runtime facts | 3 | 2 | 3 | 4 | 2 | 56 | P2 | Rail, inside the platform card |
| C16 | Delivery facts: deployment, CI, branching | 3 | 3 | 3 | 5 | 3 | 66 | P1 | Rail, one grouped card |
| C17 | Stack chips | 3 | 1 | 3 | 4 | 1 | 49 | P2 | Rail, one chip band |
| C18 | Bounded contexts | 5 | 3 | 3 | 5 | 2 | 78 | P1 | Full-width card below the columns |
| C19 | External boundaries and shared kernels | 4 | 2 | 3 | 4 | 2 | 63 | P1 | Inside the bounded-context card |
| C20 | Glossary term table | 5 | 4 | 4 | 5 | 3 | 88 | P0 | The glossary page body |
| C21 | Glossary search | 4 | 3 | 4 | 3 | 1 | 66 | P1 | Header action on the glossary page |
| C22 | Minimum-use threshold | 3 | 2 | 2 | 3 | 1 | 48 | P2 | Header action, secondary, with output |
| C23 | Term detail | 4 | 3 | 3 | 5 | 2 | 71 | P1 | Main pane of the term page |
| C24 | Labels and related terms | 2 | 2 | 2 | 3 | 1 | 41 | P2 | Detail pane of the term page |
| C25 | Skill editor and save | 5 | 5 | 4 | 5 | 4 | 95 | P0 | The skill page body |
| C26 | Skill restore or recreate | 4 | 4 | 1 | 5 | 3 | 72 | P1 | Skill page header action |
| C27 | Skill state and dirty marker | 5 | 4 | 4 | 4 | 3 | 85 | P0 | Skill page header; sidebar shows exceptions only |
| C28 | Skill purpose | 3 | 2 | 3 | 4 | 1 | 54 | P2 | One line under the skill title |
| C29 | Warning detail list | 3 | 3 | 2 | 4 | 3 | 60 | P1 | The warnings page body |
| C30 | Manual remote target | 2 | 2 | 1 | 5 | 2 | 46 | P2 | Below the header, source checkout only |
| C31 | Clone progress | 4 | 4 | 1 | 5 | 2 | 70 | P1 | Inside the remote card while cloning |
| C32 | Mode navigation | 5 | 4 | 5 | 5 | 2 | 89 | P0 | Shell rail, always visible |
| C33 | Discover navigation: sections and five skills | 5 | 4 | 5 | 4 | 2 | 86 | P0 | Sidebar, always visible |
| C34 | Skill exception state in navigation | 4 | 3 | 4 | 3 | 2 | 68 | P1 | Sidebar meta for `edited` and `missing` only |
| C35 | Empty-state explanation and written paths | 4 | 3 | 1 | 5 | 3 | 67 | P1 | Empty page body, replacing all sheet cards |
| C36 | Status-bar facts | 3 | 2 | 5 | 3 | 1 | 57 | P2 | Shell, unchanged |
| C45 | Commands found n of 8 | 3 | 2 | 4 | 3 | 1 | 54 | P2 | Commands card header meta |
| C47 | Skill file path | 3 | 3 | 3 | 4 | 1 | 59 | P2 | Skill page header, mono |

## Deduplication

- **Project identity** (C1) and **freshness** (C2): one header block, two distinct facts. The full
  path appears once in the sidebar; the visible title is the last path segment.
- **Skill state** (C27) and **navigation exception state** (C34): the page header always states
  the state; the sidebar states it only when it is `edited` or `missing`. `generated` is the
  quiet default and is not repeated in navigation.
- **Warnings** (C12, C29): one sidebar entry with a count, one page with full text. The banner row
  that repeated the count above the sheet is removed.
- **Test command** (C14): the command table is the complete command set; the Testing card pairs
  the same test command with the test count and levels. The table suppresses a `tryOut` row that
  repeats the test command.
- **Bounded-context count**: dropped (C46 scored P3). The card lists the contexts; a count adds a
  number to scan, not a decision.

## Removed after scoring

- C37 concept id, C38 grounding count, C44 origin as prominent facts: no decision depends on them.
- C39 notifications in the Discover sidebar: duplicate of the status-bar bell.
- C40 warning banner, C41 busy repeat, C42 skill count, C43 raw path title: redundant copies.
- C46 bounded-context count: P3.

## Notes

- The score is information importance, not visual size. A P2 fact still gets a visible row; it
  just never outranks a P0 fact in position or emphasis.
- C6, C8, C9 and C31 are conditional: they render only while the state exists. Conditional P0
  items move to the top of the page body when present.

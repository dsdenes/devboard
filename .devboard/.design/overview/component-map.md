# Component map — Discover Overview

| Mock element | Role | Existing component / token | Decision |
|---|---|---|---|
| Activity bar, sidebar, status bar | workspace chrome | `ActivityBar`, `Sidebar`, `StatusBar` | reuse; one page per mode, no tab strip |
| Page identity (`h1`, dirty/stale badges) | project, working-tree and freshness state | `.discover-head__title`, `.badge[data-tone]` | extend: header composition; badge reuse |
| Freshness meta line | commit, discovery time, definition provenance | `.discover-head__meta`, `.discover-conf`, `.discover-evidence`, `freshness` from `discover.svelte` | extend: restored `data-testid="discover-freshness"` |
| Definition lead | one-sentence project definition | `.discover-head__definition` | extend: page lead type |
| `Re-discover` / `Discover project` | primary action | `Button` (default), `discover.startDisabled/startTitle` | reuse |
| `Run and verify`, `Platform`, `Delivery` | section group labels | `.discover-group__title` | extend: mirrors `.sidebar-group__title` rhythm |
| Commands panel | task and command table | `.panel`, `.panel__header`, `DataTable` | reuse; `$` prefix in the command cell, note below |
| Test pyramid | level shape | `PyramidChart` | extend: `compact` prop (220×132, 9.5px labels) |
| Test stats and whole-suite line | totals and command | `.discover-stats`, `.discover-stat`, `.discover-command-line` | reuse classes, restyled inline |
| Level table | level, count, paths, fixtures | `DataTable` | reuse, columns Level/Tests/Paths & fixtures |
| Runtime / Deployment / CI / Branching facts | label/value facts | `.discover-facts`, `.discover-fact` | extend: compact definition list |
| Stack band | declared stack entries | `.discover-band`, `.discover-chips`, `.discover-chip` | extend: full-width chip band |
| Architecture context table | five bounded contexts | `DataTable` | reuse; fixed column widths via section CSS |
| External boundaries / shared kernels | chip lists | `.discover-subtitle`, `.discover-chips` | extend: chip group |
| Dependency map | binaries, packages, services, key deps | `.discover-dependencies`, `.discover-chips` | extend: two-column chip grid |
| Not observed ledger | unknown fields and reasons | `DataTable` (`Section`, `Field`, `Why it is unknown`) | extend: `sectionUnknowns` helper |
| Evidence chips | repository provenance | `.discover-evidence` (`data-testid="discover-evidence"`) | extend: restored from `4555581` |
| Confidence labels | observed/declared/inferred tally | `.discover-conf` (`data-testid="discover-confidence"`) | extend: section-level, text + dot |
| Active run panel | run id, start time, stop, activity | `.panel`, `Terminal`, `Button` | reuse (same markup, moved component) |
| Question panel | run question and answer | `.panel`, `.choice-list`, `.answer-form`, `Button` | reuse unchanged |
| Empty state | first-run explanation and outputs | `.panel`, `.discover-empty__body`, `.discover-writes` | extend: two-column copy/output list |
| Error / warning / interrupted banners | run state | `.message`, `.badge` | reuse untouched |
| Glossary, skill, term, warnings pages | other Discover pages | existing markup and CSS | reuse untouched |

## New modules

| Module | Contents | Why |
|---|---|---|
| `client/lib/components/DiscoverOverview.svelte` | the whole Overview surface: header, sheet, active/question panels, empty state, provenance, unknowns | `DiscoverWorkspace.svelte` keeps the other pages and delegates the sheet; the surface is ~500 lines and has its own data derivation |
| `discover-format.ts` additions | `sectionLeaves`, `sectionProvenance`, `sectionUnknowns` | provenance and the ledger need the same leaf traversal; shared and typed rather than duplicated in markup |

## Token additions

None. Every value comes from `app.css`; radius 3/4/999, spacing 4–24, type 9.5–20, colors from the
existing palette. `PyramidChart` keeps `--accent` and `--foreground`.

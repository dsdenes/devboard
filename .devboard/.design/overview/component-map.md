# Component map — Discover Overview

| Mock element | Role | Existing component / token | Decision |
|---|---|---|---|
| Activity bar, sidebar, status bar | workspace chrome | `ActivityBar`, `Sidebar`, `StatusBar` | reuse; one page per mode, no tab strip |
| Page identity (`h1`, stale badge) | project and freshness state | `.discover-head__title`, `.badge[data-tone]` | extend: header composition; no dirty badge |
| Freshness meta line | commit and discovery date | `.discover-head__meta`, `freshness` from `discover.svelte` | extend: `data-testid="discover-freshness"` |
| Definition lead | one-sentence project definition | `.discover-head__definition` | extend: page lead type |
| `Re-discover` / `Discover project` | primary action | `Button` (default), `discover.startDisabled/startTitle` | reuse |
| `Run and verify`, `Platform`, `Delivery` | section group labels | `.discover-group__title` | extend: mirrors `.sidebar-group__title` rhythm |
| Commands panel | task and command table | `.panel`, `.panel__header`, `DataTable` | reuse; no header row, `$` prefix in the command cell |
| Test pyramid | level shape | `PyramidChart` | extend: `compact` prop (220×132, 9.5px labels) |
| Test stats and whole-suite line | totals and command | `.discover-stats`, `.discover-stat`, `.discover-command-line` | reuse classes, restyled inline |
| Level table | level, count, paths, fixtures | `DataTable` | reuse, columns Level/Tests/Paths & fixtures |
| Runtime / Deployment / CI / Branching facts | label/value facts | `.discover-facts`, `.discover-fact` | extend: compact definition list, comma-separated values |
| Stack band | declared stack entries | `.discover-band`, `.discover-chips`, `.discover-chip` | extend: full-width chip band; installed packages link to their repository |
| Architecture context table | bounded contexts | `DataTable` | reuse; first column headed `Bounded context` |
| External boundaries / shared kernels | chip lists | `.discover-subtitle`, `.discover-chips` | extend: chip group |
| Active run panel | run id, start time, stop, activity | `.panel`, `Terminal`, `Button` | reuse (same markup, moved component) |
| Question panel | run question and answer | `.panel`, `.choice-list`, `.answer-form`, `Button` | reuse unchanged |
| Error / warning / interrupted banners | run state | `.message`, `.badge` | reuse untouched |
| Glossary page | context cards, term table, term detail | `DiscoverWorkspace`, `DataTable`, `ConceptKind` | reuse; Kind first, no header row, fixed Kind/Term widths |
| Skill, term, warnings pages | other Discover pages | existing markup and CSS | reuse untouched |

## New modules

| Module | Contents | Why |
|---|---|---|
| `client/lib/components/DiscoverOverview.svelte` | the whole Overview surface: header, sheet, active/question panels | `DiscoverWorkspace.svelte` keeps the other pages and delegates the sheet; the surface is ~500 lines and has its own data derivation |
| `lib/dependencies.ts` | `dependencyName`, `normalizeRepositoryUrl` | the overview and the server derive the same package name and repository URL; one pure module keeps them from drifting |
| `server/discover.ts` additions | `packageRepository`, `dependencyRepositories` | a chip links only to a repository an installed manifest declares; no URL is guessed |
| `DataTable` additions | `hideHeader`, `columnWidths` (`colgroup`, fixed layout) | commands and glossary drop their header row and align columns across cards |

## Token additions

None. Every value comes from `app.css`; radius 3/4/999, spacing 4–24, type 9.5–20, colors from the
existing palette. `PyramidChart` keeps `--accent` and `--foreground`.

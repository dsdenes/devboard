# Decisions — Discover Overview

## Composition

- **A sheet, not a card grid.** Commands and Testing are the only raised `--surface` panels; runtime,
  delivery, and architecture sit flat on the canvas separated by hairlines.
  The previous auto-fit grid produced 11 equal cards, two columns with 100–200px holes, and no hierarchy.
  The flat/raised split makes the two operational blocks lead and keeps the page at ~1900px instead of ~2600px.
- **Two-column spine with full-width structure.** `Run and verify` on the left, `Platform` and `Delivery`
  in a rail, then Stack and Architecture across the page. The rail is ~700px
  against ~700px on the left, so the sheet ends without the old blank band. Below 1240px viewport the
  columns collapse to one in reading order.
- **Definition is the lead.** The project name, definition, and freshness read as one
  masthead; there is no page title repeating the tab name when artifacts exist.
- **Freshness is a meta line, not a panel.** `discover-freshness` carries the commit and the localized
  discovery date. The operator asked for the date only, so the word `Discovered` and the
  definition-confidence/evidence tail are gone. The working tree's `dirty` flag stays in the sheet but
  no longer renders a badge. The `stale` badge and its title are shown only when the fingerprint differs.
- **Stack is a full-width band.** Eight chips need one line; keeping Stack beside Runtime duplicated
  Node/npm and unbalanced the rail. The band sits after the spine as a quiet change of texture.
  Exact duplicate values (Node.js, npm) are kept because both are declared leaves; hiding one would make
  the stack list disagree with its manifest.
- **Environments has no card.** The crawled value is `unknown` (`none detected`), so the section is omitted.

## Removed after operator review

The operator reported the same surfaces as noise, so these are gone from the rendered page while the
stored sheet stays unchanged:

- **Every section footer.** Confidence tallies (`discover-confidence`) and evidence paths
  (`discover-evidence`) no longer render; the operator does not read them. The masthead carries no
  confidence or evidence either.
- **The unknowns ledger.** The `Not observed` section is removed in full; an ungrounded field is not
  advertised as a table.
- **The repeated dependency map.** `Entry points and dependencies` duplicated the Stack band, so the
  section and its `DEPENDENCY_GROUPS` derivation are removed. Stack stays the one place libraries appear.
- **Static lead and note prose.** The architecture dependency-direction lead, the try-out note, and the
  pyramid note are removed; the values speak for themselves.
- **Delivery is one group.** Deployment, CI, and Branching keep their own `discover-card`/`data-field`
  elements and no longer share a footer.

## Tables and charts

- **`PyramidChart` gained a `compact` variant** (220×132 viewBox, 9.5px labels, level names only). The
  full-size chart at panel width drew 16px labels and dominated the page; shrinking the SVG alone would
  have scaled the type below legibility, so the geometry changed. Counts live in the level table.
- **The chart sits beside the totals, the table below them.** Side-by-side chart and table at a 550px
  panel clipped `verification/project`; the full-width table gives paths room. This is the one mock
  divergence: the mock’s chart/table pairing was replaced after the render review.
- **Commands keep the mock’s `$` prefix, without a header row.** The operator reads the two columns
  without labels, so commands render as `$ <command>` under the found count, and the try-out note is gone.
- **Level table columns are Level / Tests / Paths & fixtures.** The command is already shown as the whole
  suite; repeating it per row adds width without information.
- **Fixed widths come from the table, not section CSS.** `DataTable` accepts `columnWidths` and renders a
  `colgroup`, so the commands table and every glossary table share one mechanism. The glossary fixes Kind
  and Term at the same widths in every context card, which puts every definition at the same page position.
- **No card clips or scrolls.** `.discover-page` children are `flex: 0 0 auto`, so a card grows to its
  rows instead of shrinking into the page's scroll area. The operator could see only three of five terms
  before this.

## Copy and interaction

- Group labels are short nouns and verbs: `Run and verify`, `Platform`, `Delivery`, `Stack`,
  `Architecture and boundaries`.
- The sidebar header names the repository, and the Discover section headings carry no `Sections` label.
- The primary action keeps one name per state: `Discover project` with no artifacts, `Re-discover` after.
  It stays disabled with a reason while a run or other mode work is active.
- Only the `stale` badge remains in the masthead; color is never the only cue.
- Dates use the browser locale via `Intl.DateTimeFormat`; the mock’s fixed `24 Oct 2026, 18:10` is the
  same time in `en-GB`.
- The architecture table names its first column `Bounded context`, so the DDD term is explicit.
- A fact list separates its values with commas.
- A Stack chip becomes a link to the repository declared by the installed package's manifest; an
  unresolvable chip stays plain text, so no URL is guessed.

## Divergences from the mock

| Mock | Implementation | Why |
|---|---|---|
| 390×844 mobile composition | 1024×720 minimum, 390 shows the app’s viewport guard | documented app exception (`viewport.svelte`) |
| Chart and table side by side | chart beside totals, table full width | paths clipped at 550px panel width |
| Section footer chips in one line | no footer at all | operator feedback removed confidence and evidence |
| `24 Oct 2026, 18:10` | locale-formatted date | no hard-coded locale in product UI |
| Command hints on two lines inside the cell | no note | operator feedback removed the static hint |
| Empty state output list on the left | copy left, outputs right | uses the 920px content width |

## Open questions

- Evidence and confidence remain in the sheet and the state payload but have no rendered surface. If an
  operator later asks for grounding, the next step is an opt-in detail view, not a return to
  badge-per-value.
- The compact pyramid label omits counts; hosts with five levels rely on the table for numbers. A future
  variant could show counts on hover/focus.

## Artifacts

- Design artifacts live under `.devboard/.design/overview/` rather than a root `.design/`, because
  `AGENTS.md` confines every harness artifact to `.devboard/`. `directions/` and `shots/` are ignored by
  `.devboard/.design/.gitignore`; the brief, design system, mock, component map, decisions, and review are
  committed with the surface.

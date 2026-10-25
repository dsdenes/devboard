# Decisions — Discover Overview

## Composition

- **A sheet, not a card grid.** Commands and Testing are the only raised `--surface` panels; runtime,
  delivery, architecture, dependencies, and unknowns sit flat on the canvas separated by hairlines.
  The previous auto-fit grid produced 11 equal cards, two columns with 100–200px holes, and no hierarchy.
  The flat/raised split makes the two operational blocks lead and keeps the page at ~1900px instead of ~2600px.
- **Two-column spine with full-width structure.** `Run and verify` on the left, `Platform` and `Delivery`
  in a rail, then Stack, Architecture, Dependencies, and Not observed across the page. The rail is ~700px
  against ~700px on the left, so the sheet ends without the old blank band. Below 1240px viewport the
  columns collapse to one in reading order.
- **Definition is the lead.** The project name, working-tree state, definition, and provenance read as one
  masthead; there is no page title repeating the tab name when artifacts exist.
- **Freshness is a meta line, not a panel.** `discover-freshness` returned to the header (commit, localized
  discovery time, definition confidence and evidence). The old separate freshness panel was removed from
  the previous surface by operator feedback; putting it in the masthead restores staleness without a box.
  The `stale` badge and its title are shown only when the fingerprint differs.
- **Stack is a full-width band.** Eight chips need one line; keeping Stack beside Runtime duplicated
  Node/npm and unbalanced the rail. The band sits after the spine as a quiet change of texture.
  Exact duplicate values (Node.js, npm) are kept because both are declared leaves; hiding one would make
  the stack list disagree with its manifest.
- **Environments has no card.** The crawled value is `unknown` (`none detected`), so the section exists
  only in the Not observed ledger instead of rendering an empty panel.

## Provenance and unknowns

- **Evidence and confidence are per section, not per leaf.** The first implementation rendered one badge
  and one chip per leaf; the operator feedback that shaped `0a975f5` removed them as noise. A sheet-wide
  footer per section lists the de-duplicated evidence paths and a confidence tally for the values shown,
  so grounding stays visible once per block instead of 30 times. Test ids `discover-evidence`,
  `discover-confidence` and `discover-freshness` are restored; `verify-interface.ts` now requires them.
- **Unknowns move to one ledger.** Sections render only grounded values; every unknown leaf is listed at
  the end with its section, field, and reason. This removes the repeated italic `unknown — reason` rows
  and makes the gaps first-class. `sectionProvenance` excludes unknown leaves, so the two surfaces never
  disagree.
- **Delivery is one group with one footer.** Deployment, CI, and Branching share the group's provenance
  line; each keeps its own `discover-card`/`data-field` element.

## Tables and charts

- **`PyramidChart` gained a `compact` variant** (220×132 viewBox, 9.5px labels, level names only). The
  full-size chart at panel width drew 16px labels and dominated the page; shrinking the SVG alone would
  have scaled the type below legibility, so the geometry changed. Counts live in the level table.
- **The chart sits beside the totals, the table below them.** Side-by-side chart and table at a 550px
  panel clipped `verification/project`; the full-width table gives paths room. This is the one mock
  divergence: the mock’s chart/table pairing was replaced after the render review.
- **Commands keep the mock’s `$` prefix.** The table cell value is `$ <command>`; the `tryOut` warning is
  a note under the table rather than a second line inside the cell, because `DataTable` renders plain
  strings. The Test hint (“Runs the whole test suite.”) is redundant with the Whole suite line and is
  dropped.
- **Level table columns are Level / Tests / Paths & fixtures.** The command is already shown as the whole
  suite; repeating it per row adds width without information.
- **Fixed column widths** are scoped in `app.css` to the commands, testing, and architecture tables;
  auto layout squeezed `Try it out` and hyphenated context names.

## Copy and interaction

- Group labels are short nouns and verbs: `Run and verify`, `Platform`, `Delivery`, `Stack`,
  `Architecture and boundaries`, `Entry points and dependencies`, `Not observed`.
- The ledger says “nothing here is guessed”, which is the contract: an ungrounded field is `unknown`,
  never a plausible value.
- The primary action keeps one name per state: `Discover project` with no artifacts, `Re-discover` after.
  It stays disabled with a reason while a run or other mode work is active.
- `dirty` and `stale` badges carry text and a title; color is never the only cue.
- Dates use the browser locale via `Intl.DateTimeFormat`; the mock’s fixed `24 Oct 2026, 18:10` is the
  same time in `en-GB`.

## Divergences from the mock

| Mock | Implementation | Why |
|---|---|---|
| 390×844 mobile composition | 1024×720 minimum, 390 shows the app’s viewport guard | documented app exception (`viewport.svelte`) |
| Chart and table side by side | chart beside totals, table full width | paths clipped at 550px panel width |
| Section footer chips in one line | chips wrap to a second line at rail width | rail is 320–350px; wrapping beats truncation |
| `24 Oct 2026, 18:10` | locale-formatted date | no hard-coded locale in product UI |
| Command hints on two lines inside the cell | one note under the table | `DataTable` cells render plain strings |
| Empty state output list on the left | copy left, outputs right | uses the 920px content width |

## Open questions

- The section-level evidence summary trades per-leaf precision for calm. If an operator needs to know
  which value came from which path, the next step is a per-row popover, not a return to badge-per-value.
- The compact pyramid label omits counts; hosts with five levels rely on the table for numbers. A future
  variant could show counts on hover/focus.

## Artifacts

- Design artifacts live under `.devboard/.design/overview/` rather than a root `.design/`, because
  `AGENTS.md` confines every harness artifact to `.devboard/`. `directions/` and `shots/` are ignored by
  `.devboard/.design/.gitignore`; the brief, design system, mock, component map, decisions, and review are
  committed with the surface.

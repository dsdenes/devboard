# Bounded contexts widget — validation

Scope: the three architecture cards of Discover › Overview — the `Bounded contexts` list card in
the main column, and the `External boundaries` and `Shared kernels` cards in the facts rail — plus
the design record that describes them. No other Discover region, Goal view, or Flow view is
changed.

## Current revision

- Layout: the context list renders one stacked row per context — name, optional responsibility,
  optional entry-point chips. Each boundary group renders as its own rail card below `Stack`. The
  card renders no per-context path (#230) and no dependency-direction row (#1091).
- Record: `content-inventory.md`, `structure.md`, `significance.md`, `component-requirements.md`,
  `brief.md`, and the widget A2UI and wireframe files describe that shipped layout (#1140).
- History: the files under `screenshots/` were captured for the pass that preceded #230 and #1091,
  on branch `bounded-contexts-widget` at base `547819c`. They are retained as history; they are not
  evidence for the cards as shipped, and every row in this file that described the earlier layout
  is superseded.

## Commands

From `.worktree/issue-1140/.devboard`:

- `bun install --frozen-lockfile` → 206 packages installed.
- `bun run build` → `dist/index.html` and assets, built in 6.18s on the rebased revision.
- `bun run verify:interface` → exit 0:
  `verify:interface: shell, modes, sidebar, pages, splits, palette, keyboard, theme, tables,
  read-only documents, terminals, accessibility, notifications, status bar, issues mode, ask
  transcript, persistence, sidebar run state, and boundary passed`
- Wireframe: headless Chrome at 390 and 1440 CSS px reports `scrollWidth === clientWidth`
  (390/390 and 1440/1440) with no element past the viewport edge.

## Widget assertions the verifier covers

The Discover stage of `verify:interface` drives the stub sheet and asserts, among others:

- at least one context row renders (`contextRows > 0`);
- no context renders a repository path (`contextPathChips === 0`);
- the architecture card renders no boundary fact row (`boundaryFacts === 0`);
- `External boundaries` is a card of its own with one chip per system;
- `Shared kernels` is a card of its own with one chip per kernel;
- no Discover panel or table scrolls inside the page, and no card clips its own rows.

The chips' link handoff is asserted by the component suite, not the interface stage:
`DiscoverOverview.test.ts` renders an entry-point file, an entry-point directory, and a manifest as
anchors carrying the `vscode://file/` href, keeps a missing path, an absolute or escaping value, and
every external-boundary chip a plain `code` element, and renders no path link while a remote target
is shown.

## State coverage

|State|Structure|Evidence|
|---|---|---|
|Observed|Context rows with name, optional responsibility, optional entry-point chips; each boundary card one chip per value plus a count subtitle|verifier: context-row and boundary-chip assertions|
|No contexts|`No bounded context was detected.` in place of the list; the boundary cards are unaffected|markup branch in `DiscoverOverview.svelte`|
|Unknown contexts|The contexts leaf's reason replaces the list|`unknownText` branch|
|Empty boundaries|`External boundaries` shows `None detected.`; `Shared kernels` shows `No shared kernel was detected.`|markup branches|
|Unknown boundaries|The affected card shows `unknown — <reason>` in place of chips|`unknownText` branch|
|Partial row|A context with no responsibility and no entry points renders its name alone|markup conditionals|
|Missing boundary leaf|That card is absent; the other cards render|leaf guards|

## Findings during this pass

1. The record and the shipped cards disagreed: the inventory kept the path and the direction as
   `Keep? yes`, the structure described one role-map card, and the A2UI and wireframe files carried
   a role-map region and a direction row. #230 and #1091 had already removed the path chip and the
   direction row, and the verifier asserts their absence. The record now names those removals.
2. The record described the boundary groups as role rows inside the context card; shipped, each
   group is its own rail card below `Stack`. Structure, component requirements, and the wireframe
   now show the three cards.
3. A15 cited the dependency graph widget; #2ee5ffb6 dropped it. The inventory now records that
   nothing draws the observed edges.

## Duplicate and redundancy check

- Entry-point chips are the only locator the card renders; the path element is gone (#230).
- A5 and A6 each appear once, in their own card; A7 has no card (#1091).
- The card does not repeat commands, test strategy, stack, or glossary terms.

## Not run

- A live-model Discover crawl: the change is documentation, and the shipped verifier drives the
  deterministic stub sheet.
- New browser screenshots of the three cards: the verifier's Discover assertions are the evidence
  for this revision, and the earlier screenshots are marked superseded above.
- Storybook and the validation server: no OpenUI primitive, story, DTCG token, or component changed.

## Artifacts updated for consistency

- `.design/ux/discover-bounded-contexts/`: brief, content inventory, significance, structure,
  component requirements, and this validation (#1140).
- `.design/a2ui/discover-bounded-contexts.a2ui.jsonl` and its wireframe: three cards, no role-map
  region, no direction row, and no context path element.

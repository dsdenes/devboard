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
- Checks: the DOM-level assertions below run in the client component suite; no browser runner
  renders this page.

## Commands

From `.devboard`, the package root that declares both scripts:

- `bun run build` → `vite build` writes `dist/index.html` and its assets, then
  `scripts/embed-client.mjs` embeds that bundle into the server. It exercises none of the three
  cards.
- `bun run test:client` → `scripts/test-client.mjs` runs the client suite, including
  `client/lib/components/DiscoverOverview.test.ts`, which is the runner for every assertion below.

## Assertions the component suite covers

`client/lib/components/DiscoverOverview.test.ts` renders `DiscoverOverview.svelte` against the stub
sheet in `happy-dom` and asserts, for the three cards:

- at least one context row renders, keyed by the context name and carrying its responsibility —
  `a named context without a path still renders its row`;
- a context whose only fact is a repository path renders no row and adds no `N contexts` count —
  `a context record with only a path renders no row and no count`;
- a context's `path` renders no chip and no VS Code link while its entry points render theirs —
  `a context's path renders no chip while its entry points do`;
- no dependency-direction row renders — `a dependency direction renders no row`;
- `External boundaries` is a card of its own (`data-field="external-boundaries"`) rendering one
  plain `code` chip per system, an `N system`/`N systems` count, and no VS Code link —
  `two external boundaries render one plain chip each and count two systems`;
- `Shared kernels` is a card of its own (`data-field="shared-kernels"`) rendering one chip per
  kernel with an `N kernel`/`N kernels` count —
  `one shared kernel links to VS Code and counts one kernel`,
  `two shared kernels stay plain and count two kernels`;
- a missing `sharedKernels` leaf drops that card only, leaving `External boundaries` rendering —
  `a missing shared-kernels leaf drops only that card`;
- the unknown and observed-empty states of the `Shared kernels` card render their own sentence in
  place of chips — `an unknown shared-kernels leaf renders its reason instead of the empty line`,
  `an observed empty shared-kernels leaf renders the empty line`.

The chips' link handoff is asserted by the same suite, not by a browser stage:
`DiscoverOverview.test.ts` renders an entry-point file, an entry-point directory, and a manifest as
anchors carrying the `vscode://file/` href, keeps a missing path, a command, and every
external-boundary chip a plain `code` element, keeps an absolute, parent-relative, and escaping
entry point plain, and keeps every chip plain for a payload that carries no `overviewLinks`.

The remote-target no-link guarantee belongs to the server payload, so the Rust suite asserts it:
`a_shown_remote_target_publishes_no_overview_links` in `.devboard/crates/devboard/tests/discover.rs`
switches to a retained project whose published sheet names an entry point, its directory, and a
manifest that all exist in that clone, asserts the same sheet yields a non-empty `overviewLinks` for
the host target, and asserts `discoverState`'s `overviewLinks` is `{}` while the remote target is
shown, so dropping the `shown_remote.is_some()` clause fails that test.

## State coverage

|State|Structure|Evidence|
|---|---|---|
|Observed|Context rows with name, optional responsibility, optional entry-point chips; each boundary card one chip per value plus a count subtitle|named-context row, context-path, external-boundary chip, and shared-kernel chip assertions in `DiscoverOverview.test.ts`|
|No contexts|`No bounded context was detected.` in place of the list; the boundary cards are unaffected|markup branch in `DiscoverOverview.svelte`; not asserted|
|Unknown contexts|The contexts leaf's reason replaces the list|`unknownText` branch; not asserted|
|Empty boundaries|`External boundaries` shows `None detected.`; `Shared kernels` shows `No shared kernel was detected.`|markup branches; only the `Shared kernels` one is asserted|
|Unknown boundaries|The affected card shows `unknown — <reason>` in place of chips|`unknownText` branch; only the `Shared kernels` one is asserted|
|Partial row|A context with no responsibility and no entry points renders its name alone|markup conditionals|
|Missing boundary leaf|That card is absent; the other cards render|`a missing shared-kernels leaf drops only that card`|

## Findings during this pass

1. The record and the shipped cards disagreed: the inventory kept the path and the direction as
   `Keep? yes`, the structure described one role-map card, and the A2UI and wireframe files carried
   a role-map region and a direction row. #230 and #1091 had already removed the path chip and the
   direction row; the component suite asserts both absences. The record now names those removals.
2. The record described the boundary groups as role rows inside the context card; shipped, each
   group is its own rail card below `Stack`. Structure, component requirements, and the wireframe
   now show the three cards.
3. A15 cited the dependency graph widget; #2ee5ffb6 dropped it. The inventory now records that
   nothing draws the observed edges.
4. The record named a script, a browser stage, and a worktree that the harness no longer carries.
   It now names the two `package.json` scripts that run and the component suite file that holds
   each assertion, so every claim points at a runner a reader can start.

## Duplicate and redundancy check

- Entry-point chips are the only locator the card renders; the path element is gone (#230).
- A5 and A6 each appear once, in their own card; A7 has no card (#1091).
- The card does not repeat commands, test strategy, stack, or glossary terms.

## Not run

- No Discover panel or table scrolls inside the page, and no card clips its own rows: the harness
  carries no browser layout check for this page. `.devboard/e2e/` holds only agents, forge, issues,
  polling, report, soak, and transport specs beside its shared dashboard helpers, and no spec opens
  Discover; the component suite renders in `happy-dom`, which computes no layout — so a clipped or
  internally scrolling card passes every assertion above. The missing check is a Discover layout
  stage in `.devboard/e2e/`.
- The previous pass's viewport measurement (`scrollWidth === clientWidth` at 390 and 1440 CSS px,
  by hand in headless Chrome): no `.devboard/package.json` script runs it, so it is history rather
  than a command this record can repeat.
- The empty and unknown states of the contexts card and of the `External boundaries` card:
  `DiscoverOverview.svelte` renders them, and only the `Shared kernels` states are asserted. The
  missing check is a component assertion per state in `DiscoverOverview.test.ts`.
- A live-model Discover crawl: the change is documentation, and the stub sheet is the fixture the
  component suite drives.
- New browser screenshots of the three cards: no browser runner exists for this page, and the
  earlier screenshots are marked superseded above.
- Storybook and the validation server: no OpenUI primitive, story, DTCG token, or component
  changed.

## Artifacts updated for consistency

- `.design/ux/discover-bounded-contexts/`: brief, content inventory, significance, structure,
  component requirements, and this validation (#1140).
- `.design/a2ui/discover-bounded-contexts.a2ui.jsonl` and its wireframe: three cards, no role-map
  region, no direction row, and no context path element.

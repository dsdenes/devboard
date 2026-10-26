# Bounded contexts widget — validation

Scope: the `Bounded contexts` card in Discover › Overview, and its styles. No other Discover
region, Goal view, or Flow view is changed.

- Worktree/branch: `.worktree/bounded-contexts-widget`, branch `bounded-contexts-widget`, based on
  `origin/main` at `547819c` (rebased after the glossary-significance merge; build, tests, and the
  interface verifier were rerun on this base).
- Preflight: `bun "$(realpath skill://ui-ux)/scripts/preflight.mjs" .` → `applicable: true`; DESIGN.md
  lint 0 errors, 29 pre-existing warnings; DTCG 65 tokens; OpenUI 3 components; Storybook 1 story.
- Commands, all from `.worktree/bounded-contexts-widget/.devboard` unless noted:
  - `bun install --frozen-lockfile`
  - `bun run build` → `.devboard/dist/index.html` and assets
  - `bun run check` → 1044 files, 0 errors, 0 warnings
  - `bun test` → 364 pass, 0 fail, 2900 expect calls, 30 files
  - `bun run verify:interface` → passed (shell, modes, sidebar, pages, splits, palette, keyboard,
    theme, tables, editors, terminals, accessibility, notifications, status bar, persistence,
    boundary)
- Validation dashboard:
  `ADRS_DIR=.tmp/bounded-contexts/host/adrs REPO_DIR=.tmp/bounded-contexts/host
  GOAL_FILE=.tmp/bounded-contexts/host/GOAL.md STATIC_DIR=dist
  STATE_DIR=.tmp/bounded-contexts/state PORT=18121
  AGENT_COMMAND="bun server/fixtures/stub-agent.ts --discover" bun run start`.
  The stub crawl published a valid `.omp/discover` set; each additional state replaced the
  fixture's `sheet.json` architecture block and restarted the validation server so the published
  read path was exercised, not an in-memory overlay.
- Browser: OMP Playwright-backed headless Chromium. Base URL `http://127.0.0.1:18121/`.
- Viewports: 1440×900 and 1024×720 (the supported minimum, where the page is single-column).
  Screenshots carry a 1.25 device scale factor; CSS measurements are reported in CSS pixels.

## States exercised

|State|Evidence|Result|
|---|---|---|
|Observed, full|`rich-1440-dark.png`, `rich-card-1440-dark.png`, `rich-1440-light.png`, `rich-card-1440-light.png`, `rich-1024-dark.png`, `rich-card-1024-dark.png`|2 contexts with path/entry chips, 2 shared kernels, 2 external boundaries, direction|
|Observed, boundary arrays empty|`empty-boundaries-card-1440-dark.png`|Only the direction row renders; no "None detected." boxes|
|Unknown groups|`unknown-card-1440-dark.png`|Contexts reason plus one line naming the three unknown groups and both reasons, separated|
|No contexts, boundaries present|`empty-contexts-card-1440-dark.png`|`No bounded context was detected.` above the role rows|
|Stress: 9 contexts, long name/path/responsibility, 5 kernels, 6 boundaries|`stress-card-1440-dark.png`, `stress-card-1024-dark.png`, `stress-1440-dark.png`|Name stays on one line, long path moves to its own right-aligned line, chips wrap under the label column|
|Light theme|`rich-1440-light.png`, `rich-card-1440-light.png`|Tokens mirror correctly; no color-only meaning|
|Wireframe|`wireframe-discover-bounded-contexts-1440.png`, `wireframe-discover-bounded-contexts-390.png`|1440 and 390 both `scrollWidth === clientWidth`|

Journeys exercised against `brief.md`: find the owning context (name → responsibility → path →
entry points); judge coupling (kernels, external boundaries, direction); partial sheet (unknown
groups); empty context list with observed boundaries.

## Measurements

- 1440×900: document `scrollWidth 1440 === clientWidth 1440`; card `635.7px` wide with
  `scrollWidth 634`; role labels `14.5px` high (one line) at the 160px column; zero elements with
  hidden horizontal overflow.
- 1024×720: document `scrollWidth 1024 === clientWidth 1024`; card `636.4px` wide with
  `scrollWidth 634`; no viewport guard.
- Entry point equal to the context path is not repeated (Billing and Orders fixtures prove the
  filter); duplicate entry points are de-duplicated.
- Console: 0 console entries, 0 page errors after a clean reload in the final state. Network: 113
  requests, one failure, `GET /favicon.ico` 404 — pre-existing (the server serves no favicon), not
  caused by this change.
- Accessibility: the card exposes one `h2`, one list with one `listitem` per context, and a `dl`
  of `term`/`definition` pairs in the accessibility tree. The card contains zero focusable
  elements, so it adds no tab stop; no keyboard path changes. No motion is added. Meaning is
  carried by words, not color alone.

## Findings and fixes during validation

1. A 31-character context name broke mid-word when the path competed for the same line. Fixed with
   `flex-wrap` on the head and `margin-left: auto` on the path: the path moves to its own
   right-aligned line and the name stays whole (proved by the stress card).
2. Entry chips after a wrap restarted at the card edge. Fixed by rendering the entry row as a grid
   with the same 160px label column as the role rows; wrapped chips now align.
3. Two distinct unknown reasons concatenated as `files.No package…`. Fixed by joining the unique
   reasons with a space; re-captured text reads `…files. No package manifest…`.
4. The 104px label column wrapped "Dependency direction" onto two lines. Raised the role column to
   160px and documented it as component geometry in `DESIGN.md` next to the 104px fact-label
   column; all three labels now measure one line.
5. Removed a defensive "no shared kernel…" note: valid architecture leaves always carry a
   dependency-direction value or an unknown reason, so the branch was unreachable. Empty observed
   arrays simply omit their role row.
6. `scripts/verify-interface.ts` asserted the shipped `th` text `Bounded context`. Replaced with
   structural checks: no architecture table header, at least one context row, and a labeled
   `Dependency direction` role. The verifier passes.

## Duplicate and redundancy check

- Context path appears once per context and is suppressed from its own entry chips.
- The context count is removed; the list is the count (already P3 in the page inventory).
- Empty observed groups no longer print "None detected." chips in two symmetric boxes; a group
  renders only when it carries values, and unknown groups are stated once.
- The card does not repeat commands, test strategy, stack, or glossary terms.

## Spacing and token audit

- New layout values: 2, 4, 8, 10 and 12px gaps/padding, all on the approved scale. The only new
  fixed width is the 160px role-label column, documented as component geometry in `DESIGN.md`.
- No new color, radius, type size, shadow, gradient, or animation. Colors come from
  `--surface`, `--border`, `--border-subtle`, `--foreground`, `--muted-foreground`, with the
  shipped mono font variable.
- No DTCG, OpenUI, or Storybook change: the widget composes existing primitives and adds no new
  design-system component.

## Artifacts updated for consistency

- `.design/a2ui/discover-overview.{a2ui.jsonl,wireframe.html}`: the architecture region now
  describes the context list and boundary role rows instead of the removed table and empty boxes.
- `.design/ux/discover/content-inventory.md`: C19's method now points at the role rows.
- `.design/ux/discover-bounded-contexts/`: brief, content inventory, significance, structure,
  component requirements, and this validation.
- `.design/a2ui/discover-bounded-contexts.{a2ui.jsonl,wireframe.html}`: widget-level structure and
  its rendered wireframe.
- `.design/research/2026-10-26-discover-bounded-contexts.md`: designmd research receipt.

## Not run

- A live-model Discover crawl. The change is presentational and the deterministic stub publishes a
  schema-valid sheet; the crawl and validation rules are untouched.
- Storybook. No OpenUI primitive, story, or DTCG token changed; the existing
  `Design System/Overview` story still matches `design/tokens.json`.
- Mobile layout. The interface has no mobile shell below 1024×720; the standalone wireframe covers
  390px only.

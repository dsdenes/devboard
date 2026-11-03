## Objective

The Devboard harness gains a complexity dashboard of its own application source. In Devboard
mode, the sidebar lists one new entry directly below Skills, and activating it opens a page that
shows the current complexity measurements of the Devboard application code together with a
time-series view of how those measurements changed across daily snapshots. The running dashboard
records at least one snapshot per calendar day without an operator click, keeps the recorded
snapshots across restarts, and shows them to every connected page.

## Success criteria

- The Devboard-mode sidebar's `Devboard sections` group lists `MCP tools`, `Skills`, and exactly
  one new entry directly after `Skills`; activating the new entry opens the complexity page, and
  every existing sidebar entry keeps its label, order, and behavior.
- Every snapshot records measurements from three levels:
  - per function: cyclomatic complexity, source length in lines, maximum block nesting depth, and
    parameter count;
  - per file: lines of code (non-blank, non-comment), function count, duplicated-line ratio, and a
    maintainability index clamped to 0-100 and derived from Halstead volume, cyclomatic
    complexity, and lines of code;
  - per project: file count, function count, total lines of code, mean and maximum cyclomatic
    complexity, the number of functions whose cyclomatic complexity exceeds 10, the
    duplicated-line ratio, and the mean maintainability index.
- The analyzed set is the application source under `.devboard/server`, `.devboard/client`,
  `.devboard/lib`, `.devboard/scripts`, `.devboard/extensions`, `.devboard/mcp`,
  `.devboard/issues`, `.devboard/watchdog`, `.devboard/release-train`, and
  `.devboard/mcp-optimizer`: TypeScript, Svelte, JavaScript, and ESM source files, excluding every
  `*.test.ts` file, `node_modules`, `dist`, `.tmp`, and `public`. Analyzing the same unchanged tree
  twice yields identical values.
- The dashboard records exactly one snapshot per UTC calendar day: at server start and whenever
  the UTC date changes while the server runs, it records a snapshot for that date if and only if
  none exists; a restart, a page open, a page reload, a reconnect, or a later check on the same
  date records no second snapshot.
- Recorded snapshots survive a server restart, are replayed to every connected page, and are
  ordered oldest to newest; the page lists every recorded date.
- The page renders a time-series chart in which every project-level metric has its own visible
  series with one point per recorded date, readable date labels, a visible marker on the latest
  point, and a legend or label naming each series; with two or more recorded dates a changed value
  produces a visibly different point and line direction.
- The page renders a current-value card for every project-level metric, each showing the latest
  snapshot's value and its unit.
- The page renders a per-file table with one row per analyzed file and one column per per-file
  metric, showing the latest snapshot's values; sorting by any metric column reorders the rows by
  that column's values.
- The page reports the timestamp and date of the latest snapshot and the number of recorded
  snapshots.
- The dashboard records its snapshots under its state directory, writes nothing outside the
  repository root, and requires no external analyzer, network call, or new runtime dependency.
- Existing surfaces are unchanged: the Skills and MCP tools pages keep their content and test
  hooks, no mode is added to the mode rail, and no existing sidebar entry is reordered, removed,
  or relabeled.
- `cd .devboard && bun test`, `cd .devboard && bun run check`, `cd .devboard && bun run build`, and
  `cd .devboard && bun run verify:complexity` all exit 0.
- The change is merged to `main`, pushed to the canonical upstream, and released by the Release
  Train; a live dashboard's `versionState` reports the released version as `running`.

## Verification

- `cd .devboard && bun test` exits 0. The added tests cover, at minimum: expected per-function and
  per-file values for a fixture with known decision points, nesting, and duplication; exclusion of
  test files and build directories; determinism across two analyses of the same tree; the
  once-per-UTC-day rule across a simulated date change and a simulated same-date restart; the
  persistence round-trip of a snapshot; and the per-file table's sort order.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run build` exits 0.
- `cd .devboard && bun run verify:complexity` exits 0. That check drives the built dashboard in
  headless Chrome against a state directory seeded with at least three dated snapshots and a stub
  clock, and observes: the new sidebar entry directly after `Skills`; one card per project metric
  with the latest value; one series per project metric with one point per seeded date and a marked
  latest point; the per-file table sorted by a chosen metric column; and that restarting the
  server on the seeded current date adds no fourth snapshot.
- Manual surface check: from the repository root run
  `cd .devboard && STATE_DIR="$PWD/.tmp/complexity-verify" bun run start`, open
  `http://127.0.0.1:8080`, press `Alt+5` to enter Devboard mode, and click the entry directly below
  `Skills`. The page shows one point dated today with every project-level metric, one card per
  metric, and a per-file table whose rows name analyzed `.devboard` source files. Stop and restart
  the server with the same `STATE_DIR`, reload the page, and observe still exactly one point dated
  today.
- `git status --short` shows no modified host file outside `.devboard/`, and `AGENTS.md` is
  unchanged.

## Boundaries

- Harness mode only. The edit root is `.devboard/`; files outside it, including `adrs/`,
  `GOAL.md`, and `AGENTS.md`, stay byte-identical. `.omp/` is never hand-edited; a wrapper change
  would go through canonical `.devboard/omp/` and `install.sh`.
- The analyzer reads only the application directories named above. It does not read host data,
  `node_modules`, `dist`, `.tmp`, `public`, test files, or anything outside the repository root.
- Snapshots live under the dashboard's `STATE_DIR` (default `.devboard/.tmp`) and nowhere else. No
  file, cache, log, or fixture is created under `/tmp`, a home directory, or a parent checkout.
- No new runtime dependency and no external analyzer binary. Measurement uses the existing Bun,
  TypeScript, and Svelte stack and runs inside the dashboard process.
- The mode rail keeps its five modes, and the Devboard sidebar keeps its existing entries and
  order; the new entry follows `Skills`.
- Existing page content, existing test hooks, and existing commands keep their current behavior;
  the README documents the new surface and its daily rule.
- No force-push, no published-history rewrite, no manual `bun run publish`, and no manual release
  workflow dispatch. The Release Train owns publishing.
- Do not add a background agent family, a detached worker, or a service for this feature; the
  daily check belongs to the dashboard server's own lifecycle.

## Stop conditions

- Halt and report when a genuine ambiguity remains about which metric a value represents, which
  surface the entry belongs to, or which day a snapshot belongs to, and the ambiguity cannot be
  resolved from this spec, the repository, or the draft.
- Halt and report when a prerequisite is missing: unavailable Bun or Playwright, no forge write
  permission for `dsdenes/devboard`, an unreachable npm registry or Gitea origin, or a required
  external dependency that cannot be reached.
- Halt and report before any risky irreversible operation that is not already authorized, such as
  rewriting published history, deleting another checkout, or discarding another agent's work.
- There is no attempt cap, no token budget, and no time limit. Run checks until they pass or a
  genuine blocker above is reached.
- A narrower feature, a partial metric set, a scaffold, a mock, a placeholder page, or a local-only
  commit never substitutes for a success criterion. Done means merged to `main`, pushed, and
  released by the Release Train; a rejected push is integrated, resolved, rechecked, and pushed
  again, never left local.

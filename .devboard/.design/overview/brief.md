# Goal

When a developer opens Discover in a host they did not write, they want to answer "what is this project,
how do I run and verify it, and how does it ship" in one scan, so they can make a change with the right
commands and boundaries without reading the repository first.

# Surface

Discover mode → Overview tab, inside the IDE-style workspace (activity bar 44px, sidebar 300px, 34px tab
strip, status bar). Desktop-first; the supported viewport floor is 1024×720 and the app shows a guard
below it. Entry points: the sidebar's Overview item, the command palette `discover.tab.overview`, or the
default Discover tab.

# Content inventory

Real published artifacts of the vitest-turbo host, `sheet.json` schema 1:

| Field | Content |
|---|---|
| Identity | project `vitest-turbo`, commit `767205e`, dirty, discovered `2026-10-24T18:10:01.036Z`, fingerprint present |
| Definition | one sentence, 128 characters |
| Stack | 8 entries: `@babel/parser ^7.29.9`, `JavaScript ES modules`, `Node.js >=22.18.0`, `chai ^6.3.0`, `happy-dom ^21.0.4`, `jsdom ^30.1.3`, `npm`, `typescript ^5.9.3` |
| Runtime | JavaScript, Node.js >=22.18.0, npm, node-version 24, package.json |
| Deployment | class `cli`, artifact `@dsdenes/vitest-turbo`, target `public npm registry` |
| Commands | install, test, try-out, release observed; build, lint, typecheck, dev/run not observed |
| Branching | default `main`, merge method `merge`; release branches and model not observed |
| Testing | 2 levels, 118 unit tests, contract level with unknown count, whole suite `node --test test/*.js`, pyramid note |
| Architecture | 5 contexts (browser-testing, module-loading, runner-cli, test-execution, test-reporting), dependency direction, no external boundaries (the worker and child-process use is a runtime built-in), 1 shared kernel |
| CI | GitHub Actions, triggers `release published` / `workflow_dispatch`, job `publish`, gate `release tag matches package version`; artifacts not observed |
| Dependency map | binaries `vitest`, `vitest-turbo`; package `@dsdenes/vitest-turbo`; external `registry.npmjs.org`; key deps `@babel/parser`, `chai`, `typescript`; routes and data stores not observed |
| Environments | none detected (an unknown) |
| Unknowns | 10 visible fields with reasons |
| Actions | Re-discover (primary, disabled while work runs or the socket is closed); Stop and Answer exist only during an active run |
| Warnings / errors | warning banners and one error banner above the sheet |

# Constraints

- Reuse `DataTable`, `PyramidChart`, `Button`, `.panel`, `.badge`, and the existing tokens; no new
  palette, spacing scale, radius, or shadow.
- No nested scroll containers: the page scrolls, tables grow. No Field/Value header tables.
- Table font 12–14px, rows ≤120px, no sideways overflow at 1024.
- Keep every contract test id: `discover-panel`, `discover-card` + `data-field`, `discover-sheet`,
  `discover-start`, `discover-command-list`, `discover-pyramid`,
  `discover-pyramid-chart`, `discover-test-summary`.
- Provenance lives in the sheet and the state payload. The operator rejected rendered evidence chips,
  confidence labels, and the unknowns ledger as noise, so the page shows the values and their empty
  states without that chrome.
- The active-run panel, question panel, and warning/error banners are unchanged; the glossary table and
  sidebar chrome follow the same operator review.
- Real data only; no invented proof, logos, counts, or testimonials.

# Visual thesis

A project sheet, not a card pile: the definition leads, a two-column spine answers "run it" and "ship it",
and one raised terminal-like command block is the memorable object. Everything else is quiet, flat, and
separated by hairlines, with a single ledger at the end for what the crawl could not observe.

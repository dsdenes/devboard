# Watchdog page — validation

Date: 2026-10-28. Issue: #308 (`#workspace-issues > section.watchdog-page`).

## Commands

| Command | Result |
|---|---|
| `bun run build` (from `.devboard`) | pass; `dist/index.html` and every referenced asset produced |
| `bunx tsc --noEmit` | pass; no diagnostics |
| `bun test` | pass; 695 tests, 0 fail, 4701 expectations, 53 files |
| `bun run verify:watchdog` | pass; every `PASS` line listed below |

`verify:watchdog` builds the client and drives the real page in headless Chrome at 1440×900 with a
seeded host, run directories, ledger, and a stub `gh`:

```
PASS open-issues-watchdog
PASS watchdog-page-empty
PASS watchdog-cycles
PASS watchdog-fresh-ledger
PASS watchdog-issues
PASS watchdog-sync-error
PASS watchdog-sync-recovered
PASS watchdog-freshness
PASS watchdog-popover
PASS issue-links
PASS escape-closes
PASS no-console-error
```

The verifier covers the empty page (`none`, `never`, both empty states), three seeded cycles and
their order, the summary counts and reason, the filed-issue rows with state and shipped version, a
failed GitHub read that keeps the rows, recovery, live refresh without reload, the status-bar
indicator and popover, and zero console errors or uncaught exceptions. It also asserts the
integrated compact cycle row: three columns, no window, finding count, or reason cell, and each
`watchdog-cycle-issue` anchor points at the expected GitHub issue in finding order. The newest
reason and counts live only in the summary.

## Visual evidence

A throwaway preview under `.devboard/.tmp` seeded 20 cycles with linked filed issues, eight filed
issues with mixed states and versions, and the same stub `gh`, then served the built page. The
preview server and its state were removed after the screenshots. Screenshots live in `.devboard/.design/watchdog/`:

| Evidence | Viewport | Theme | State |
|---|---|---|---|
| `watchdog-2101-dark.png` | 2101×1017 | dark | 20 cycles with issue links, 8 issues, two-column layout |
| `watchdog-1440-light.png` | 1440×900 | light | same data, one-column layout |
| `watchdog-1024-dark.png` | 1024×720 | dark | same data, category column hidden |
| `watchdog-empty-1440-dark.png` | 1440×900 | dark | no cycles, no filed issues |

## Checks

- **Page scroll.** At 2101×1017 the page element is 1726×991 with `scrollWidth`/`scrollHeight`
  equal to its client size; the observed 3511px page and unreachable filed-issue panel are gone.
  At 1024×720 the page is 651×694 with no horizontal or vertical overflow. Each panel scrolls
  internally.
- **Layout.** Two columns at ≥1501px (filed issues `1.25fr`, history `minmax(420px, 1fr)`); one
  column of two flexible rows below that. Both tables keep labelled sticky headers.
- **Clipping.** No unintended cell overflow at 2101, 1440, or 1024. Issue titles ellipsize by
  design and keep the full text in `title`; cycle issue links wrap on the trailing track. The
  category column is hidden at ≤1100px instead of clipping its values. The 140px start column
  fits `Oct 26, 15:00:00`.
- **Empty states.** `No issues filed` and `No cycles yet` render as centered stacks with a 20px
  decorative mark, a 13px/600 title, and one 12px line; the summary shows `none`, `No cycle has
  run yet.`, `never`, and zero counts.
- **Theme.** Dark and light both use the existing custom properties; no literal color is
  introduced. The summary badge tones (`success`, `accent`, `error`, neutral) and state tones
  match the shared badge meaning.
- **Accessibility.** Both tables use native `table`/`th scope="col"`, the issue link has the full
  generated title, every badge states its word, `<time datetime>` keeps the ISO value, icons are
  `aria-hidden`, and the history row keeps its action-and-start `aria-label`. Each cycle issue
  anchor carries `title` and an issue-number `aria-label` and opens in a new tab. Links take a
  browser focus outline and an accent underline on focus, matching the Auto Scout table.
- **Console.** `verify:watchdog` reports `PASS no-console-error`.

## Not run

- `designmd` MCP research: no MCP manager is configured; recorded in
  `.devboard/.design/research/2026-10-28-watchdog.md`.
- Automated contrast measurement: all pairs are unchanged design-system tokens already in use on
  the same surfaces; visual review in both themes only.
- Keyboard traversal and screen-reader session: not available in this run; table semantics and
  labels were reviewed in the DOM.
- `prefers-reduced-motion`: no animation was added to the page.

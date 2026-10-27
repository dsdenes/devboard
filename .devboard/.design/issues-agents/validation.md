# Validation — Issues / Agents

- Page: Issues → Agents (`#workspace-issues > section.issues-agents-page`).
- Issue: #240 (second redesign of the card surface; the first redesign is `fdda380`).
- Worktree: `.worktree/issue-240`, branch `issue-240`. All commands ran from `.devboard` in the
  worktree; no path left the repository.
- This run also merged the concurrent `origin/main` changes: `96b1161` dropped the per-card
  `running` badge, and `9e638f9` reworked the Overview rows; it keeps the removal of the remaining
  `needs answer` pill on the fleet cards.

## Commands

```bash
bun install --frozen-lockfile
bun run build                 # vite build, dist rewritten
bun test                      # 581 pass, 0 fail, 4070 expect() calls, 46 files
bun run check                 # svelte-check: 1672 files, 0 errors, 0 warnings
bun run verify:interface      # passed, including the new card geometry assertions
bun run verify:issues         # passed on the merged tree
```

The browser contract now checks, on the three-agent fixture:

- every card has no `running`/`needs answer` badge in its head;
- every card labels its activity `Latest activity`;
- the three title slots have one rounded height;
- cards in a row share a height and a bottom edge;
- each waiting card's activity log is the compact 64px block;
- the grid falls to one column at 1024×720 and does not overflow at either width;
- `issues-agents-page.png`, `issues-agents-page-1024.png`, `issues-agents-page-empty.png`
  captures are written under `.devboard/.tmp/interface/`.

## Dashboard and viewports

The worktree build was served from `.devboard/dist`, not the installed bundle, against the
fixture host and the seeded three-agent state (opened through the command palette, because the
Issues sidebar no longer lists Agents):

```bash
ADRS_DIR=<fixture>/adrs REPO_DIR=<fixture> GOAL_FILE=<fixture>/GOAL.md \
STATIC_DIR=<worktree>/.devboard/dist STATE_DIR=<fixture>/.devboard/.tmp/state \
AGENT_COMMAND=true PORT=8190 bun run server/index.ts
```

- 2101×1017 — the reported capture width; four-column grid with the three fixture cards.
- 1440×900 — two cards per row, question blocks with two and one option.
- 1024×720 — one column; each card keeps its head on one line and does not overflow.
- Light theme at 1440×900 — warning border and question surface keep their own foreground.

## Journeys exercised

| Journey | Evidence |
|---|---|
| Survey the fleet | Three cards show the mono issue link, two-line title slot, elapsed/start line, labeled activity, and `Focus`; no card repeats the fleet state |
| Find the blocked agent | Header badge `3 need an answer`, warning card borders, and the question block; no per-card pill |
| Answer and clear one question | `verify-interface.ts`: the answer carries the run id, only that agent's question clears, header falls to `2 need an answer` |
| Open one agent | `Focus` opens the existing focus tab with the full log and returns to the grid |
| Empty fleet | `issues-agents-empty` panel, `0 running`, `Open Overview` control back to Overview |
| Long title | Two-line clamp with the full title in the heading tooltip |
| Narrow / wide | 1024 one column; 2101 four columns; no grid or document overflow |

## Measurements

- 1440: cards 511px wide, the three waiting cards share a 399px height and a bottom edge; each
  waiting log is 64px; the title slots are 38px.
- 1024: card 619px wide, one column; grid `scrollWidth === clientWidth`.
- 2101: cards 415px wide, four columns; grid `scrollWidth === clientWidth`.
- A waiting card's question block starts at the same y as its neighbour's; a card with fewer
  options leaves card surface below the question rather than stretching the log.
- Console: no page exception, console error, or failed asset request (`verify:interface` gates
  all three). No horizontal document scroll at either width.

## Rendered evidence

Under `.devboard/.design/issues-agents/shots/` (ignored by `.devboard/.design/.gitignore`):

- `agents-page-1440-dark.png` — two-column grid with three waiting cards; one has two options.
- `agents-page-1440-light.png` — the same state in light theme.
- `agents-page-1024-dark.png` — supported floor, one column.
- `agents-page-2101-dark.png` — the reported viewport width, four-column grid.
- `agents-page-empty-1440-dark.png` — empty fleet with the recovery control.

The older `agents-*.png` shots remain as the previous redesign's evidence; they are not used for
this run's verdict.

## Dependent pages

- `PageHeader` is reused unchanged.
- `IssuesAgentQuestion` is unchanged. `IssuesAgentLog` is reused with the new label wrapper; the
  Focus tab, Overview, and Scout usages pass `verify:interface` and `verify:issues`.
- The card CSS is scoped to `.issues-agent*`; the shared `.issues-activity` base is exercised by
  Focus, Scout, and Overview.
- `DESIGN.md` gains the fleet-card entry; `design/tokens.json` and `openui.json` are unchanged.

## Not run

- Storybook: the card is a page-level composition, not an `openui.json` primitive, and no token
  changed; no story was added.
- Mobile: the interface requires 1024×720 and replaces the workspace with a viewport notice
  below it; there is no mobile layout to capture.
- Live designmd MCP: not configured in this session. The research receipt records that gap and
  relies on the repository's existing designmd.ai receipts; no token or kit value was invented.
- The production dashboard on port 8081 was not used for the after evidence; every capture above
  comes from the worktree build.

## Verdict

pass — default, waiting, empty, long-title, narrow, wide, and light-theme states were exercised;
the scan, answer, and focus journeys pass the live fixture and the repository contract suites.

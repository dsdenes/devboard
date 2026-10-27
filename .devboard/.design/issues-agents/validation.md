# Validation — Issues / Agents

- Page: Issues → Agents (`#workspace-issues > section.issues-agents-page`).
- Branch: `issue-240`; commit: the revision that carries this file (merge to `main` after review).
- Command: `cd .devboard && bun run build`, `bun run check`, `bun run verify:interface`,
  `bun run verify:issues`, `bun test`.
- Base URL: `http://127.0.0.1:8141/` (three-agent fixture) and `http://127.0.0.1:8142/`
  (empty fixture), launched from the worktree with `STATIC_DIR` pointing at the final build. An
  earlier 12-agent fixture at `http://127.0.0.1:8137/` covered the many-card layout.
- Playwright source: OMP browser (Playwright-backed Chromium), plus the repository's
  `verify-interface.ts` CDP contract.
- Viewports: 2101×1017 (the issue capture), 1440×900, 1024×720. 390×844 is not supported: the
  app replaces the workspace with the viewport guard below 1024×720 by design.

## Journeys exercised

| Journey | Evidence |
|---|---|
| Scan the fleet | 12 cards in the wide fixture and 3 in the final fixture; 4 columns at 2101, 2 at 1440, 1 at 1024; status and log inside every card box; no horizontal overflow |
| Find the blocked agent | 3-agent fixture: header badge `3 need an answer`, every card `data-asked="true"`, warning border, `needs answer` badge, question block |
| Answer and clear one question | `verify-interface.ts`: answer carries the run id, only that agent's question clears, header falls to `2 need an answer` |
| Focus one agent | `verify-interface.ts`: Focus opens the existing focus tab with the full log and returns to the grid |
| Empty fleet | `issues-agents-empty` panel, `0 running`, `Open Overview` control; the control returns to Overview |
| Long title | two-line clamp with the full title in the heading tooltip (card `#233` in the fixture) |
| Failed run | `#237` renders `failed` with the error badge tone |
| Zero/one/many | empty fixture, one-card edit iteration, 12-card fixture |

## Rendered evidence

- `shots/agents-baseline-2101-dark.png` — before: 167px cards, status clipped below the card,
  activity collapsed to 21px (`scrollHeight 4143`).
- `shots/agents-2101-dark.png` — after at 2101×1017.
- `shots/agents-1440-dark.png` — after at 1440×900.
- `shots/agents-1024-dark.png` — after at 1024×720.
- `shots/agents-empty-1440-dark.png` — empty fleet with the recovery control.
- Shots are ignored by `.devboard/.design/.gitignore`; they are local evidence, reproduced by the
  preview fixture.

## Measurements

- 2101: cards 415×397, 4 columns; grid `scrollWidth === clientWidth`.
- 1440: cards 511×397, 2 columns; no page or grid horizontal overflow.
- 1024: card 619×397, 1 column; no horizontal overflow.
- Status badge and activity bottom are inside the card rect on every card (asserted in
  `verify-interface.ts`).
- Activity surface: 96px visible, own scroll (`scrollHeight 155`, `clientHeight 94` in the final
  fixture), newest line followed by the shared `IssuesAgentLog`; command rows keep their accent
  prompt and chip from the merged activity-log design.
- Console: no errors or warnings on either fixture page (`tab.errors()` and `tab.console()` empty).
- Wireframe: `.design/a2ui/issues-agents.wireframe.html` has no horizontal overflow at 1440×900
  and 390×844; it is a structure rendering, not the product surface.
- Focus: native controls keep the 2px ring; the issue link has a 2px outline-offset ring from the
  shared rule. Card heading is the `aria-labelledby` target.

## Dependent pages

- `PageHeader` is reused unchanged; Goal pages keep their stories and `verify-interface.ts`
  coverage.
- `IssuesAgentQuestion` is unchanged. `IssuesAgentLog` gained the shared terminal treatment from
  `main`; the Focus-tab, Scout, and overview usages pass `verify:interface` and `verify:issues`.
- The card CSS is scoped to `.issues-agent*`; the merged `.issues-activity` base is exercised by
  Focus, Scout, and Overview.

## Checks

- `bun run check`: 0 errors, 0 warnings.
- `bun run verify:interface`: pass on the final merged tree (includes the new empty, header,
  marker, and clipping checks).
- `bun run verify:issues`: pass on the final merged tree.
- `bun test`: 554 pass, 0 fail on the final merged tree.

## Findings

- Before the change the grid forced every card to a 167px row while `overflow: hidden` clipped the
  status at `y=267` and the activity to 21px; the surface therefore hid its own status. The
  content-sized card plus `grid-auto-rows: max-content` resolves it.
- The empty-state button initially stretched to the panel width inside the flex column; wrapping it
  in `.toolbar` restored the 28px control width (112×28 measured).
- No duplicate fact found in the rendered redesign: fleet count once in the header, status once per
  card, start time once per card, activity once per card, question once on its card.

## Not run / blocked

- Light theme was not captured for this page. Tokens are unchanged and both themes map through the
  same custom properties; dark is normative in `DESIGN.md`.
- designmd MCP research could not run (no MCP manager in this session); no design-system artifact
  was mutated, so the gate is not bypassed. See
  `.devboard/.design/research/2026-10-27-issues-agents.md`.

## Verdict

pass — default, empty, long-title, failed, question, and narrow states were exercised in the
browser; the primary scan/focus/answer journeys pass both the live fixture and the repository
contract suite.

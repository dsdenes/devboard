# Decisions — Issues / Agents

## Composition

- **One content-sized card per agent.** The card is a `surface` panel with 10px padding and an
  8px internal rhythm: identity row, two-line title, meta line, bounded log, optional question.
  The grid uses `grid-auto-rows: max-content` and `align-items: start`, so a question card grows
  without stretching its neighbours and no card clips its own status or log.
- **PageHeader replaces the bespoke header.** The surface was rendering the old
  `issues-overview__header` while every redesigned page uses `PageHeader`. The header now carries
  the breadcrumb eyebrow, one 20px title, the repository as subtitle, and the fleet badges in the
  meta row. The running count is not repeated anywhere else.
- **The question count is the only new summary.** A warning badge appears only when an agent is
  blocked; it is the page-level reason to look lower on the page. Cards carry a matching
  `needs answer` badge and a warning border, and the question block itself is the action.

## Removed or compressed information

- **Run id off the card.** It duplicates the start timestamp and is an internal state path; the
  Focus tab already shows it above the full log. `data-run` still carries it for the contract.
- **Exact ISO start line off the card.** The card shows elapsed time plus a compact local clock;
  the exact `startedAt` string stays in the meta line's tooltip. One fact, one visible form.
- **Activity height 96px, not 220px.** Every card still renders the full stream, follows new
  lines, and scrolls; the card shows about six lines instead of dominating the fleet. Focus keeps
  the tall log.

## Layout and state

- Two columns at 1440, four at 2101, one at the 1024 floor; 12px grid gap throughout. No
  horizontal scroll at any checked width.
- The empty fleet renders one panel with an `Open Overview` recovery control instead of a blank
  grid; the header count reads `0 running`.
- Failed runs take the `error` badge tone; running takes `accent`; any other completed state takes
  `success`. The status word is always rendered, so color is never the only signal.

## Design-system boundary

No token, `DESIGN.md`, OpenUI, or Storybook change. The page reuses `PageHeader`, `Button`,
`IssuesAgentLog`, `IssuesAgentQuestion`, `.badge`, and `.panel`. All new CSS is scoped to
`.issues-agent*` and uses the approved 2/4/6/8/12/96px geometry and existing tokens.

## Divergences from the wireframe

| Wireframe | Implementation | Why |
|---|---|---|
| Card titled above the identity row | identity row first, then the title | the status and Focus control are the scan target; the title follows the number |
| Empty state drawn under the grid in the same page | empty panel replaces the grid | a grid `data-testid` with no items invites a blank layout assertion |
| `latest activity stream` placeholder | the real full streamed log in 96px | the contract keeps the full log rendered; only the visible window is smaller |

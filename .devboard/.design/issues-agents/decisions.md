# Decisions — Issues / Agents

## Composition

- **One uniform card per agent.** The card is a `surface` panel with 10px padding and an 8px
  internal rhythm: head (issue link + `Focus`), a two-line title slot, meta line, labeled
  activity, optional question. The grid uses `grid-auto-rows: max-content` with
  `align-items: stretch`; every card in a row shares a height and the activity region absorbs the
  slack.
- **One state word per surface.** The page header counts the fleet (`N running`) and the waiting
  questions (`N need an answer`). A card no longer repeats either as a pill: the warning-bordered
  card and the full question block name the waiting state, and every card is on the page because
  it is running. `data-status` still carries the raw run status for the contract.
- **Activity is a labeled stat, not a raw wall.** A `Latest activity` `overline` sits above the
  shared `.issues-activity` block. The log follows its newest line, scrolls internally, is 64px
  on a waiting card, and fills the remaining card body otherwise.
- **The question block is the alert.** It takes a 2px `warning` left edge on `warning-surface`
  and follows the activity, so two questions in a row start at the same height. Its text, options,
  and answer control carry the meaning; colour is reinforcement only.
- **`Focus` is the only card action.** It sits in the card head at a constant 28px line; the
  issue number is a native link to the tracker. No card-wide click target and no second action.

## Removed or compressed information

- **Per-card `running` word.** It repeated the page's own purpose and the header count.
- **Per-card `needs answer` pill.** It repeated the header count and the question block; the
  warning border remains as a scan aid.
- **Run id off the card.** It duplicates the start timestamp and is an internal state path; the
  Focus tab shows it above the full log. `data-run` still carries it.
- **Exact ISO start line off the card.** The meta line shows elapsed plus a compact local clock;
  the exact `startedAt` string stays in the meta line's tooltip.
- **Unbounded activity height.** The old 96px block was neither uniform nor a true preview; a
  labeled block with a content-driven fill makes card heights stable.

## Layout and state

- Two columns at 1440, four at 2101, one at the 1024 floor; 12px grid gap throughout. No
  horizontal scroll at any checked width.
- The empty fleet renders one panel with an `Open Overview` recovery control instead of a blank
  grid; the header count reads `0 running`.
- A waiting card keeps its warning border and question block until the next state push clears
  that agent's question; neighbours keep their height and their activity area.
- A malformed `startedAt` renders the raw value in the meta line; no invalid date is produced.
- Loading and error states belong to the issues socket: the page keeps the last snapshot and
  never claims a state it does not have.

## Design-system boundary

`DESIGN.md` gains one component entry for the fleet card; `design/tokens.json`, `openui.json`,
and the Storybook stories are unchanged because no token or catalog primitive changed. All new
CSS is scoped to `.issues-agent*` and uses existing custom properties plus the approved
2/4/6/8/10/12 spacing scale and 4px panel radius.

## Divergences from the wireframe

| Wireframe | Implementation | Why |
|---|---|---|
| Card drawn with fixed two-line title | same, via `min-height: calc(2 * 1.45em)` | keeps the meta row and activity label aligned across a row |
| Question shown as a tinted block | `warning` left edge plus `warning-surface` | matches the established alert treatment without a second full border |
| Activity drawn as a bounded box | fills non-waiting cards; 64px on waiting cards | uses the row's slack without inflating a neighbour |

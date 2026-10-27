# Structure — Issues / Agents

## Regions and order

| A2UI ID | Region | Content | Journey / significance |
|---|---|---|---|
| `region_header` | Page header | eyebrow `Issues`, title `Agents`, repo subtitle, badges `N running` and `M need answer` | C10, C11, C12; scan |
| `region_grid` | Fleet grid | one card per active agent, sorted by issue; scrolls inside the workspace | scan |
| `card_identity` | Card header | linked `#N`, issue title (2-line clamp), status badge, Focus control | C1, C2, C4, C13 |
| `card_meta` | Card meta line | elapsed time with exact start in its tooltip | C6, C7 |
| `card_activity` | Card log | full activity stream in a 96px scroll surface, newest line followed | C8 |
| `card_question` | Card question | question message, option buttons, free-text answer | C5 |
| `region_empty` | Empty state | `No agents running`, instruction, `Open Overview` control | C14, C15 |

Order: header, then grid (or empty state), no footer. Cards are two-up to four-up by available
width, with `12px` gap, fixed maximum row content height, and `align-items: start` so a question
card grows without stretching its neighbours.

## Journey mapping

- Scan: `region_header` states the fleet size and how many need attention; `card_identity` and
  `card_meta` make 18 cards comparable at one glance; `card_question` stands out on exactly the
  blocked card.
- Answer: `card_question` remains inside the card, so the answer does not lose context.
- Inspect: `Focus` in `card_identity` opens the existing Focus tab; the card log is a preview, not
  a second detail page.
- Empty: `region_empty` explains that the worker is the next step and links to Overview.

## Significance mapping

- P0: C1, C4, C5, C12, C13 on every card or in the header.
- P1: C2, C6, C8, C11, C14 in the main flow.
- P2: C10 in the header subtitle, C7 in the elapsed tooltip.
- Dropped: C9.

## Primary action

One primary task: open the agent that needs attention. Every card exposes `Focus` as its only
action; the question block's answer controls are the same journey's blocking sub-action. No filled
`primary` control competes with them.

## State coverage

- Default: grid of active agents.
- Loading: the existing issues socket owns loading; the page renders the last snapshot and the
  header count. No skeleton (a new skeleton would be a second loading convention).
- Empty: `No agents running` plus `Open Overview`.
- Failed run: error-tone status badge and error edge; card stays readable.
- Question: warning edge, `needs answer` badge, question block.
- Long title: two-line clamp, full value in the tooltip.
- Many agents: grid scrolls; header remains in the page frame.
- Narrow viewport: 1024×720 floor; one column at ≤ 720px of workspace width, two at wider.
- Errors are not owned by this page; the issues socket keeps the last snapshot. The header and
  cards never claim a state they do not have.

## Responsive order

Cards keep identity → meta → activity → question at every width. Columns collapse from four to
one; no region is reordered or hidden. The supported minimum is the app's 1024×720 viewport.

## Rationale

The current equal-height grid shrinks every card to 167px, so the status badge and activity are
clipped below the card's own `overflow: hidden`. Making the card a content-sized column with a
bounded log restores the information the page promises while keeping 18 cards scannable. A table
would be denser, but the pending-question form and per-agent log belong together; a card keeps
them in one place without a second detail surface.

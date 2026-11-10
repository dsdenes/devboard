# Issues agent focus — structure

## Regions

1. **Page header** (unchanged): eyebrow `Issues · agent`, h1 `#<issue> <title>`, repo line, status
   badge, `Close`.
2. **Output panel** (the only panel): 30px header with the title `Output` on the left and the run
   identity group on the right; the body holds the activity log and, when present, the question.
3. **Unavailable state** (unchanged): one panel with one message and `Open Runs`.
4. **Loading state** (unchanged): one panel with `Loading the run from history…`.

## Header structure

```
[ Output ................................................. [run-id chip]  Started 4 min ago ]
```

- The title keeps the left edge; the identity group is right-aligned with an 8px gap.
- The identity group is one row: a `code-chip` carrying C1 verbatim, then the relative start C2.
- The chip takes at most 220px and ellipses; its `title` carries the complete id. The age keeps
  its own complete ISO timestamp in a tooltip. The title ellipses as the row narrows, so the
  identity group never wraps. Both live inside the panel header's existing `space-between` flex row.

## States

| State | Header | Body |
|---|---|---|
| Live run | chip + `Started … ago` | streamed log; question when asked |
| Finished run | chip + `Started … ago` from history | history log; no question |
| Unavailable | no output panel | message + `Open Runs` |
| Loading | no output panel | loading line |
| Narrow (1024px) | chip capped at 220px, age keeps one line | unchanged |

## Hierarchy

C4/C5 are the page's P0 content and fill the body. C1/C2 sit at P2 visually (11–11.5px) but are the
only identity the panel needs, so they share the header's right edge. C3 stays in the page header
as the single state badge; the panel header repeats no state.

## Responsive order

At every supported width the panel header is title then identity; the identity group never moves
above the title and never becomes a separate row. The title is the only flexible item, so it
ellipses as the header narrows while the identity group stays on one line.

## Rationale

- C1 and C2 answer "which run is this and when did it start"; one chip plus one age is the
  smallest complete answer.
- Reusing the inline code chip follows `DESIGN.md`: identifiers use one inline-code style, and the
  Discover run header already shows a run id as a chip with its start time.
- Removing the raw `panel__subtitle` treatment removes an unlabelled long identifier from the
  header's low-contrast text style without hiding it.

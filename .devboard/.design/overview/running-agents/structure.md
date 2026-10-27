# Structure — Overview / Running agents

## Regions

One panel in the Overview side column, below the Automation panel.

1. **Panel header (30px).** `h2` `Running agents` at the left. Right group carries the waiting
   count (`2 need answers`, warning tone) only while an agent waits. No fleet count: the Automation
   panel states it, and the header must not repeat a fact from 12px above.
2. **List body (flush).** One row per running agent, sorted by issue number (the store sorts).
   Rows are separated by a `border-subtle` rule. There is no inner scroll region: the side column
   owns scrolling, so a growing fleet never creates a second scrollbar.
3. **Empty body.** One muted sentence, `No agents running.`, at panel-body padding.

## Row

A row is two controls: the select button and a quiet close button.

| Order | Element | Rule |
|---|---|---|
| 1 | Issue number | 44px mono column, `muted-foreground`; `accent` while selected; tabular numerals |
| 2 | Title | one line, ellipsis, full title in the tooltip; `foreground`, 12px |
| 3 | Meta | right-aligned group: `needs answer` warning badge when blocked, elapsed `mono-small` with tabular numerals, 40px floor and right alignment so durations line up |
| 4 | Close | 24px quiet control, `muted-foreground`; `error-surface` + `error` only on its own hover/focus; disabled at 45% |

Row states:

- **Rest** — transparent, `border-subtle` divider from the row above.
- **Hover** — `row-hover` fill.
- **Selected (`aria-current="true"`)** — `accent-surface` fill and a 2px `accent` left edge inside
  the row's 10px left padding; the issue number takes `accent`. Hover over the selected row keeps
  the selected fill.
- **Focus** — the global 2px `ring` outline with 1px offset.
- **Close in flight** — the close control is disabled; the row stays interactive.

## States covered

- zero agents: empty sentence, header shows no waiting badge;
- one agent: one row, same geometry;
- many agents: rows grow the panel; the side column scrolls;
- long title: ellipsis, tooltip holds the full text;
- blocked agent: warning badge in the row, waiting count in the header;
- close refused: notification region reports it; the row and header are unchanged;
- light and dark theme: all colors are tokens.

## Responsive priority

The side column stacks under the output pane below 1100px; the row keeps its three columns. The
title column absorbs the shrinking width; the issue number, meta, and close never shrink. Close
stays a word at every supported width, so the destructive control never becomes an ambiguous glyph.

## Rationale

- C5 (score 87) is the row's flexible column; C9 (82) is a surface plus edge, not a word.
- C3 (76) and C6 (73) are the only warning carriers, and both keep the word.
- C7 (48) is secondary: size and muted color, aligned so the column scans.
- C10 (58) stays present but stops competing: the shipped row repeated a filled destructive fill
  11 times, which made the panel read as a wall of danger and buried C5.

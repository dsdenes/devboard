# Structure — Flow / Steering

## Regions and order

| A2UI ID | Region | Content | Journey / significance |
|---|---|---|---|
| `region_header` | Panel header | title `Steering`, one 11px state line | C1, C8, C9; send and review |
| `region_composer` | Composer | labelled textarea, right-aligned primary `Send` | C2, C3; send |
| `region_notes` | Note log | one row per note: text, then source, timestamp, status word | C4–C7; review |
| `region_empty` | Empty log | `No steering notes yet.` | C10; first visit |

Order: header, composer, notes (or empty line). The panel body scrolls; the header stays fixed.
The composer is the first body region so the primary action is visible without scrolling, even
with a long log.

## Journey mapping

- Send: `region_header` states when notes are read; `region_composer` holds the field and its
  action together; `region_notes` confirms the note was recorded and is `new`.
- Review: `region_header` summarizes waiting versus read; `region_notes` holds the detail.
- Empty: `region_header` explains checkpoint timing and `region_empty` explains the blank log.

## Significance mapping

- P0: C2 and C3 in `region_composer`; C8 in `region_header`.
- P1: C1 in the header, C4 and C7 in each note row.
- P2: C5 and C6 in the meta row, C9 and C10 in the empty state, C13 in the global notification
  region.
- Dropped: C12.

## Primary action

One primary task: send a steering note. `Send` is the only filled `primary` control in the panel
and sits 6px under the textarea it submits. It is disabled while the draft is blank, so an empty
note is unreachable.

## State coverage

- Default: existing notes, header `N notes waiting…` or `All notes read`.
- Empty: header `Read at the next checkpoint`, body `No steering notes yet.`
- Draft: `Send` enables on the first non-whitespace character.
- Sending: the client clears the draft on submit; the note row arrives over the existing socket.
  No separate pending UI, matching the rest of the Flow panels.
- Failure (no session): the existing notification region reports the refusal; the panel keeps its
  empty state and does not invent a note.
- Long note: the textarea keeps its 64px minimum and scrolls; a log row wraps.
- Many notes: the panel body scrolls; the composer stays at the top of the scroll content.
- Narrow viewport: one column; the state line may truncate but the composer and `Send` stay
  reachable.

## Responsive order

Header → composer → notes at every width. The workspace minimum is 1024×720; the panel is at
least 600px wide there, so the header state line fits on one line next to the title. No region is
hidden or reordered.

## Rationale

The shipped header put a 28px filled `Send` at the far right of a 30px bar, more than 1,200px from
its textarea at the operator's 1724px workspace, so the action looked like a page-level command and
its disabled state read as a live primary. Moving the action into the composer attaches it to the
field, and the header keeps only identity plus the one fact the operator needs before typing: when
the agent will read the note. The alternative — a header-only button restyle — would leave the
action divorced from its input and the header empty.

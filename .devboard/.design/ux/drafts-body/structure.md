# Draft goals body — structure

## Regions and order

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_page_header | Page title, repository · status · count (outside the selected element) | 1–3 | C7 | P0 outside |
| 2 | region_body | Body layout: one or two panels | 1–3 | C1–C6, C8 | P0 |
| 3 | region_list | Proposed goals panel: header, creation band, rows or empty stack | 1–3 | C1, C2, C4, C9 | P0 |
| 4 | region_detail | Selected draft detail or selection stack | 2, 3 | C5 | P1 |
| 5 | region_empty | Full-panel empty stack, only with zero drafts | 1 | C1, C2 | P0 |
| 6 | region_selection | Detail-column selection stack, only with drafts and no selection | 2 | C5 | P1 |

```
[page header: Draft goals · owner/repo · idle · 0 draft(s)]          outside the body

default with drafts, no selection
body (grid 240–340px + 1fr, 12px gap)
  Proposed goals panel
    panel header: title + filled New goal
    [creation band, only while open]
    rows: file name / heading / state badge / Start            C4, C9
  detail panel
    centered stack: pointer mark, No draft selected, copy       C5

empty, zero drafts (the captured state)
body (one full-width panel; no detail column)
  Proposed goals panel
    panel header: title + filled New goal
    centered stack: notebook mark, No drafts yet, creation copy C1, C2
```

## Primary action

- `New goal` in the Proposed goals panel header is the only filled primary. It stays in the same
  position in every state, including empty.
- Selecting a draft row is the primary content action; it does not get a page-level button because
  the whole row is the control.
- The selection stack adds no control: its copy points at the rows.

## Order and hierarchy

- The body answers one question per state: what can be done here (empty), or which draft to read
  (populated, no selection).
- The empty state is the panel body itself, not a nested card; the panel already owns the frame.
- With drafts the list keeps the narrow track and the detail uses the remaining width; below
  1100px the two panels stack list-first, preserving the select-then-read order.
- The empty state removes the detail column entirely rather than rendering a second empty panel.

## State coverage

- Loading: the store keeps the last snapshot; before the first snapshot the body can render the
  empty stack, and the page header's status is the only loading signal. No skeleton is added.
- Empty: one panel, no detail column, centered stack with title and copy.
- Drafts, no selection: two panels; the detail column carries the selection stack.
- Selected: the unchanged detail panel replaces the selection stack in place.
- Error: the store's notices and the detail's own error alert own failures; this element adds no
  banner and never claims the directory is empty when a read failed.
- Partial: a draft whose file vanishes is dropped by the next poll; the selection clears and the
  body returns to the selection stack, or to the empty panel when the directory is empty.
- Success: a created draft arrives through the poll and replaces the empty panel with the list in
  place.

## Responsive order

- ≥1100px: list 240–340px, detail flexible; empty body is one full-width panel.
- <1100px: one column, list panel first, detail (or selection stack) second; the page owns
  vertical scrolling. The empty body stays one panel.
- 1024×720 floor: the 360px stack fits inside the 618px body with no horizontal scroll; long copy
  wraps to two lines.
- No collapse into menus, tabs, or icon-only controls.

## Rationale

- The old body rendered two empty panels side by side. Removing the detail column when nothing can
  be selected deletes a container that exists only to hold a sentence.
- Reusing the documented compact empty-state grammar (20px muted mark, 13px/600 title, one 12px
  muted line, 360px cap, 24px 16px padding) makes both states read as deliberate rather than
  stranded text, without adding a frame, fill, shadow, or shared component.
- The header keeps `New goal`; the empty state explains it instead of repeating the action, so the
  page keeps exactly one filled primary.
- Alternatives rejected: keeping two empty panels (empty chrome), a full-width dashed drop zone
  (no drop affordance exists), a second `New goal` button in the empty state (duplicate primary),
  and automatically selecting the first draft (hides the list's role and writes a selection the
  operator did not make).

# Prepared skill detail — structure

The Skills page keeps its shipped shape: page header, prepared-skills panel, and the document
panel below it. This redesign changes the document panel's internal structure and the height
split between the two panels.

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_skills_header | Skills page header, readiness, `Prepare skills again`, `Close` | 1 | C2, C13 | P0 |
| 2 | region_skills_list | Prepared-skill rows with selection; capped at 40% while a document is open | 1, 3 | C1, C2, C3, C4 | P0 |
| 3 | region_skill_document | Selected skill: 30px header and the scrolling instructions | 1, 2, 3 | C5, C7, C8, C10, C11 | P0 conditional |

## Document panel

| Order | A2UI ID | Region | Items | Notes |
|---|---|---|---|---|
| 1 | skill_document_header | 30px panel header: skill name (mono) on the left, `.omp/skills/<name>/SKILL.md` on the right | C5, C7 | The path truncates with a full-path title; the name never shrinks. The description is not repeated here. |
| 2 | skill_document_body | Markdown document with a 940px reading measure | C8 | The panel body, not the page, owns the scroll. |
| 3 | skill_document_empty | Missing-file line or metadata-only line | C10, C11 | Same position as the body; no frame of its own. |

Document typography: one `h1` at `section-title` size (18px/650), prose at `body` size (13px,
1.55), `h2` at 13px/650, `h3`–`h6` at 12px/650, bullets with 16px hanging indent and 4px between
items. Inline code uses the shipped `.code-chip` values (mono 11.5px, `background` fill,
`border-subtle`, 3px radius, 2px 6px padding). Fenced blocks use `background`, a
`border-subtle` 1px outline, 8px padding and horizontal scroll. Raw HTML renders as text and
links open in a new tab; external link targets are limited to non-script URLs.

## Height split

- No selection: the list panel fills the page and the document panel does not exist.
- Selection: the list panel caps at 40% of the page height and scrolls its rows; the document
  panel takes the remaining height with a 240px floor. At 1024×720 the document body scrolls
  (observed 476px of content in 191px before the floor was raised; 240px floor restores a usable
  reading area).
- The page does not scroll horizontally; `goal-page--fill` keeps its 56px bottom reserve.

## States

- **No skills:** list shows the shipped empty line; no document panel.
- **Selected:** one row has `aria-current="true"` and `data-selected="true"`; the header names
  that skill.
- **Missing file:** "This skill has no file on disk; prepare the skills again to write it."
- **Metadata-only file:** "This skill's file carries only preparation metadata; there are no
  instructions to read."
- **Long document:** body scrolls; the header stays fixed.
- **Disconnected:** the last document stays readable; dispatch controls elsewhere are disabled.
- **Narrow:** path truncates first, then the list descriptions wrap; the name stays whole.
- **Keyboard:** rows remain native buttons; Tab order is list rows, delete controls, then the
  document's links.

## Responsive order

The layout is already one column inside the Goal workspace. At workspace widths below 900px the
document header keeps name and path on one line and truncates the path; the reading measure falls
to the panel width. The list cap stays 40% at every supported size.

## Rationale

- **The document is the content, not a log.** Syntax-highlighted semantics (headings, bullets,
  code) let the operator scan rules instead of decoding a monospace dump.
- **Frontmatter is noise.** Its only useful facts are already in the list and header; its marker
  is an implementation detail.
- **The list yields to the document.** The shipped page kept the list at full height and let the
  raw block grow past the viewport, forcing a page scroll. Capping the list gives the document a
  stable, scrollable frame.
- **Path, not description, in the header.** The description is directly above in the selected
  row; the path is the fact the header can add.
- **Rejected alternative: a raw/rendered toggle.** Reading Markdown source is available in the
  editor at the stated path; the dashboard's job is to present the instructions.
- **Rejected alternative: master-detail columns.** At 1024px the sidebar leaves 652px; splitting
  it would starve the document and duplicate the selected row. The stacked shape already matches
  the page's scroll contract.

# Prepared skill detail — structure

The Skills page keeps its shipped shape: page header and one prepared-skills panel. Selecting a
row expands its detail inline inside the list; selecting it again collapses it. This redesign
changes only the expanded detail: it replaces the raw `SKILL.md` dump with a rendered Markdown
document and a path line.

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_skills_header | Skills page header: title, contradiction badge, `Prepare skills again`, `Close` | 1 | C13 | P0 |
| 2 | region_skills_list | Prepared-skill rows with a chevron and selection state | 1, 3 | C1, C2, C3, C4 | P0 |
| 3 | region_skill_document | Inline expanded detail under its row: path line and the scrolling document | 1, 2, 3 | C5, C7, C8, C10, C11 | P0 conditional |

## Expanded row

| Order | A2UI ID | Region | Items | Notes |
|---|---|---|---|---|
| 1 | skill_detail_path | `.omp/skills/<name>/SKILL.md` in `mono-small` muted | C7 | One line above the document; truncates with the full path in `title`. |
| 2 | skill_detail_document | Rendered Markdown with a 940px reading measure | C8 | The list panel body owns the scroll; the page keeps its fixed shell. |
| 3 | skill_detail_empty | Missing-file line or metadata-only line | C10, C11 | Same position as the document; no frame of its own. |

Document typography: one `h1` at `section-title` size (18px/650), prose at `body` size (13px,
1.55), `h2` at 13px/650, `h3`–`h6` at 12px/650, bullets with 16px hanging indent and 4px between
items. Inline code uses the shipped `.code-chip` values (mono 11.5px, `background` fill,
`border-subtle`, 3px radius, 2px 6px padding). Fenced blocks use `background`, a
`border-subtle` 1px outline, 8px padding and horizontal scroll. Raw HTML renders as text and
links open in a new tab; external link targets are limited to non-script URLs.

The shipped `.skill__detail` rule (2px `border-strong` left edge, 4px/8px inset) stays; the
document sits inside it.

## States

- **No skills:** list shows the shipped empty line; no expandable row.
- **Collapsed:** no `skill-content` element; the row's chevron points right.
- **Expanded:** one row has `aria-expanded="true"`, `aria-current="true"`,
  `data-selected="true"`, and owns the `skill-content` region named after the skill. Selecting
  another row expands it and collapses the previous one.
- **Missing file:** "This skill has no file on disk; prepare the skills again to write it."
- **Metadata-only file:** "This skill's file carries only preparation metadata; there are no
  instructions to read."
- **Long document:** the prepared-skills panel body scrolls; the page does not.
- **Disconnected:** the last document stays readable; dispatch controls elsewhere are disabled.
- **Narrow:** the path truncates first, then the row descriptions wrap; the name stays whole.
- **Keyboard:** rows are native buttons with `aria-controls`; Enter/Space expands or collapses;
  links in the document use the global focus ring.

## Responsive order

One column inside the Goal workspace. The expanded document falls to the list width at 1024×720;
its measure is 600px there (observed), so prose wraps rather than overflows. The list panel body
scrolls 861px of content in 530px at 1024×720, with zero page overflow in either axis.

## Rationale

- **The document is the content, not a log.** Syntax-aware semantics (headings, bullets, code)
  let the operator scan rules instead of decoding a monospace dump.
- **Frontmatter is noise.** Its only useful facts are already in the row and the path line; its
  marker is an implementation detail.
- **Inline expansion already owns the interaction.** The shipped accordion keeps the selected
  skill next to its row and lets the list panel scroll; the redesign does not reintroduce a
  separate detail panel, so there is one selection model and one scroll surface.
- **Path, not description, in the detail.** The description is in the row above; the path is the
  fact the expanded area can add.
- **Rejected alternative: a raw/rendered toggle.** Reading Markdown source is available in the
  editor at the stated path; the dashboard's job is to present the instructions.
- **Rejected alternative: a separate detail panel below the list.** It duplicated the accordion's
  selection model and forced a second scroll area.

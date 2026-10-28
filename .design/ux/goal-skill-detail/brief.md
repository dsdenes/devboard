# Prepared skill detail — brief

## Page identity

- **Route:** `/` → Goal mode → Skills page (`#workspace-goal`, `data-testid="skills-overlay"`).
- **Surface:** the inline `skill__detail` region inside the prepared-skills list, opened by
  selecting a row.
- **Entry points:** a row in the prepared-skills list, or a skill in the sidebar's Skills
  disclosure. Both arrive with the Skills page open and that row expanded.
- **Audience:** the repository operator, signed into the local dashboard, while deciding whether
  the prepared instructions are ready for implementing agents.

## Primary goal

Let the operator read one prepared skill's instructions and judge whether they are correct,
complete, and free of contradictions. The observable success signal is that the operator can
explain the skill's rules without opening `.omp/skills/<name>/SKILL.md` in an editor.

## Secondary goals

- Confirm which file the document comes from, so the operator can edit or delete it.
- Move between prepared skills without losing the list.

## Arrival context

The operator prepared skills from a goal and is auditing the result. They already understand the
repository, the skill list, and the skill description; they arrive to read one skill in detail.
The document expands under its row; the list panel scrolls as one surface. The viewport is at least 1024×720 and usually wide;
the operator may keep the panel open while switching skills.

## Relationship to other pages

- **Upstream:** Goal document → Skills. The page header names Skills and owns
  `Prepare skills again` and `Close`; the prepared list owns the count.
- **Downstream:** the operating agent reads the same file from `.omp/skills/`; a contradiction
  found here returns the operator to `Prepare skills again`.
- **Loop:** selecting another row replaces the document in place.
- **State left behind:** the selected skill survives while the Skills page stays open; closing
  the page returns to the Goal implementation page.

## User journeys

### Journey 1 — read a prepared skill

1. Trigger: the operator opens Skills from the sidebar or the Goal document.
2. Steps: scan the prepared list, expand a row, read the instructions.
3. Decision points: are the rules clear, current, and consistent with the other skills?
4. Success: the operator can state the skill's rules.
5. Failure routes: the file is missing; the file has no instructions; the document is long and
   the list panel must scroll.
6. Recovery: collapse or switch the row, `Prepare skills again`, or `Close`.
7. Exit: close the Skills page or navigate to an ADR or the implementation page.

### Journey 2 — locate the source file

1. Trigger: a rule looks wrong and the operator wants to edit it.
2. Steps: read the selected skill, note its file path.
3. Success: the path `.omp/skills/<name>/SKILL.md` is visible above the document without a
   tooltip round trip.
4. Failure route: a very long skill name truncates the path; the title attribute still carries
   the full path.
5. Exit: open the file in an editor.

### Journey 3 — compare skills

1. Trigger: two skills appear to disagree.
2. Steps: read one skill, select the next, repeat.
3. Success: expanding another row collapses the previous one and shows the new document from
   its first heading.
4. Failure route: the list scrolls while the document is read; the expanded row stays marked.
5. Exit: return to the list or prepare skills again.

## Non-goals

- Editing the skill in place. The document is read-only; edits go through the host's skill file
  and `Prepare skills again`.
- Showing the preparation agent's transcript or the raw YAML frontmatter.
- Comparing two skills side by side.
- Browsing skills that were not prepared.

## Assumptions

- Skill content is Markdown with optional YAML frontmatter; the server sends the whole file.
- Skill names fit the sidebar and panel header at supported widths; longer names truncate the
  path before the name.
- Skill documents are ordinarily shorter than one screen, but long ones are plausible; the
  prepared-skills panel body, not the page, must scroll.

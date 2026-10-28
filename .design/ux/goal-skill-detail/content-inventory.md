# Prepared skill detail — content inventory

Candidates come from the shipped `goal-skill-detail` panel (header plus one `<pre>` of the whole
`SKILL.md`) and from the surrounding Skills page.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Prepared skill rows: name and description | `goal.skills[]` | 1, 3 | Choose which skill to read | Keep | The list is the only skill switcher on the page |
| C2 | Prepared skill count | `goal.skills.length` | 1 | Confirm preparation produced the expected set | Keep | Prepared-skills panel header; the page header no longer repeats readiness |
| C3 | Contradiction warnings | `goal.contradictions` | 1 | Decide whether to prepare again | Keep | Appears below the list when present |
| C4 | No-contradiction line | `goal.contradictions.length === 0` | 1 | Close the audit | Keep | One line; keeps the audit result explicit |
| C5 | Selected skill name | `goal.selectedSkill` | 1, 2, 3 | Confirm which document is open | Keep | Detail header identity |
| C6 | Selected skill description | `SkillSummary.description` | 1 | Restate what the skill covers | **Drop from detail** | Already in the selected list row directly above; a second copy adds nothing |
| C7 | Skill file path | `.omp/skills/<name>/SKILL.md` | 2 | Find and edit the source | Keep | The list row does not state it and the page header no longer shows the directory |
| C8 | Document instructions (Markdown body) | `SkillSummary.content` | 1, 3 | Judge readiness | Keep | The reason the panel exists |
| C9 | YAML frontmatter (`name`, `description`, `metadata`) | head of `SKILL.md` | — | None; bookkeeping | **Drop** | Duplicates C1/C5 and exposes an implementation marker |
| C10 | Empty file message | absence of `content` | 1 | Understand why nothing opens | Keep | Shows recovery: prepare again |
| C11 | Metadata-only message | frontmatter with no body | 1 | Understand why the document is blank | Keep | Prevents an unexplained empty panel |
| C12 | Loading and disconnection state | socket status | 1 | Decide whether the view is trustworthy | Keep | Panel content persists; no skeleton |
| C13 | Close, `Prepare skills again` | page header | 1 | Leave the audit or regenerate skills | Keep | Page-level, unchanged |

## Removed by this redesign

- **Raw file as one block.** The shipped `<pre>` showed frontmatter, heading syntax, bullets, and
  prose in one 11.5px monospace voice, with no hierarchy and no reading measure.
- **Description in the detail header.** C6 is the same sentence as the selected list row.
- **`devboard-managed: "true"`.** An implementation marker the operator cannot act on.

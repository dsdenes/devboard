# Discover skill header — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Relative path `<skill>/SKILL.md` | `activeSkill` | J1–J4 | Confirms which file the editor owns | yes | The only on-page file identity; the page title is a label, not a path |
| C2 | Draft state (`No unsaved changes`, `Unsaved changes`, `Live file missing`) | `skillDirty`, `skill.state` | J1–J4 | Decides whether to save, discard, or recreate | yes | The state qualifies the Save control |
| C3 | Save | `saveDiscoverSkill` | J2 | Writes the draft | yes | Primary action of the page |
| C4 | Discard edits / Recreate generated version | `restoreDiscoverSkill` | J3, J4 | Returns to the generated baseline | yes | The only recovery for an edited or missing file |
| C5 | Page title (`Naming Conventions`, …) | `skillTab.label` | J1 | Orients the developer inside Discover | yes | It names the policy, not the file; it stays in the page header |
| C6 | Sidebar `edited` / `missing` flag | `sidebar` skill rows | J1 | Chooses a skill to open | yes | Navigation state, outside this header; not repeated as a badge |
| C7 | Purpose sentence | Generated skill description | — | Explains the policy | no | The body and the generated skill carry it; prior operator feedback removed it |
| C8 | State badge | — | J1 | Repeats C2 as a pill | no | The sidebar already flags edited/missing; prior feedback removed the badge |

## Conflicts and resolutions

- `skillDirty` vs `skill.state`:
- Winner: `skillDirty` for the draft word, `skill.state` only when the live file is missing.
- Why: a dirty draft is the immediate fact; `missing` prevents Save and changes the recovery
  control. A clean edited skill is still `No unsaved changes` because the draft matches disk.
- Page title vs relative path:
- Winner: both, in different regions.
- Why: the title names the policy; the path names the file. They answer different questions.

## Removed candidates

- Purpose sentence: removed by the prior operator feedback and not required by a journey.
- State badge: duplicates the sidebar flag and conflicts with that same feedback.

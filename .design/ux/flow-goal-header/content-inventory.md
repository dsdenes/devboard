# Flow goal header — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | The surface name `Flow goal` | Static label | All | Identifies the target of create/save | yes | The header is the only identity for the editor below it. |
| C2 | Goal state: no goal, saved, unsaved changes, or interview running | `flow.goal`, `flow.goalDirty`, `flow.goalCreation` | 1, 2, 3 | Decides whether to create, save, or wait; explains disabled actions | yes | Without it the developer cannot tell a stale draft from a saved goal. |
| C3 | Create/recreate action | `flow.createGoal` | 1, 3 | Starts the goal interview | yes | The only path to a goal when none exists or the saved one is wrong. |
| C4 | Save action and its availability | `flow.saveGoal`, `flow.goalDirty` | 2, 3 | Persists the draft | yes | The critical action for the editor's content. |

## Conflicts and resolutions
- `flow.goalDirty` vs the text in the editor:
- Winner: `flow.goalDirty`, computed against the saved goal.
- Why: it is the source of truth the save path uses; the editor text alone cannot
  distinguish an unsaved change from a saved one.

## Removed candidates
- Session directory and `goal.md` path: implementation detail; the Session panel owns
  session facts, and no declared journey needs the path.
- Goal excerpt or heading: duplicated by the editor directly below, which already
  shows the text.
- Session status, branch, PR, widget/file/checkpoint counts: owned by the Session and
  other panels; repeating them here would duplicate information.
- Character count or last-saved timestamp: the server does not report either, and no
  journey needs them.

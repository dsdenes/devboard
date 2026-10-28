# Decision board — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | The surface name `Decision board` | Static label | All | Identifies the editor below it | yes | The header is the only identity for this surface. |
| C2 | Board state: no decisions yet, saved, or unsaved changes | `flow.decisions`, `flow.decisionsDirty` | 1, 2, 3 | Decides whether to write, save, or leave the board | yes | Without it a stale draft is indistinguishable from a saved board. |
| C3 | Save action and its availability | `flow.saveDecisions`, `flow.decisionsDirty` | 1, 2 | Persists the draft | yes | The only path from the editor to the board the agent reads. |

## Conflicts and resolutions
- `flow.decisionsDirty` versus the editor text:
- Winner: `flow.decisionsDirty`, computed against the saved board.
- Why: it is the state the save path uses; the text alone cannot tell a draft from the saved copy.

## Removed candidates
- Character count, word count, or last-saved timestamp: the server reports none of them and no
  journey needs them.
- A board excerpt or first heading: duplicated by the editor directly below.
- Session status, branch, checkpoints, and blockers: owned by the Flow sidebar and other panels.
- Keyboard hint for Ctrl/Cmd+S: the editor's accessible label and the command palette already
  carry it; repeating it in the header adds noise without a decision.

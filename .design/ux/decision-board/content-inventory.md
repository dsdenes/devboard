# Decision board — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | The surface name `Decision board` | Static label | All | Identifies the read-only board below it | yes | The header is the only identity for this surface. |
| C2 | Board state: saved, no decisions yet, or restoring | `flow.decisions`, `flow.restoring` | 1, 2, 3 | Decides whether the board is settled, empty, or still restoring | yes | Without it an empty restore frame is indistinguishable from a settled empty board. |
| C3 | Board content: the decision markdown bytes | `flow.decisions` | 1, 2, 3 | Tells the developer and the implementation agent what was decided | yes | The board is the surface's only content. |

## Conflicts and resolutions
- An empty `flow.decisions` while `flow.restoring` versus a settled empty board:
- Winner: `flow.restoring`.
- Why: a restore frame carries an empty board on purpose, so it is not a settled board and must
  not read as one.
- A local draft versus the stored board:
- Winner: the stored board only. There is no draft: the page has no editor, no save action, and
  no dirty field.

## Removed candidates
- Save action and its availability: the store exposes no save path and no dirty field; decisions
  are written by the Flow session, not this page.
- Markdown editor, line numbers, and the editor placeholder: the shipped body is one read-only
  `<pre>` of the stored bytes.
- Character count, word count, or last-saved timestamp: the server reports none of them and no
  journey needs them.
- A board excerpt or first heading: duplicated by the board bytes directly below the header.
- Session status, branch, checkpoints, and blockers: owned by the Flow sidebar and other panels.
- Keyboard hint for Ctrl/Cmd+S: there is no save command; the hint would promise a write.

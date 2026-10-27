# Content inventory — Flow / Decision board header

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Panel title `Decision board` | static | 1–4 | names the surface | keep | one name for the region; matches the sidebar and tab |
| C2 | Draft state (`Saved`, `Unsaved changes`, `No decisions yet`) | `flow.decisionsDirty`, `flow.decisions` | 1–4 | decide whether to save or leave | keep | the only in-surface answer to "did my edit stick?" |
| C3 | `Save` action | `flow.saveDecisions` | 2 | persist the draft | keep | primary action of the surface |
| C4 | Save disabled state | `flow.decisionsDirty` | 1,3 | avoid meaningless writes | keep | expresses C2 at the control itself |
| C5 | Save tooltip | derived | 1,2 | explain why Save is disabled | keep | tooltip only; no extra visible text |
| C6 | Sidebar unsaved badge | `flow.decisionsDirty` | 4 | find the dirty tab from elsewhere | keep | different region (navigation), not a duplicate on this screen |
| C7 | Editor dirty dot | `MonacoEditor` | 1,2 | local edit feedback | keep | editor chrome, unchanged |
| C8 | Document size, line count | editor | — | — | drop | the editor already shows it; the header is not a metrics strip |
| C9 | Saved timestamp | none in state | — | — | drop | no source of truth exists; inventing one would lie |
| C10 | `Ctrl/Cmd+S` hint | static | 2 | discover the keyboard path | drop | the editor's Save control and shortcut are established; a second hint would repeat it |

The shipped header carried C1 and C3 only. C2 and C4 are added; the rest is unchanged. The header
does not repeat the sidebar's unsaved badge because both facts are about different regions: the
sidebar answers "which tab is dirty", the header answers "is this board saved".

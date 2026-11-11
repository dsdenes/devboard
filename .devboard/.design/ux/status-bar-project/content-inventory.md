# Content inventory — status bar project identity

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| P1 | Last path segment of the served checkout | `connection.projectPath` | 1, 2 | Confirms which repository the dashboard serves | Keep | The one fact the item exists for |
| P2 | Full project path | `connection.projectPath` | 3 | Disambiguates a repeated directory name | Keep, as tooltip only | Inline at 11px it is unreadable; the sidebar already carries it |
| P3 | Connection state word and dot | `connection.state` | 2 | Separates "wrong project" from "no live state" | Keep, in its own item | Owns a different decision; must not merge into the project |
| P4 | Provider selection | `providers.selection` | — | Chooses the model provider | Keep, in its own control | Different decision, already has a control |
| P5 | Owner/repository qualifier (for example `dsdenes/devboard`) | `issues.repo` | 1 | Disambiguates two checkouts of the same name | Omit | Couples the shell identity to the Issues worker's state; the tooltip already answers it |
| P6 | Git branch of the checkout | not in `connection` | 1 | Confirms the branch under edit | Omit | Not on the connection contract; the Issues panel states it where the work happens |
| P7 | Folder glyph before the name | decorative | 1 | Scans the item as a repository rather than a word | Keep | Aids scanning at 11px; carries no meaning alone |

Resolution notes:

- The project name wins over the full path inline: the sidebar is the source of truth for the path,
  and the footer keeps the recognizable segment.
- No value is derived from another displayed value; the name is the source segment, not a summary.

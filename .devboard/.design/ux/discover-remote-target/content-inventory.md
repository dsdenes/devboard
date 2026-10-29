# Discover remote target — content inventory

| Region | Text | Source | Notes |
|---|---|---|---|
| Header | `Manual testing target` | literal | unchanged |
| Header meta | `<n> retained` | `discover.retained.length` | only while projects exist |
| Toolbar label | `Retained project` | literal | label for the dropdown |
| Toolbar select | retained URLs, newest first | `discover.retained[].url` | host target leaves no option selected |
| Row URL | the project URL | `project.url` | mono-small, one line, full URL in the tooltip |
| Row badge | `Active` | `project.url === discover.remoteTarget?.url` | accent tone; no badge on other rows |
| Row action | `Remove` | literal | `data-url` carries the URL |
| Add label | `Discover another repository` | literal | new visible label; the input keeps its `aria-label` |
| Input placeholder | `https://github.com/owner/repo` | literal | unchanged |
| Input accessible name | `GitHub repository URL` | literal | unchanged |
| Add action | `Discover from URL` | literal | outline; disabled title names the reason |
| Cloning line | `Cloning <url>…` | `discover.cloning.url` | only while cloning |
| Footer action | `Clear remote target` | literal | only while the target is remote |

No number, count, or state word is repeated for decoration. The count is the only number in the
panel, and the `Active` word appears exactly once, on the current target's row.

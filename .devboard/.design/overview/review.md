# Render review — Discover Overview

Verified against the source server on the fixture host (`.devboard/.tmp/overview-host`, copied
`vitest-turbo` artifacts, fingerprint matched so staleness is a controlled state), 1280×900 and
1024×720, dark theme unless noted. Captures in `shots/` (ignored).

## Round 1

| id | where | observation | expected | severity | verdict |
|---|---|---|---|---|---|
| F1 | `[data-field="testing"]` chart | `PyramidChart` filled the 550px panel; 16px labels and 220px height made the chart the loudest element | compact 200×132 chart with 9.5px labels beside the totals | major | resolved — `render-1280.png` |
| F2 | `[data-testid="discover-command-list"]` | hint was appended inside the mono command (`$ node --test … — Runs the whole test suite.`), reading as part of the command | command alone; the try-out caveat as a separate note | major | resolved — `render-1280.png` |
| F3 | commands and architecture tables | `Try it out` wrapped to two lines; context names hyphenated mid-word | one-line task and context cells at fixed widths | minor | resolved — `render-1280.png` |
| F4 | `[data-testid="discover-unknowns"]` | section column used long schema labels (`Main commands`, `Entry points & dependency map`) | short names matching the page sections | minor | resolved — `render-1280.png` |

Round 1 also proved the structure itself: 11 cards, two raised panels, four flat zones, no inner
scrollers, no horizontal page overflow.

## Round 2

| id | where | observation | expected | severity | verdict |
|---|---|---|---|---|---|
| F5 | testing level table | `verification/project` was clipped at the panel edge; the path column had 127px | full path visible | major | resolved — `render-1280.png` shows both lines, `scrollWidth === clientWidth` |
| F6 | compact pyramid apex | label `Contract · count unknown` overflowed the 68px apex band | label fits the band | minor | resolved — `render-1280.png` shows `Contract` / `Unit` only |

Fixes: the chart moved beside the totals with the table full width below it; path cells wrap on spaces
with `overflow-wrap: anywhere`; compact labels omit counts, which the table carries.

No unresolved or regressed findings. No finding was reopened without a fresh capture.

## Round 3 — operator feedback on the published surface

The operator reviewed the running page and filed one finding per element. Every finding is resolved in
this revision; the issue numbers are the tracker records.

| id | where | observation | expected | severity | verdict |
|---|---|---|---|---|---|
| F7 (#149) | glossary table | Kind was the last column | Kind reads first | minor | resolved — Kind, Term, Definition |
| F8 (#150) | glossary tables | the definition column started at a different x per context card | one term width on every card | minor | resolved — `DataTable` `columnWidths` |
| F9 (#151) | glossary table | the Term/Definition header row explained nothing | no header row | minor | resolved — `hideHeader` |
| F10 (#152) | glossary card | only three of five terms were visible | every row shown; the card grows | major | resolved — flex children no longer shrink |
| F11 (#147) | overview | Entry points and dependencies repeated the Stack band | remove the section | minor | resolved |
| F12 (#148) | overview | the Not observed ledger listed unavailable facts | remove the section | minor | resolved |
| F13 (#138, #141, #142) | header and every card | confidence labels and evidence paths were noise | remove them from the page | minor | resolved |
| F14 (#139) | commands | the Task/Command header row carried no information | no header row | minor | resolved |
| F15 (#140, #145) | commands, testing, architecture | static notes and the dependency-direction lead were noise | remove them | minor | resolved |
| F16 (#143) | fact lists | values were joined by a middle dot | comma-separated | minor | resolved |
| F17 (#146) | architecture table | the first column said `Context` | say `Bounded context` | minor | resolved |
| F18 (#144) | Stack chips | a library could not be opened for review | link to the package repository | minor | resolved — installed manifest repository, no guessed URL |
| F19 (#136, #137) | masthead | `dirty` badge and the word `Discovered` were noise | date only | minor | resolved |
| F20 (#134, #135) | sidebar | `Sections` heading and the mode name did not identify the repository | repository name, no heading | minor | resolved |

## Objective checks

| Check | Result |
|---|---|
| Body contrast | 16.02:1 (`#e6edf3` on `#0d1117`) |
| Muted text | 6.15:1 on canvas, 5.62:1 on surface |
| Primary button | 4.63:1 (`#ffffff` on `#1f6feb`) |
| Focus | keyboard Tab to `discover-start`: 2px solid `#58a6ff`, 1px offset, ring shadow `0 0 0 3px #58a6ff` |
| Keyboard | sidebar, primary action reachable; no new pointer-only controls |
| Table text | 12px (`discover-pyramid`), rows 28px and 41px (limit 120) |
| Inner scrollers | 0 across `.discover-card .panel__body`; 0 cards clip their rows |
| Horizontal overflow | none at 1280 or 1024 (`scrollWidth === clientWidth`) |
| Console errors | 0 |
| Stale state | `render-stale-header.png` after changing the host fingerprint; badge, title, and status bar |
| Empty state | `render-empty-1280.png`; start action enabled, no freshness line |
| Active state | `render-active-1280.png`; run id, Terminal, Stop, disabled Re-discover |
| Light theme | `render-light-1280.png`; badges and linked chips legible |
| Reduced motion | no new animation; global `prefers-reduced-motion` block unchanged |

## Not verified

- 390×844: the app replaces the workspace with its “viewport too small” guard below 1024×720; 1024×720
  is the narrow composition. 200% zoom is the same guard.
- RTL: the app has no RTL layout today.
- A live warning banner and the question panel: the fixture run publishes cleanly and the stub does not
  ask a question. Both markups are unchanged from the previous surface.
- A real five-level pyramid: the compact variant was checked with two levels; the geometry holds
  (`132 / 5 = 26.4px` per band, 9.5px labels), but only two levels were rendered.

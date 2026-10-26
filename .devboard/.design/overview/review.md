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

## Objective checks

| Check | Result |
|---|---|
| Body contrast | 16.02:1 (`#e6edf3` on `#0d1117`) |
| Muted text | 6.15:1 on canvas, 5.62:1 on surface |
| Confidence text | observed 6.81:1, declared 6.85:1, inferred 6.85:1 on surface |
| Primary button | 4.63:1 (`#ffffff` on `#1f6feb`) |
| Focus | keyboard Tab to `discover-start`: 2px solid `#58a6ff`, 1px offset, ring shadow `0 0 0 3px #58a6ff` |
| Keyboard | sidebar, primary action reachable; no new pointer-only controls |
| Table text | 12px (`discover-pyramid`), rows 28px and 41px (limit 120) |
| Inner scrollers | 0 across `.discover-card .panel__body` |
| Horizontal overflow | none at 1280 or 1024 (`scrollWidth === clientWidth`) |
| Console errors | 0 |
| Stale state | `render-stale-header.png` after changing the host fingerprint; badge, title, and status bar |
| Empty state | `render-empty-1280.png`; start action enabled, no freshness line |
| Active state | `render-active-1280.png`; run id, Terminal, Stop, disabled Re-discover |
| Light theme | `render-light-1280.png`; all provenance and badges legible |
| Reduced motion | no new animation; global `prefers-reduced-motion` block unchanged |

## Not verified

- 390×844: the app replaces the workspace with its “viewport too small” guard below 1024×720; 1024×720
  is the narrow composition. 200% zoom is the same guard.
- RTL: the app has no RTL layout today.
- A live warning banner and the question panel: the fixture run publishes cleanly and the stub does not
  ask a question. Both markups are unchanged from the previous surface.
- A real five-level pyramid: the compact variant was checked with two levels; the geometry holds
  (`132 / 5 = 26.4px` per band, 9.5px labels), but only two levels were rendered.

# Activity log redesign — validation

Issue: #234, "Redesign element: `pre.issues-activity`".

## Element and current surface

The captured DOM is the Issues overview's second panel, which streams the
selected running agent. That panel and the same `pre.issues-activity.mono`
element render on six surfaces:

| Surface | Test id | Live or history |
|---|---|---|
| Issues overview · selected agent | `issues-overview-activity` | live |
| Issues · Agents card | `issues-agent-activity` | live |
| Issues · agent focus | `issues-agent-focus-activity` | live and finished |
| Issues · Auto Scout | `scout-activity` | live |
| Issues · Runs detail | `issues-run-activity` | history |
| Issues · Drafts | `issues-draft-activity` | live |

The redesign therefore changes the shared `.issues-activity` presentation and
the live renderer (`IssuesAgentLog.svelte`), not only one page.

## Problem

The log was a bare `pre` on `surface-raised` with a top rule: a wall of
monospace prose in which agent prose and shell commands looked identical, and
no terminal frame separated it from the panel around it.

## Change

- The log is now a terminal surface: `background` fill (DESIGN.md level 0,
  canvas/editors/terminals), 1px `border`, 4px `border-radius`, `mono` type at
  12px/1.45, 8px 10px padding, and `overflow-wrap: anywhere`.
- Live logs render one span per line. A line starting with `$ ` becomes a
  command row: `accent` prompt, `foreground` text, `accent-surface` chip fill,
  3px radius. Prose stays plain `foreground`.
- Line breaks remain literal text nodes, so `textContent` (and copy) keeps the
  original `\n` structure.
- Where the log is a direct child of a panel (Auto Scout) or an agent card, the
  frame is dropped to a full-bleed strip, so there is no box inside a box.
- Auto Scout now reuses `IssuesAgentLog` instead of carrying a second copy of
  the follow-scroll logic.
- No token, primitive, Storybook story, or OpenUI entry changed; the redesign
  composes existing DESIGN.md tokens only.

## Evidence

| Check | Result |
|---|---|
| `bun run check` (svelte-check, 1245 files) | pass, 0 errors |
| `bun run build` | pass |
| `bun test` (536 tests, 40 files) | pass, 0 fail |
| `bun run verify:interface` | pass (issues mode, terminals, theme, accessibility, persistence) |
| `bun run verify:issues` | pass (fleet, activity, answers, cooldown, restart) |
| `bun run verify:scout` | pass (scan activity, board, attach, reload) |
| Rendered text equals `lines.join("\n")` in the browser harness | pass |
| Command rows equal the number of `$ ` lines | pass |
| Viewports 1600×900 and 1024×720 | pass, no clipping or overflow |

Screenshots (`.design/ux/issues-activity-log/screenshots/`):

- `issues-overview.png` — overview with the selected agent's output panel.
- `overview-log.png` — the captured element, close up.
- `agents-page.png` — Agents page, two live streams.
- `agent-card.png` — card with the full-bleed log strip.
- `agent-log.png` — close-up of a command row and prose.
- `agent-focus.png` — focus tab, framed output panel.
- `agent-focus-1024x720.png` — supported minimum viewport.

The throwaway snapshot harness lives under `.devboard/.tmp/visual-234` (ignored)
and is removed after the run.

## Not run

- A light-theme screenshot: the throwaway harness could not override the stored
  theme before boot (`documentElement.dataset.theme` stayed `dark`). The change
  adds no literal color; every value is an existing custom property with a
  light counterpart in `app.css`, so the interface theme check in
  `verify:interface` is the coverage.
- Below 1024×720: DESIGN.md replaces the workspace with the viewport guard, so
  there is no narrower layout to check.

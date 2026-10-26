# designmd.ai research

- Task: redesign Goal mode (implementation, ADR list and detail, goal document, skills, lanes) and
  the shared mode rail; add the shared page-header and lifecycle-stage structure.
- Tools and arguments:
  - `mcp__designmd_search_design_kits` `{"query":"dense dark developer operator console dashboard","limit":6,"sort":"trending"}` → 0 results.
  - `mcp__designmd_search_design_kits` `{"query":"navigation sidebar mode rail status pipeline timeline","limit":6,"sort":"downloads"}` → 0 results.
  - `mcp__designmd_search_design_kits` `{"query":"dark dashboard","limit":10}` → 10 kits.
  - `mcp__designmd_list_tags` `{}` → 50 tags; `devtools` 37, `dense` 9, `dashboard` 140.
  - `mcp__designmd_get_design_kit` `{"identifier":"chef/debugdeck"}` → full DESIGN.md content.
- Candidates:
  - DebugDeck — https://designmd.ai/chef/debugdeck — dense multi-panel debugging tool, severity at
    rest, 28px rows, mono for paths. Read in full.
  - MidnightOps — https://designmd.ai/chef/midnightops — pitch-dark layered elevation, functional
    blue/green/amber signals.
  - Command Center — https://designmd.ai/frknaykc/command-center — operator security workspace with
    an application shell and telemetry accents.
  - CoinPulse — https://designmd.ai/chef/coinpulse — data-density and scanning-speed rationale.
- Adopted:
  - Density is a design constraint, not a style: 28px interactive rows, 12–13px body, monospace for
    paths, identifiers, and counts. This is already the Project token set; the redesign applies it
    consistently to the Goal pages.
  - Severity and state must be visible at rest, never behind hover: the rail gains a state dot and
    the ADR table and lane rows keep their status word.
  - A shell action area belongs in the application chrome; DebugDeck's "keyboard shortcuts for all
    critical actions" supports putting the command palette entry in the rail.
  - One primary action per surface; destructive actions are visually distinct.
- Rejected:
  - DebugDeck's amber brand color, red/amber glow shadows, and "no radius on log rows". This project
    is GitHub-dark with semantic state color and no shadows beyond the tooltip/popover; adopting a
    second brand palette would break `DESIGN.md`.
  - A 4px base spacing unit and 2/4/8/12/16/20/24/32 scale. The project already pins a 2px base with
    a half-step scale (2/4/6/8/10/12/14/16/24/28) and forbids values outside it.
  - Source Code Pro and Work Sans. The interface requests no webfont; system stacks are normative.
  - Collapsible/rearrangeable panels. The shell already has one resizable sidebar; adding a second
    layout model would compete with it.
- Why: the product need is a lifecycle operator console, not a log viewer. The kits confirm the
  density and state-at-rest direction the project already holds; they do not justify new tokens.
- Effect on DESIGN.md / tokens / components:
  - No color, typography, spacing, radius, or elevation token changes. The 65 DTCG tokens stay as
    generated from `DESIGN.md`.
  - `DESIGN.md` gains two component entries: **Page header** (eyebrow, title, subtitle, meta, action
    group) and **Stage track** (five stages, current/paused state, pass and work detail).
  - `openui.json` gains `PageHeader` and `StageTrack` with the real props.
  - Storybook gains `Design System/PageHeader` and `Design System/StageTrack` CSF stories covering
    idle, running, paused, finished, long-title, and narrow-container states.
  - Rail footer actions (commands, notifications, theme) move out of the status bar; the rail is the
    application menu. No token change; the 64px rail, 28px icon buttons, and status-bar height are
    existing fixed geometry.

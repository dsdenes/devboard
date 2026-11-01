---
version: alpha
name: Devboard Harness Interface
description: Dense, dark-first operator console for repository goals, ADR records, Flow sessions, and Discover artifacts.
colors:
  background: "#0d1117"
  surface: "#161b22"
  surface-raised: "#1c2128"
  foreground: "#e6edf3"
  muted-foreground: "#8b949e"
  border: "#30363d"
  border-subtle: "#21262d"
  border-strong: "#6e7681"
  ring: "#58a6ff"
  primary: "#1f6feb"
  primary-hover: "#388bfd"
  primary-foreground: "#ffffff"
  secondary: "#21262d"
  secondary-hover: "#30363d"
  accent: "#58a6ff"
  accent-surface: "#16233a"
  destructive: "#da3633"
  destructive-foreground: "#ffffff"
  success: "#3fb950"
  success-surface: "#16251b"
  warning: "#d29922"
  warning-surface: "#2b2411"
  error: "#ff7b72"
  error-surface: "#2b1513"
  row-hover: "#1b2129"
  activity-bar: "#0a0d12"
  selection-background: "#264f78"
  flow-contract: "#58a6ff"
  flow-contract-surface: "#16233a"
  flow-entity: "#bc8cff"
  flow-entity-surface: "#241a33"
  flow-naming: "#3fb950"
  flow-naming-surface: "#16251b"
  flow-data: "#e3b341"
  flow-data-surface: "#2b2411"
  flow-dependency: "#6cb6c8"
  flow-dependency-surface: "#13292c"
  flow-irreversible: "#ff7b72"
  flow-irreversible-surface: "#2b1513"
  flow-structure: "#9aa4ae"
  flow-structure-surface: "#22272c"
typography:
  page-title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 20px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: -0.01em
  section-title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 18px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: 0
  panel-title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  body-small:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  control:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0
  control-small:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.03em
  overline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.08em
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  mono-small:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
spacing:
  hairline: 2px
  tight: 4px
  snug: 6px
  base: 8px
  relaxed: 10px
  loose: 12px
  wide: 14px
  wider: 16px
  section: 24px
  section-xl: 28px
rounded:
  sm: 3px
  md: 4px
  lg: 6px
  full: 999px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 10px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 10px
  button-secondary-hover:
    backgroundColor: "{colors.secondary-hover}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 10px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 10px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 10px
  button-link:
    backgroundColor: transparent
    textColor: "{colors.accent}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
  icon-button:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    size: 28px
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 8px
  badge:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.overline}"
    rounded: "{rounded.full}"
    padding: 2px 6px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 8px
  page-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  stage-track:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: 4px 6px
---

# Devboard Harness Interface

## Overview

Devboard is the local browser interface for one repository's goal, ADR records, Flow
implementation session, Discover artifacts, and the read-only MCP tool catalog. It is a desktop
operator console: one full-viewport shell with a labeled mode rail, a contextual sidebar, one
workspace, and a status bar. Every mode is a client-side view over the WebSocket contract owned
by the server.

The visual intent is GitHub-dark material: flat surfaces, hairline borders, high information
density, and no decorative weight. Depth comes from surface steps and borders, not shadows. Color
carries semantic state, never decoration. Type is compact; monospace marks paths, identifiers,
counts, and commands.

These tokens are derived from the running interface and from the shipped stylesheet
`.devboard/client/app.css`, with the measured snapshot in
`.devboard/.design/overview/design-system.md` as corroborating evidence. No token value was
invented for this document.

## Design principles

1. **Tokens are the only color source.** Role colors are declared once in `app.css`; component
   styles read them through `var(--token)`, so a role changes in one place.
2. **Depth is layering and hairlines.** `background` → `surface` → `surface-raised` plus 1px
   borders express hierarchy; the tooltip/popover `shadow-md` is the only shadow.
3. **One primary per surface.** `primary` is the single filled action, `accent` marks links,
   selection, and current position, and `ring` is focus only.
4. **State is a word.** Every badge, dot, and state line pairs its color with text that states
   the meaning, so the state survives grayscale and color blindness.
5. **Type stays on the scale.** System stacks only; `overline` for uppercase micro-labels and
   monospace for paths, identifiers, counts, and commands; no new size between steps.
6. **Spacing is a grid with named exceptions.** Use the approved scale; component geometry and
   the documented dense table and status padding are named, never improvised.
7. **Functional shapes stay small.** Radius tops out at 6px on functional surfaces; circles are
   reserved for status dots and avatars.

## UX principles

1. **Every mode is visible.** The rail names every mode; navigation never depends on hover, a
   hidden menu, or a keyboard shortcut.
2. **One surface, one job.** The page header owns identity and actions, a panel owns its content,
   and status appears in the region that owns the action instead of being repeated.
3. **The control sits with its state.** A Save sits with the draft it saves, a Stop with the run
   it stops, and a state word with the control it qualifies.
4. **Destructive actions name their cost.** The control names what it deletes and confirms
   before deleting; no destructive action fires on hover or a stray click.
5. **Feedback is immediate and local.** Saves, filings, and failures report beside the control
   that caused them; a transient notice clears itself and keeps its history entry.
6. **Keyboard parity.** Every mode and primary command is reachable from the command palette,
   and focus is always a 2px `ring`.
7. **Density stays scannable.** Prose at 12–13px, tabular mono for counts, one state word per
   badge, and ellipsis with a full-value tooltip instead of wrapping dense rows.

## Colors

Dark is the default and normative theme (`:root` in `app.css`). Light is a mirrored palette
selected by `data-theme="light"`; it carries the same roles with its own values and is never mixed
with the dark set.

| Token | Dark (normative) | Light | Role |
|---|---|---|---|
| `background` | `#0d1117` | `#ffffff` | App canvas, code and terminal surfaces |
| `surface` | `#161b22` | `#f6f8fa` | Panels, sidebar |
| `surface-raised` | `#1c2128` | `#ffffff` | Sub-headers, tooltips, popovers |
| `foreground` | `#e6edf3` | `#1f2328` | Body text and headings |
| `muted-foreground` | `#8b949e` | `#57606a` | Labels, meta, secondary text |
| `border` | `#30363d` | `#d0d7de` | Panel and section borders |
| `border-subtle` | `#21262d` | `#eaeef2` | Row rules |
| `border-strong` | `#6e7681` | `#6e7781` | Control outlines, badges |
| `ring` | `#58a6ff` | `#0969da` | Focus outline |
| `primary` | `#1f6feb` | `#0969da` | Filled primary action |
| `primary-hover` | `#388bfd` | `#0550ae` | Primary hover |
| `primary-foreground` | `#ffffff` | `#ffffff` | Text on primary |
| `secondary` | `#21262d` | `#f6f8fa` | Secondary button and hover fill |
| `secondary-hover` | `#30363d` | `#eaeef2` | Secondary hover |
| `accent` | `#58a6ff` | `#0969da` | Links, active indicators |
| `accent-surface` | `#16233a` | `#eef4ff` | Selected row tint |
| `destructive` | `#da3633` | `#cf222e` | Destructive action |
| `destructive-foreground` | `#ffffff` | `#ffffff` | Text on destructive |
| `success` | `#3fb950` | `#1a7f37` | Pass, accepted, ready |
| `success-surface` | `#16251b` | `#f0f7f2` | Success tint |
| `warning` | `#d29922` | `#9a6700` | Pending, stale, dirty |
| `warning-surface` | `#2b2411` | `#fff8e5` | Warning tint |
| `error` | `#ff7b72` | `#cf222e` | Failure text |
| `error-surface` | `#2b1513` | `#fdf2f1` | Failure tint |
| `row-hover` | `#1b2129` | `#f6f8fa` | Table row hover |
| `activity-bar` | `#0a0d12` | `#f6f8fa` | Mode rail background |
| `selection-background` | `#264f78` | `#b6d7ff` | Text selection |

The `flow-*` tokens are the Flow diagram categories. Each has a border color and a surface tint:
`flow-contract` (blue), `flow-entity` (violet), `flow-naming` (green), `flow-data` (amber),
`flow-dependency` (teal), `flow-irreversible` (red), and `flow-structure` (gray). Their values are
listed in the front matter for both themes in `app.css`; the dark values are normative here.

Rules:

- `primary` is a fill for exactly one primary action per surface. It is never body text.
- `accent` is the link and active-indicator color; `ring` is focus only.
- A tinted surface (`*-surface`) always pairs with its own foreground token, never with a
  different state color.
- Status color never carries meaning alone: badges and labels always include the word.

Known deviation, kept because it is the shipped value: white text on `primary-hover`
(`#388bfd`) measures 3.34:1, while white on resting `primary` (`#1f6feb`) measures 4.63:1 and meets
WCAG AA. `primary-hover` exists only as a transient hover fill; repairing it would change the
product's interaction color, so the contrast review for that state belongs to the later page run,
not to this token derivation.

## Typography

System stacks only; the interface requests no webfont.

- **Sans** — `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`,
  sans-serif. All prose, labels, and controls.
- **Mono** — `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono"`,
  monospace. Paths, file names, identifiers, commands, counts, and table cells that hold them.

| Token | Size / weight | Tracking / line height | Use |
|---|---|---|---|
| `page-title` | 20px / 650 | -0.01em / 1.2 | Discover and workspace page titles |
| `section-title` | 18px / 650 | 0 / 1.2 | Detail-surface titles |
| `panel-title` | 12px / 600 | 0 / 1.3 | Panel headers |
| `body` | 13px / 400 | 0 / 1.45 | Default prose and form text |
| `body-small` | 12px / 400 | 0 / 1.45 | Subtitles, table cells, descriptions |
| `control` | 12px / 500 | 0 / 1.3 | Buttons, inputs |
| `control-small` | 11px / 500 | 0 / 1.3 | `sm` buttons, per-row Start and Close actions |
| `label` | 11px / 600 | 0.03em / 1.3 | Table heads, metadata rows |
| `overline` | 10px / 700 | 0.08em / 1.2 | Sidebar group heads, badges, uppercase micro-labels |
| `mono` | 12px / 400 | 0 / 1.45 | Code, paths, terminal text |
| `mono-small` | 11.5px / 400 | 0 / 1.4 | Dense table identifiers and counts |

Do not introduce a size between scale steps. Uppercase micro-labels use `overline`, and table heads
use `label`; never apply tracking to sentence-case prose.

## Layout

Spacing uses a **2px base unit** with a half-step grid. The approved scale is 2, 4, 6, 8, 10, 12,
14, 16, 24, and 28px; values outside it are forbidden.

- **Rhythm.** 8px is the default macro rhythm: panel body padding, the default flex gap, and the
  gap between stacked panels. 12px is the card-grid gap. 24–28px separates page-level sections.
- **Component padding.** Buttons `0 10px` (`sm` buttons `0 8px`), inputs `0 8px`, panel bodies
  8px, panel headers 8px horizontal, table cells `5px 8px`,
  badges `2px 6px`, icon buttons a 28px square.
- **Layout gaps.** 2px between an icon and its inline text at micro sizes, 4px between an icon and
  a control label, 6px between header actions, 8px is the default, 12px between cards and grid
  items, 16px between Discover sheet rows, and 24px between Discover sheet columns.
- **Section spacing.** 12px between stacked Discover cards, 24px between Discover page sections.
- **Containers and gutters.** The shell fills the viewport: mode rail 72px, sidebar 300px
  default (resizable 200–600px), workspace flexible, status bar 26px, content padding 8px. There
  is no centered page container and no horizontal gutter; panels use their own 1px borders.
  Inside the rail each mode tab is a 64×52px control with an 18px icon over a 10px `overline`
  label, inset 6px vertically and 4px horizontally so the label never touches the tab edge; the
  label never collapses to an icon-only state.
- **Responsive spacing.** The supported viewport is at least 1024×720. Panes resize rather than
  reflow; when a pane narrows, gaps collapse to the next lower scale step before text wraps.
  Below 1024×720 the workspace is replaced by the viewport guard, so no mobile spacing scale
  exists.
- **Scroll.** The document never scrolls; panels and tables own their scrolling.

Mapping to tokens: `{spacing.hairline}` 2px, `{spacing.tight}` 4px, `{spacing.snug}` 6px,
`{spacing.base}` 8px, `{spacing.relaxed}` 10px, `{spacing.loose}` 12px, `{spacing.wide}` 14px,
`{spacing.wider}` 16px, `{spacing.section}` 24px, `{spacing.section-xl}` 28px.

Documented exceptions outside the scale: Flow diagram grid gaps of 18px and 22px and the diagram's
`14px 32px` column gap are geometry of an inline SVG map, not layout spacing. The 26px, 30px,
34px, and 44px region heights and the 72px rail are fixed shell dimensions. The 56px bottom
padding on a Discover page reserves the fixed notification region (34px above the 26px status
bar) so a page's last control can scroll clear of it; the same 56px on the Goal workspace's
scrolling pages clears that region. The 180px Discover activity terminal, the
104px fact-label column, the 160px Discover boundary-role column, the 200–600px sidebar bounds,
the 160px split minimum, and the dependency canvas `clamp(220px, 40vh, 400px)` height cap are
component geometry, not spacing steps. The 5px vertical padding of table cells, the 5px 10px
cycle-history row padding, and the 5px horizontal padding of status-bar items are documented
component padding for dense rows, not layout steps.

## Elevation & Depth

Depth is color layering plus 1px borders, not shadow:

- level 0 `background` — canvas, editors, terminals;
- level 1 `surface` — panels and sidebar;
- level 2 `surface-raised` — panel sub-headers, tooltips, popovers;
- borders: `border-subtle` for row rules, `border` for panel and section edges, `border-strong`
  for control outlines and badges.

The only shadow in the interface is the tooltip/popover `shadow-md`; it exists to lift transient
content above a panel and is not a general elevation system. Do not add shadows, gradients, or
backdrop blur to panels, cards, or rows.

## Shapes

- 3px (`sm`) — small badges, inline code, tabs and compact controls.
- 4px (`md`) — buttons, inputs, panels, table containers, the default for functional UI.
- 6px (`lg`) — chips and popovers.
- 999px (`full`) — status pills and badges.

Functional surfaces never exceed 6px. Circles are reserved for status dots and avatars.

## Components

The shipped primitives live in `.devboard/client/lib/components/ui/`: `button.svelte`,
`icon-button.svelte`, and `input.svelte`. All consume `app.css` custom properties through
`var(--token)`; they hold no literal colors.

- **Button** — 28px tall, 4px radius, `control` type. Variants `default` (filled `primary`),
  `secondary` (default), `outline`, `ghost`, `destructive`, `link`; sizes `default` (28px),
  `sm` (24px, 11px type), `icon` (28px square). Disabled is 45% opacity and non-interactive.
  Focus is a 2px `ring` ring with a 1px offset.
- **IconButton** — square ghost icon button built from the `Button` variant table, 28px, requires
  an accessible `label`; `active` renders the `secondary-hover` fill and `aria-pressed="true"`.
  Its tooltip uses `surface-raised`, `control`-sized text, and the `lg` radius.
- **Input** — 28px tall, `background` fill, `border-strong` outline, 4px radius, `control` type
  at 12px, `muted-foreground` placeholder, `ring` focus ring. Disabled is 50% opacity.
- **Panel** (`.panel` in `app.css`) — `surface` fill, 1px `border`, 4px radius, 30px header,
  8px body padding; the table container and the sidebar reuse the same surface and border rule.
- **Page header** (`page-header.svelte`) — the first region of every workspace page: an optional
  10px `overline` eyebrow, one 20px `page-title` `h1` (truncates with a tooltip, never wraps), an
  optional 12px `body-small` subtitle, an optional meta row of badges and counts (4px rows, 12px
  columns), and a right-aligned action group (6px gaps, one filled primary at most). It renders a
  native `<header>`; `flat` drops the frame when a parent panel owns it. 10px 12px padding. The
  `bar` layout is the operational variant: the eyebrow sits over one title/subtitle line and the
  meta row moves into a right-aligned cluster beside the action group, so the state and the action
  it qualifies share a 44px row with 8px 12px padding. A 300px identity floor is the page-name
  guard: below it the meta/action cluster wraps under the identity instead of truncating the
  title, and the subtitle ellipsizes. The stacked layout stays the default. An optional `footer`
  snippet adds a full-width secondary band under a `border-subtle` hairline (6px 12px padding)
  for controls that configure the primary action; it renders inside the header surface, its
  groups wrap as units, and it never holds the filled primary.
- **Agent settings footer** (`.agent-settings` in `AgentPage.svelte`) — the header footer shared
  by Auto Scout and Watchdog: two `overline` groups 24px apart, each with 10px column and 6px row
  gaps. `Cadence` holds the Every field (64px, centered, 4px from its label and the `min` unit),
  the last-run and next-run clocks in mono tabular figures, and a secondary `Save cadence`.
  `Filing limits` holds the Per hour and Open issues fields (80px, so the `unlimited` placeholder
  is never clipped) with `unlimited` placeholders and a secondary `Save limits`. Both groups wrap
  as units, so a field never separates from its save control, and the filled Start/Stop stays
  alone in the header row above.
- **Stage track** (`stage-track.svelte`) — five equal-width stage cells (Goal, Epics, ADRs,
  Implementation, Finished) at 11px/600, 4px gaps, 3px radius, `border-subtle` for future stages,
  `border` for complete stages, and `accent-surface` plus a 1px `accent` edge for the current
  stage (`aria-current="step"`). Below it a 11px detail row states the pass, one state word
  (Not started, Running, Paused, Finished, Manual run), and the current work item. It never
  infers progress: `seen=false` keeps Goal current.
- **Badge** (`.badge`) — full-radius outline pill, `overline` type, 2px 6px padding; tone comes
  from the matching state token and the text always states the meaning. A decision record's
  header carries one status badge, colored by meaning: `accepted` success, `proposed` pending,
  `superseded`/`deprecated` stale, `rejected` error; the implementation state is never repeated
  as a second resolved/pending badge.
- **Decision record start control** (`.adr-action` in `AdrTable.svelte`) — the only per-row action
  on the Decision records table: the shipped `Button` at `sm` size (24px tall, 11px/500 type, 4px
  radius) centered in the 28px row. The record marked `Next` takes the filled `default` variant
  and every other pending record an `outline` variant, so the surface carries exactly one filled
  primary and the lifecycle order is visible in the column. Each control is labelled `Start` and
  names its record in the accessible name; it is disabled at 45% opacity while goal creation,
  revision, skills preparation, or a manual run owns the workspace. A resolved row leaves the
  cell empty instead of repeating the Implementation column's state word.
- **Inline code chip** (`.code-chip`) — one presentation for every command, path, package, and
  boundary value: `mono-small` type, `background` fill, 1px `border-subtle` outline, 3px radius,
  2px 6px padding. A runnable command carries a `$` prompt; a path does not. No surface may draw
  a second inline-code style.
- **Running agent row** (`.issues-agent-row`) — one button row in the Issues overview's running
  agent list: a 44px mono issue-number column, the issue title on one line with ellipsis and the
  full title as its tooltip, and a right-aligned meta group. The meta group carries the elapsed run
  time in `mono-small`, tabular, `muted-foreground` with the start clock in its tooltip, and a
  `needs answer` warning badge only while the agent is waiting on a question. Rows are 28px tall
  with 6px 10px padding, separated by a `border-subtle` rule; hover takes `row-hover`, and the
  selected row takes `accent-surface` with a 2px `accent` left edge and an `accent` issue number,
  matching `aria-current="true"`. The per-row state word is omitted because the panel is the
  running list, so color never repeats the header.
- **Running agent close control** (`.issues-agent-row__close`) — the quiet destructive control
  beside a running-agent row: 24px tall, 11px text word `Close`, transparent fill, a
  `border-subtle` outline, 4px radius, `muted-foreground` until its row is pointed at. Its own
  hover or focus takes `error-surface`, `error` text, and an `error` outline; a hovered row raises
  the outline to `border` and the word to `foreground`; disabled is 45% opacity. It is a word at
  every supported width, never an icon, and it closes the tracker issue as `not planned` without
  stopping the running agent. The panel header carries one aggregate warning badge,
  `<n> need answers`, only while an agent waits; the fleet size is not repeated there because the
  Automation panel owns it.
- **Issue queue row** (`.issues-queue__item`) — one row of the Issues mode Queue page: a 29px
  grid with three fixed tracks — a 44px mono, tabular `#<n>` tracker link in `muted-foreground`
  that takes `foreground` and an underline on hover or focus; the issue title on one line with
  ellipsis and the full text as its tooltip; and a trailing non-wrapping meta group with a 6px
  gap. The meta group holds the optional `goal` accent badge and exactly one lifecycle badge
  (`pending` pending tone, `running` accent, `handled` success), so a goal issue that is running
  keeps both badges on the title's line instead of wrapping into a second row. Rows use 6px 10px
  padding, a `border-subtle` rule, and `row-hover` on hover; the state badge always ends on the
  row's trailing edge, and the title is the only track that yields at 1024px.
- **Proposed goal row** (`.issues-draft-row`) — one row of the Draft goals list: a full-row open
  control with a two-line identity column and a trailing status badge, plus a right-aligned `sm`
  outline `Start` control. The first line is the draft file name in 12px mono with its path as the
  tooltip; the second is the proposal heading in 12px `muted-foreground`, one line with ellipsis
  and the full heading as its tooltip. A 6px meta group ends before the action gap: while the
  elaboration waits for an answer it carries a `warning` `answer` badge, and the trailing badge
  always states this draft's run (`idle`, `running`, `succeeded`, `failed`, `stopped`) in words.
  Rows use 6px 10px padding and a `border-subtle` rule; hover takes `row-hover` across the whole
  row, and the current row takes `accent-surface`, a 2px `accent` left edge, and an `accent` file
  name. The open control takes an inset 2px `ring` on `focus-visible`. The row's `Start` is always
  visible, never revealed only on hover, names its draft in its accessible name, names a blocker
  as its tooltip, and is disabled at 45% opacity while that draft runs. The `New goal` form is a
  `surface-raised` band under the panel header with `label` type, an 8px rhythm, and a
  right-aligned 6px action gap.
- **Draft goals header** (`.issues-drafts-page .panel__header`) — the Draft goals page states
  repository identity, workspace status, and draft count once, in the page header's `mono-small`
  identity line (`<owner>/<repo> · idle · 0 draft(s)`); the Proposed goals panel header carries
  only its `panel-title` word and the creation action, with no second copy of the repository.
  `New goal` is that panel's single filled primary at `sm` size; while the creation band is open
  it drops to `secondary` so the band's `Create draft` owns the primary. The trigger keeps
  `aria-expanded` and names the open band through `aria-controls`; the band is a
  `surface-raised` row under the header with `label` type and a right-aligned 6px action gap.
- **Draft goals body** (`.issues-drafts__body`) — the two-panel surface under the page header:
  the Proposed goals panel at a 240–340px track and the detail panel on the remaining track, 12px
  apart, both filling the body height; below 1100px the tracks stack into one column. When the
  directory holds no drafts the body drops to one full-width Proposed goals panel and renders no
  detail column: its body centers a 20px `muted-foreground` `NotebookPen` mark (`aria-hidden`),
  a 13px/600 `No drafts yet` title, and one 12px `muted-foreground` line naming `New goal` and
  report proposals, in one 360px-capped stack with 24px 16px padding and a 4px rhythm. With
  drafts but no selected row the detail column carries the same stack (`MousePointerClick`,
  `No draft selected`, one line naming Proposed goals), so an unselected surface never reads as
  an empty panel. Neither state adds a frame, tint, shadow, or second action; the panel header
  keeps the only `New goal` control.
- **Agent fleet card** (`.issues-agent`) — one card per running agent in the Agents page grid: a
  360px-minimum `surface` card with 1px `border`, 4px radius, 10px padding, and an 8px internal
  rhythm. Its head holds the mono `accent` issue-number link to the tracker and one outline
  `Focus` control, both on a 28px line. The title reserves exactly two lines at 13px/600 so the
  meta row aligns across a row of cards. The meta row carries the elapsed time and the absolute
  start clock in `mono-small`, muted, tabular figures. A labeled `Latest activity` `overline`
  sits above the shared `.issues-activity` block, which follows the newest line and fills the
  remaining card body, except on a waiting card where it stays a 64px block. A card waiting on a
  question takes a `warning` border, and its question block takes a 2px `warning` left edge on
  `warning-surface`; it carries no `running` or `needs answer` pill because the page header counts
  the fleet and the question text names the state. Grid rows stretch and the activity absorbs the
  slack, so cards in one row share a height.
- **Filed issues empty state** (`.scout-issues__empty`) — the Auto Scout results panel with no
  rows: one compact stack centered in the available panel area, never a full-width strip. A 20px
  `muted-foreground` Lucide inbox mark (`aria-hidden`) sits above a 13px/600 `No issues filed yet`
  and one 12px `muted-foreground` line stating that Auto Scout files significant findings after
  each scan. The stack is capped at 360px, uses 24px 16px padding and a 4px rhythm, and adds no
  frame, fill, shadow, or action; the page header keeps the only Start/Stop control and the panel
  header keeps the count.
- **Watchdog page** (`.watchdog-page`, `.watchdog-body`) — the Issues mode's watchdog surface: a
  framed page header with the `Watchdog` title, its one-sentence purpose, and the GitHub read
  badge with the mono last-read time (no mode eyebrow — the rail and sidebar already name it).
  The body is two columns while the page container is wider than 1300px and one column below
  that. The primary column stacks the newest-cycle panel over the filed-issues panel; the
  cycle-history panel is the 0.9fr aside with a 340px floor. The newest-cycle panel puts the
  action badge and the cycle age in its header, then a three-cell stat rail (Started, Findings,
  Pending filings) with `border-subtle` dividers, a 10px/700 `overline` label over a 12px mono
  value, and one
  12px reason line under a `border-subtle` rule; a pending count above zero takes `warning` text
  while keeping its word. The filed-issues table is fixed-layout at 12px with a sticky 11px/600
  `label` header on `surface`, 110/132/86/76px category, filed, state, and version tracks, 27px
  rows on 5px 8px cells, `border-subtle` row rules, and one-line ellipsis for the title and mono
  cells; hover tints the row with `row-hover`, and the title link is `foreground` with no
  underline until hover. The cycle-history list uses 118px, 86px, and flexible tracks per 27px
  row on 5px 10px padding, with the time in 11.5px mono tabular `muted-foreground`, the action as
  the shared outline badge, and `#<n>` links in 11.5px mono `accent`, 6px apart; the list has no
  header and no row hover because only its links are controls. In the two-column layout both
  panels fill the height under the header and their bodies own the scroll; in the stacked layout
  the page scrolls and each body caps itself (`clamp(240px, 48vh, 520px)` for the table,
  `clamp(280px, 58vh, 580px)` for history). Their empty states are one 12px muted padded line.
  When the primary column is narrower than 900px the table drops its category, filed, and
  version columns so the issue title keeps enough width to identify the finding; the title still
  carries the category.
- **Mode rail** (`.activity-bar`) — the shared application menu: 72px vertical rail, `activity-bar`
  fill, 1px `border` on its right edge. The five `role="tab"` controls — Goal, Issues, Flow,
  Discover, and Devboard — sit in a `role="tablist"` group, each 64×52px with 6px vertical and
  4px horizontal padding: an 18px icon over a 10px `overline` label, 4px apart. Resting color is
  `muted-foreground`; hover and the selected tab use `secondary`, a `border-strong` outline, and
  `foreground` text; the selected tab carries a 2px `accent` bar on its left edge, outside the tab
  box. A 6px state dot (accent running, warning attention/stale, `border-strong` idle) sits at the
  tab's top-right with no text; the mode's state word joins its accessible name. The Devboard tab
  opens the read-only MCP tool catalog page and carries no state dot. Below a 1px divider at the
  rail's bottom, six 28px ghost icon buttons are the application actions: commands (`Ctrl+K`),
  notifications, theme, and the three UI-issue actions — `Report UI issue`, `Remove element`,
  `Redesign element` — each active (`aria-pressed="true"`, `secondary-hover` fill) while its
  selection mode is armed, and disabled while a filing runs or the report panel owns the
  selection. The rail never shows a brand label and never collapses to icons only.
- **Issue result line** (`.feedback-result` in `FeedbackOverlay.svelte`) — a fixed
  `surface-raised` line 40px above the status bar, centered, with 1px `border-strong`, 4px radius,
  6px 8px padding, 12px text, and, when the request produced one, the issue URL as an `accent`
  link; `role="status"` on success and `role="alert"` with `error` text on failure. A proposed
  goal's `Goal proposed: .devboard/goal-proposals/<file>.md` result carries no link. It clears the
  notification region, which stays in the lower-right corner.
- **Notification card** (`.notification` in `NotificationRegion.svelte`) — names its source beside
  the timestamp: the subsystem that raised it, or the exact agent label that filed. A live card
  closes itself five seconds after it arrives; its history entry keeps the same text, timestamp,
  and actions, so filing and dismissal stay available there.
- **Notification entry action** (`.notification__actions` in `NotificationRegion.svelte`) — every
  error and warning notification carries one `File issue` ghost `sm` button beside its dismiss
  icon. It files that notification's text as a UI issue through `/api/feedback` at once, without
  a panel, and carries the card as the captured context; while filing it reads `Filing…` and is
  disabled, a success replaces it with the filed issue URL as an `accent` `Open issue` link, and a
  failure adds an 11px `error` line naming the server's message. Notices and successes carry no
  filing action. The 2px action gap sits inside the existing 6px 8px card padding and adds at
  most one line to the card.
- **Status bar** (`.status-bar`) — a 26px two-group strip on `surface-raised` with a 1px `border`
  top edge. The left group states connection (7px dot plus word) and the project (folder icon plus
  the last path segment in mono), divided by a 1px `border` rule. The right group holds the lane
  count, the issues worker with a 6px state dot, the watchdog, the OS notifications control, the
  running and installed versions, and, while the installed version is newer than the running one,
  the reload control (12px refresh icon plus an 11px `reload` word); every metric pairs a 10px
  `overline` label with an 11px value, so no meaning rests on color. Items are 20px tall with 5px
  horizontal padding; a hovered control takes `secondary`.
- **OS notifications control** (`os-notifications` in `StatusBar.svelte`) — one status-bar button
  beside the watchdog whose accessible name always begins `OS notifications` and ends in `off`,
  `on`, or `blocked`, with a 6px state dot (`border-strong` off, `success` on, `error` blocked).
  Its default is off. A click with undecided permission asks the browser once; a grant turns it
  on, a denial or blocked site reads `blocked`, and a dismissed prompt leaves it off. While the
  browser grants permission, every later click toggles without a prompt, and the choice persists
  in `localStorage` under `devboard.osNotifications.v1`; blocked is never stored but read from
  `Notification.permission`. While on and granted, the page raises one informational `Notification`
  per pending agent question it observes on any surface, titled `devboard · <surface label>` with
  the question as the body, even while the document is focused and visible. Each question is
  announced once per page session; repeated snapshots, reconnects, and answers raise none, and a
  question whose run has stopped is never pending. The control adds no palette item and no
  in-app notification card.
- **Reset implementation** — the destructive action is the outline button in the Goal
  implementation header, beside `Resolve next ADR` and `Start implementation`. It arms a
  confirmation dialog that names what is deleted and confirms with the `destructive` variant; no
  permanent danger panel exists. Progress and the result render as one warning message under the
  header.
- **Flow goal header** (`.flow-goal__header`) — the lead surface's header: one 44px row
  with an 18px `section-title` word and a 10px status badge (`No goal yet` muted, `Saved`
  success, `Unsaved changes` warning, `Interview running` accent), then a right-aligned
  action group that stays on one line. The single filled primary follows the state:
  `Create flow goal` while no goal exists, `Save` while the draft is unsaved; the other
  control is outline or secondary, and a disabled Save is never the only emphasis. The
  badge always states the meaning in words.
- **Flow steering panel** (`.steering-composer`) — the panel header carries the title and an 11px
  state line (`Read at the next checkpoint` muted while empty, `N notes waiting for the next
  checkpoint` warning while any note is new, `All notes read` success otherwise). The composer is
  a full-width textarea followed by a right-aligned primary `Send` at 6px, disabled while the draft
  is blank, so the action sits with the field it acts on instead of the header bar. Notes follow
  as left-ruled rows with source, timestamp, and status words.
- **Decision board header** (`.flow-decisions__header`) — the Decision board's lead editor
  header on a 44px row: one 18px `section-title` word, a labeled status badge (`No decisions yet`
  muted, `Saved` success, `Unsaved changes` warning), and a right-aligned `Save` that is the
  filled primary only while the draft differs from the saved text and a neutral secondary control
  otherwise. The identity and action group are centered on the row, matching the Flow goal header.
- **Discover skill header** (`.discover-skill__header`) — the skill editor's chrome bar: one 44px
  `surface-raised` row with 12px horizontal padding and the panel header's `border` rule under it,
  so the path chip and the 28px controls share the band with 8px above and below and the editor
  reads as the pane below a distinct band. The relative path `<skill>/SKILL.md` takes the shared
  inline-code chip (`.code-chip`) on the leading edge, with the skill name in `foreground` and the
  file name in `muted-foreground`, so a file path draws no second presentation of its own. The
  trailing group starts with the 11px draft state as one full-radius pill on the tint of the state
  it names: `No unsaved changes` on `success-surface` with a `success` dot and word, `Unsaved
  changes` on `warning-surface` with `warning`, and `Live file missing` on `error-surface` with
  `error`. The 6px dot pairs with the word, so the word states the meaning and the tint and dot
  never carry it alone. `Save` is the filled primary only while the draft differs from the live
  text and a disabled `secondary` otherwise; it stays disabled while the live file is missing. The
  restore control is `outline` while an edit can be discarded and becomes the filled primary as
  `Recreate generated version` when the live file is missing, so the surface always has at most one
  primary and never a disabled one as its emphasis. The chip ellipsizes with a full-path `title`
  while the state and actions never shrink or wrap.
- **Discover page frame** (`.discover-page__header`) — optional `overline` eyebrow, one `h1`
  `page-title`, a `body-small` subtitle, an optional `mono-small` meta row, and a right-aligned
  action group. Drill-in pages put a ghost back control before the heading in DOM order. Page
  sections are 24px apart; cards inside a column are 12px apart. The facts rail holds its grid
  track between 320px and 420px, with 24px to the content column.
- **Discover run header** (`.discover-run__header`) — the active-run panel header: one 30px
  `surface-raised` row with a 6px `accent` state dot and `Run in progress` in `panel-title`; a
  right meta group holding the relative start time in 11px `muted-foreground` and the run
  identifier as a `.code-chip` truncated at 180px with the full value in its tooltip; and a quiet
  destructive `Stop` at the far right (24px, 11px word, transparent fill, `border-subtle`
  outline, `muted-foreground` until hover or focus takes `error-surface`, `error` text, and an
  `error` outline). The panel keeps the standard `border`; the accent dot never carries the
  state alone, and no eyebrow restates the mode the rail and page header already name.
- **Discover dependency graph** (`.discover-diagram__canvas` in `MermaidDiagram.svelte`) — the
  bounded-context map sits in a 1px `border-subtle` canvas on `background` with a 4px radius and
  8px padding; the canvas owns both scroll axes and caps at `clamp(220px, 40vh, 400px)`. One 11px
  `muted-foreground` legend states the arrow direction. Node labels stay at 12px: a graph opens
  fitted only while the fit holds a 0.9 scale, otherwise it opens at actual size and scrolls, so a
  wide graph never renders microscopic text. A graph whose fit falls below the readable floor
  carries one ghost 24px control in the bar above the canvas, labelled `Actual size` while fitted
  and `Fit width` otherwise; a graph that fits shows no control. Nodes are `surface-raised` rounded
  rectangles with a `border-strong` 1px outline; edges and arrowheads use `muted-foreground`. The
  canvas is a tab stop only while it scrolls, and its focus ring is the shared 2px `ring`.
- **Glossary filter toolbar** (`.discover-glossary-controls`) — one bounded `surface-raised`
  toolbar with 4px padding and 8px gaps: a search field up to 240px, a 26×14px switch for
  `Significant only`, a 1px `border` divider, and a 120px floor slider whose value renders in a
  `mono-small` chip. All three controls sit on one row at 1440px and wrap together when narrow.
- **Ask transcript** (`.feedback-transcript`) — an accessible `role="log"` list inside 180px of
  scroll. A developer turn aligns right with a `You` overline and an `accent-surface` bubble with
  an `accent` border; an agent turn aligns left with an `Agent` overline and a `surface-raised`
  bubble. Sending clears the composer immediately; the question is already in the transcript.
- **Prepared skills** (`.skill`) — each row is the skill disclosure button plus a 28px delete
  control that takes `error-surface` on hover and opens one confirmation dialog.

## Do's and Don'ts

- **Do** keep density: 12–13px type, 24–30px controls, 27px table rows, 8px panel padding.
- **Do** express hierarchy with `background` → `surface` → `surface-raised` and 1px borders.
- **Do** use `mono` for every path, identifier, commit, count, and command.
- **Do** give every state badge a word, not only a color.
- **Do** use `control` for buttons and inputs, and `overline` for uppercase micro-labels.
- **Do** keep every primary mode named in the rail; navigation never depends on hover.
- **Do** state a fact once per screen: a page header may repeat a mode name only when it is the
  breadcrumb, and status appears in the region that owns the action.
- **Don't** add shadows, gradients, blur, or glows; the tooltip shadow is the only exception.
- **Don't** use `primary` for large fills or for body text.
- **Don't** use radii above 6px on functional surfaces.
- **Don't** use spacing values outside the approved scale, including `18px` and `22px` in layout.
- **Don't** animate longer than 150ms; honor `prefers-reduced-motion`.
- **Don't** introduce a webfont; the interface renders with system stacks only.

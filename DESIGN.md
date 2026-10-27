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
implementation session, and Discover artifacts. It is a desktop operator console: one
full-viewport shell with a labeled mode rail, a contextual sidebar, one workspace, and a status
bar. Every mode is a client-side view over the WebSocket contract owned by the server.

The visual intent is GitHub-dark material: flat surfaces, hairline borders, high information
density, and no decorative weight. Depth comes from surface steps and borders, not shadows. Color
carries semantic state, never decoration. Type is compact; monospace marks paths, identifiers,
counts, and commands.

These tokens are derived from the running interface and from the shipped stylesheet
`.devboard/client/app.css`, with the measured snapshot in
`.devboard/.design/overview/design-system.md` as corroborating evidence. No token value was
invented for this document.

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
| `label` | 11px / 600 | 0.03em / 1.3 | Table heads, metadata rows |
| `overline` | 10px / 700 | 0.08em / 1.2 | Sidebar group heads, badges, uppercase micro-labels |
| `mono` | 12px / 400 | 0 / 1.45 | Code, paths, terminal text |
| `mono-small` | 11.5px / 400 | 0 / 1.4 | Dense table identifiers and counts |

Do not introduce a size between scale steps. Uppercase micro-labels always use `overline`; never
apply tracking to sentence-case prose.

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
and the 160px split minimum are component geometry, not spacing steps.

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
  native `<header>`; `flat` drops the frame when a parent panel owns it. 10px 12px padding.
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
- **Inline code chip** (`.code-chip`) — one presentation for every command, path, package, and
  boundary value: `mono-small` type, `background` fill, 1px `border-subtle` outline, 3px radius,
  2px 6px padding. A runnable command carries a `$` prompt; a path does not. No surface may draw
  a second inline-code style.
- **Mode rail** (`.activity-bar`) — the shared application menu: 72px vertical rail, `activity-bar`
  fill, 1px `border` on its right edge. The four `role="tab"` controls sit in a `role="tablist"`
  group, each 64×52px with 6px vertical and 4px horizontal padding: an 18px icon over a 10px
  `overline` label, 4px apart. Resting color is `muted-foreground`; hover and the selected tab use
  `secondary`, a `border-strong` outline, and `foreground` text; the selected tab carries a 2px
  `accent` bar on its left edge, outside the tab box. A 6px state dot (accent running, warning
  attention/stale, `border-strong` idle) sits at the tab's top-right with no text; the mode's
  state word joins its accessible name. Below a 1px divider at the rail's bottom, six 28px ghost
  icon buttons are the application actions: commands (`Ctrl+K`), notifications, theme, and the
  three UI-issue actions — `Report UI issue`, `Remove element`, `Redesign element` — each active
  (`aria-pressed="true"`, `secondary` fill) while its selection mode is armed, and disabled while
  a filing runs or the report panel owns the selection. The rail never shows a brand label and
  never collapses to icons only.
- **Issue result line** (`.feedback-result` in `FeedbackOverlay.svelte`) — a fixed
  `surface-raised` line 40px above the status bar, centered, with 1px `border-strong`, 4px radius,
  6px 8px padding, 12px text, and, when the request produced one, the issue URL as an `accent`
  link; `role="status"` on success and `role="alert"` with `error` text on failure. A proposed
  goal's `Goal proposed: .devboard/goal-proposals/<file>.md` result carries no link. It clears the
  notification region, which stays in the lower-right corner.
- **Status bar** (`.status-bar`) — a 26px two-group strip on `surface-raised` with a 1px `border`
  top edge. The left group states connection (7px dot plus word) and the project (folder icon plus
  the last path segment in mono), divided by a 1px `border` rule. The right group holds the lane
  count, the issues worker with a 6px state dot, the watchdog, and the running and installed
  versions; every metric pairs a 10px `overline` label with an 11px value, so no meaning rests on
  color. Items are 20px tall with 5px horizontal padding; a hovered control takes `secondary`.
- **Reset implementation** — the destructive action is the outline button in the Goal
  implementation header, beside `Resolve next ADR` and `Start implementation`. It arms a
  confirmation dialog that names what is deleted and confirms with the `destructive` variant; no
  permanent danger panel exists. Progress and the result render as one warning message under the
  header.
- **Flow goal header** (`.flow-goal__header`) — the panel title with a 11px state line (`Saved`
  success, `Unsaved changes` warning, `Interview running` accent, `No goal yet` muted), and an
  action group: the outline `(Re)create flow goal` and a primary `Save` that is disabled until the
  draft differs from the saved goal.
- **Discover page frame** (`.discover-page__header`) — optional `overline` eyebrow, one `h1`
  `page-title`, a `body-small` subtitle, an optional `mono-small` meta row, and a right-aligned
  action group. Drill-in pages put a ghost back control before the heading in DOM order. Page
  sections are 24px apart; cards inside a column are 12px apart. The facts rail holds its grid
  track between 320px and 420px, with 24px to the content column.
- **Discover run header** (`.discover-run__header`) — a tinted `accent-surface` header with an
  `accent` `overline` eyebrow and `Run in progress`, and a right action group holding the run
  identifier as a `.code-chip`, the relative start time, and the `destructive` Stop. The panel
  border takes `accent`.
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

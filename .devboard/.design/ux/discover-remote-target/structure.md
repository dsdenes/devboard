# Discover remote target — structure

## Observed defect

The body stacked five unrelated controls at the same weight. The `Retained project` dropdown and
the retained-project list repeated every URL one line apart, so the panel's longest text appeared
twice before any grouping. The list had no border, row rule, or active treatment beyond a color
step on the URL, and its `Remove` button floated at the far right of an otherwise empty line. The
add form had no visible label and held its submit control, the quiet `Clear remote target` action,
and the URL input on one wrapping line, so "return to this checkout" read as part of "add a
project". The input and the URL rows mixed 12px sans with mono identifiers, and the panel header
stated neither how many projects were retained nor any state.

## Regions and order

Top to bottom inside `section.panel.discover-remote`:

1. `region_header` — 30px `panel__header`: `Manual testing target` in `panel-title`, with an
   `<n> retained` `panel__subtitle` on the trailing edge while projects exist. P1.
2. `region_toolbar` — one 28px line pairing the `Retained project` label (11px/600) with the
   28px mono dropdown of retained URLs. P0, the active target.
3. `region_list` — a `border-subtle` bordered list, one 28px row per retained project. Each row
   holds the URL in `mono-small`, an `Active` accent badge on the current target, and the quiet
   `Remove` word on the trailing edge. The current row takes `accent-surface` with a 2px
   `accent` inset edge; other rows take `row-hover` on hover. P0.
4. `region_add` — a `surface-raised` band with a 6px rhythm: the `Discover another repository`
   label over a row holding the 28px URL input (520px cap) and the outline `Discover from URL`
   control. P0.
5. `region_cloning` — one 12px muted line naming the URL while a clone runs. P2.
6. `region_footer` — the standard `panel__footer` with `Clear remote target` on the trailing
   edge while the target is remote. P1.

The dropdown and the list are two scopes, not two copies: the dropdown changes the target, the
rows manage the retained set. The borders, labels, and the add band's raised surface keep them
apart even though both name the same URLs.

## Journey mapping

- J1: `region_toolbar` is the switch; `region_list` confirms which row became active.
- J2: `region_add` owns the input, the label, and the submit; the input's label is now visible,
  not only its `aria-label`.
- J3: every row owns its `Remove`; the word sits before the row's trailing padding, and the
  active row's own `Remove` is the way to remove the target it names.
- J4: `region_footer` isolates the return-to-host action from the add form.

## Significance mapping

- P0: toolbar, rows, add band — the three controls that change the target.
- P1: header count and footer clear — context and the return action.
- P2: cloning line — only while a clone runs.
- Dropped: the old unlabeled form line that mixed submit and clear actions.

## Primary action

Switch the active target. The dropdown is the only control that sends `switchDiscoverRemote`; the
add band's `Discover from URL` is the secondary action and stays `outline`, so the panel never
carries a filled primary.

## State coverage

- No retained projects: the toolbar and list disappear; the add band is the whole body and the
  footer is absent.
- Retained, host target: no row is active; every row takes `row-hover` on hover; no `Active`
  badge renders; the footer is absent because the target is the host.
- Retained, remote target: exactly one row takes the accent treatment and one `Active` badge; the
  dropdown selects that URL; the footer renders.
- Another project cloning or running: the dropdown keeps the selected target's option, that row
  keeps the accent treatment and its `Active` badge, and the footer keeps `Clear remote target`; the
  cloning line and the page header name the project being discovered.
- Busy or cloning: dropdown and remove controls take `remoteChangeDisabled`; the submit control's
  `title` names the reason; the cloning line names the URL.
- Long URL: one line with ellipsis and the full URL as its tooltip.
- Narrow (1024px): the toolbar wraps its label over the dropdown only if needed; the input
  shrinks to its 280px floor before the submit wraps; no horizontal document scroll.

## Responsive order

The panel holds one column at every supported width. The header count stays on the header's
trailing edge, the rows keep URL → badge → remove order, and the add band's input is the only
element that yields before the submit control wraps beneath it.

## Rationale

Grouping by scope (switch, manage, add, return) gives each control one home and removes the
duplicated reading order without changing a single wire command. A bordered list reuses the
already shipped row grammar (`border-subtle`, `row-hover`, `accent-surface`, 2px accent edge,
`.badge`), so the panel adds no component or token. Moving `Clear remote target` into the standard
`panel__footer` states the scope change with existing layout primitives instead of a new visual
idea.

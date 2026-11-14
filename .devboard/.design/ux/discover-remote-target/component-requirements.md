# Discover remote target — component requirements

Scope: `section.panel.discover-remote` inside the Discover Overview. No new Svelte component, no
token change, no OpenUI or Storybook mutation.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Panel shell | Reuse `.panel`, `.panel__header`, `.panel__body`, `.panel__footer` | none — page primitives | n/a | `remoteAvailable`; `retained.length` for the header count | `<section>` with an `aria-label` equal to the header text; the header count is plain text | `surface`, `border`, `foreground`, `muted-foreground` |
| Retained toolbar | Page CSS (`.discover-remote__toolbar`) | none — layout class | n/a | 0–n retained URLs; active target | Native `<label for>` plus `<select>`; the visible label names the select | 8px rhythm, `label` type |
| Target dropdown | Reuse native `<select>` with page CSS | none — no shipped select component | n/a | Options newest first; host target means no selected option; `remoteChangeDisabled` | Native select; global focus ring; `title` names the disabled reason | `background`, `border-strong`, `foreground`, mono-small |
| Retained row | Page CSS on `ul`/`li` (`.discover-remote__list`, `.discover-remote__item`) | none — list row, not a catalog component | n/a | One row per project; active URL; disabled remove | Native list; the `Active` badge states the state in words | `border-subtle`, `row-hover`, `accent-surface`, `accent` |
| Active badge | Reuse `.badge` with `data-tone="accent"` | none — shipped page primitive | n/a | Active target only | Badge text carries the meaning | existing badge tones only |
| Remove control | Reuse `Button` ghost `sm` with page CSS (`.discover-remote__remove`) | none — `Button` already shipped | n/a | URL in `data-url`; `remoteChangeDisabled` | Accessible name `Remove`; focus ring from the primitive; hover/focus takes the quiet destructive treatment | `muted-foreground`, `error`, `error-surface` |
| Add band | Page CSS (`.discover-remote__form`, `.discover-remote__form-row`) on `surface-raised` | none | n/a | Draft URL; `remoteStartDisabled`; submit title names the reason | Visible `<label for>`; the visible label names the input | `surface-raised`, `border-subtle`, 6px rhythm |
| Cloning line | Page CSS (`.discover-remote__cloning`) | none | n/a | `cloning.url` | Plain text with inline code | `muted-foreground` |
| Clear control | Reuse `Button` ghost `sm` inside the panel footer | none | n/a | Only while the target is remote; `remoteChangeDisabled` | Accessible name states the action | `panel__footer` primitive |

Verification of the existing component set: `openui.json` lists `Button`, `IconButton`, `Input`,
`PageHeader`, and `StageTrack`; none carries a panel, a select, or a list row. The panel composes
the shipped `Button` and `Input` primitives with page CSS. No design-system artifact is mutated,
so no designmd research receipt is required.

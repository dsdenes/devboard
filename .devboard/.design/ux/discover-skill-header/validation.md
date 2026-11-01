# Validation

- Issue: #997 (redesign `#workspace-discover … .discover-skill__header`).
- Page: Discover skill editor, `/` with Discover mode and the `testing-strategy` tab.
- Command: `bun run build`; source dashboard `HOST=127.0.0.1 PORT=8217 … STATIC_DIR=dist
  bun run server/index.ts` against a copied Discover fixture host under
  `.devboard/.tmp/host-997`; `bunx tsc --noEmit`; `bun test`; `bun run verify:interface`.
- Base URL: `http://127.0.0.1:8217/`.
- Playwright source: OMP browser tool (Chromium).
- Viewports: 1440×900, 1024×720, and 2101×1017 (the issue's capture).
- Journeys exercised:
  - J1 read the path and the saved state on a clean skill.
  - J2 edit, observe `Unsaved changes` on its warning dot, confirm Save becomes the only primary.
  - J3 discard an edit and return to the generated text.
  - J4 delete the live file, observe `Live file missing` on its error dot, recreate, observe clean.
- States exercised: clean/generated, dirty, missing, dark and light themes, 1024px and 2101px
  widths.
- Dependent pages: none. The change touches `.discover-skill__header`, its state markup and
  styles, the DESIGN.md component entry, and this element's evidence set; no shared component or
  token changed.
- Screenshots:
  - `after-clean-1440-dark.webp` — the raised band, muted saved state on its success dot, quiet
    disabled Save.
  - `after-clean-1440-light.webp`, `after-clean-1024-light.webp` — the mirrored palette.
  - `after-dirty-1440-dark.webp` — `Unsaved changes` on its warning dot and the filled primary
    Save.
  - `after-edited-1440-dark.webp` — clean edited skill with the outline `Discard edits` control.
  - `after-missing-1440-dark.webp` — `Live file missing` on its error dot with `Recreate
    generated version` as the only primary.
  - `after-missing-1024-dark.webp` — the same state on the narrow viewport, path truncated with
    its full-path tooltip.
  - `after-clean-1024-dark.webp` — the default narrow viewport, path and actions on one row.
  - `before-clean-1440-light.webp` — kept from the earlier run; the two-line header before it.
- Measurements at 1440×900 dark: header height 34px, background equals the `surface-raised`
  token, identity/action center delta within 2px, `No unsaved changes` with a 6px dot on
  `--success`, Save disabled with `bg-[var(--secondary)]`, header `scrollWidth` equals
  `clientWidth`. Dirty: dot and word on `--warning`, Save `bg-[var(--primary)]` and enabled.
  Missing: dot and word on `--error`, Save disabled `secondary`, restore `bg-[var(--primary)]`
  reading `Recreate generated version`. At 2101×1017 the header stays one 34px row with no
  overflow.
- Console/network: no page errors or failed requests observed in the browser session.
- Checks (after rebasing onto the integration line): `bun run build` pass; `bunx tsc --noEmit`
  0 errors; `bun test` 1286 pass / 0 fail (an earlier run under concurrent browser work recorded
  one timing failure that did not reproduce); `bun run verify:interface` exits 1 on
  `the second submit did not start exactly one more elaboration: {"before":8}` after the whole
  Discover block, the same assertion, evidence, and exit code the unmodified base revision
  reports, so every check on this header passes and the remaining failure is pre-existing and
  outside this change.
- Findings: the row now reads as the editor's chrome instead of a bare hairline, the 28px
  controls sit inside it instead of filling it, and the state is legible at a glance without a
  badge or a second label.
- Not run / blocked: the pre-existing Issues elaboration failure in `verify:interface` is not
  fixed here; it is reported in the issue's final response.
- Verdict: pass for the changed surface.

# Providers key form — validation

## Environment

- App command: `bun run dev` from `.devboard` (Vite dev server, `http://localhost:5199/`), which
  proxies every REST root and backend endpoint to the live dashboard at `http://127.0.0.1:8080/`.
- Production bundle: `bun run build`, then `bunx vite preview --port 5200 --strictPort` from
  `.devboard` (`http://localhost:5200/`), the same bundle the dashboard embeds.
- Pre-change comparison: the live dashboard at `http://127.0.0.1:8080/`, which serves the revision
  before this change.
- Browser: OMP managed Chromium (headless), driven through the `browser` tool; the operator
  Playwright suite under `.devboard/e2e` was not run for this single dialog.
- Viewports: 1440×900, 1024×720, and 2101×1017 (the operator's captured viewport). Light theme
  checked by setting `data-theme="light"` on the document.

## Checks

```sh
DEVBOARD_BIN=.devboard/target/debug/devboard sh .omp/skills/devboard-ui-ux/scripts/preflight.sh .
bun install --frozen-lockfile            # in .devboard, once
bun run check                            # svelte-check
bun run test:client                      # bun test
bun run build                            # vite build + embed-client
bunx vite preview --port 5200 --strictPort
```

| Check | Result |
|---|---|
| Preflight (repo root) | `applicable: true`; DESIGN.md lint `unverified` (no local `@google/design.md` install); DTCG, OpenUI, Storybook pass |
| `bun run check` | 1730 files, 0 errors, 0 warnings |
| `bun run test:client` | 443 pass, 0 fail (67 files) |
| `bun run build` | passes; `crates/devboard/assets` refreshed |
| Wireframe render | `providers-key-form.wireframe.html` renders at 390px and 1440px with no horizontal overflow; structure matches the A2UI stream |

## States and evidence

Screenshots are in this directory; all were captured against the production bundle except `before`.

| State | Evidence | Result |
|---|---|---|
| Before (pre-change) | `before.webp` | Rule paragraph and ungrouped field column; truncated `model opencode-go/de…`; submit detached at the far right |
| Add, resting | `after-default.webp` | Compose card names itself `Add a key`; Provider/Label row; API key row with a 28px filled submit beside it; submit disabled while the key is blank |
| Add, key typed | measured | Submit enables once the key holds non-whitespace text |
| Edit | `after-edit.webp` | Title `Edit key`; provider select disabled and at 50% opacity; key placeholder `Leave blank to keep the current key`; `Cancel` ghost beside `Save changes` |
| Saving / saved | `after-saved-feedback.webp`, `after-saved.webp` | Mocked `POST /providers` answering a `providerChanged` frame: `Provider saved.` pill under the key row, then the form returns to `Add a key` with an empty key and an enabled-at-rest submit |
| Refusal | `after-refusal.webp` | Mocked `providerError` frame: alert above the card, typed key kept, submit back to `Add key` |
| Empty | `after-empty.webp` | Mocked empty `providersState`: compose card plus the unchanged "No provider subscription…" line |
| Light theme | `after-light.webp` | `surface` vs `background` layering, borders, muted labels, and the disabled select read correctly |
| Narrow (1024×720) | measured | Dialog 640×563 at x=192; compose card 622 wide; no horizontal overflow |
| Wide (2101×1017) | measured | Dialog stays `min(640px, 100vw - 32px)`; no reflow, no clipping |

## Accessibility

- `ariaSnapshot` of the dialog: `dialog "Providers"` → `form "Add a key"` → `heading "Add a key"
  [level=3]`, `combobox "Provider"` (previously named `Provider model opencode-go/deepseek-v4.1-flash`),
  `textbox "Label"`, `textbox "API key"`, `button "Add key" [disabled]`.
- Tab order from the provider select: Label input → API key input → (submit, skipped while
  disabled) → first row's `enabled` checkbox → `Edit` → `Delete`.
- Focus: the 2px `ring` is visible on both inputs; the submit is a native submit button, so
  `Enter` in a field submits the form.
- State never depends on color alone: the disabled select dims, the refusal is an alert with text,
  and the success pill carries a check icon plus the word.

## Not run

- designmd MCP research: not entered. No design-system artifact changed — `DESIGN.md`,
  `design/tokens.json`, `openui.json`, and `stories/` are byte-identical; the redesign composes the
  shipped `Button` and `Input` primitives and existing tokens inside one page-local component.
- `DESIGN.md` lint: the preflight reported it unverified (no local `@google/design.md` install).
- The operator Playwright suite: not required for this change; the same journeys were exercised in
  Chromium above.

## Pre-existing issue observed

Both the pre-change bundle and this change log `Svelte error: state_unsafe_mutation` when a provider
change settles, because `CommandBusy.#awaiting()` writes its latch while the component reads
`busy`/`notice` during render. It is reproduced on the pre-change bundle at 8080 and is outside
this issue's scope; no behavior was changed by this redesign. Its visible effect is that the
submit label can trail the reset by one render frame; the form and the list settle correctly.

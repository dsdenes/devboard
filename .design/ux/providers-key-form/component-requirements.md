# Providers key form — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Compose region card | Compose | none; local `.providers-compose` in `ProvidersDialog.svelte` | — | Always rendered; holds title, caption, fields, actions, notice | `section` with `aria-labelledby` the region title | `surface`, `border`, `md` radius, 10px padding |
| Region title | Compose | none; `h3` + `panel-title` type | — | `Add a key` / `Edit key`; switches with `editing` | Real heading; labels the region | `panel-title` 12px/600 |
| Rotation caption | Compose | none; `p` + 11px muted text | — | Rule text from `providers.rule`; wraps to two lines at 640px | Plain text, no icon-only meaning | `muted-foreground`, `micro` size |
| Provider select | Reuse | none; shipped local `select` rule | — | `PROVIDER_IDS` options; disabled while editing at 50% opacity; one selected | Native select, wrapped in its `label` | `background`, `border-strong`, `foreground`, 28px height |
| Label input | Reuse | `Input`? openui.json does not list Input; shipped primitive `ui/input.svelte` | — | Empty, prefilled on edit, long label, whitespace trimmed; placeholder is the provider name | `label` wraps the control; placeholder never the only label | `background`, `border-strong`, `ring`, 28px |
| API key input | Reuse | shipped primitive `ui/input.svelte` | — | Empty, long key, add placeholder `Paste the key`, edit placeholder `Leave blank to keep the current key`; password type, no autocomplete | `label` wraps; the value is never echoed or suggested | `background`, `border-strong`, `ring`, 28px |
| Submit | Reuse | `Button` (`openui.json`) | `design-system.stories.ts` | Disabled until the key is non-blank in add mode; busy word `Adding…`/`Saving…`; primary variant, 28px to align with the key input | Native submit button; `aria-busy` while pending; disabled attribute | `primary`, `primary-foreground`, `primary-hover` |
| Cancel edit | Reuse | `Button` (`openui.json`) | `design-system.stories.ts` | Visible only while editing; ghost, 28px | Native button, label `Cancel` | `foreground`, `secondary` |
| Save feedback | Reuse | local `SaveFeedback` + `CommandNotice` | — | Success and refusal lines; refusal keeps the draft; transient notice dismissible | `role="status"` from the shipped components | `success`, `error`, `surface` |
| Store error | Compose | none; existing `.providers-error` | — | Only when `providers.error !== null`; long forge/provider message wraps | `role="alert"` | `error`, `error-surface` |
| Configured key rows | Reuse (unchanged) | — | — | Zero, one, many rows; exhausted/ok/near-limit/invalid; long labels; overflow scrolls the dialog body | Existing row semantics unchanged | existing row tokens |

## Component details

### Compose region

- Decision: compose a local region from a `section`, heading, caption, the shipped `Input` and
  `Button` primitives, and the existing native select.
- Why: no shared component or catalog entry needs to change; the region is page-local layout, and
  the design-system primitives already carry every control.
- Data shapes: `provider: ProviderId`, `label: string`, `key: string`,
  `editing: ProviderSubscription | null`, `saving: number | null`, `providers.error: string | null`,
  `providers.rule: string`.
- States: add resting, add with key, edit resting, saving, refusal, store error, no keys.
- Edge cases: a 200-character label; a key of 400 characters; two providers and three keys of one
  provider; a 640px dialog at 1024px viewport; a refusal while the draft is typed; `Cancel` during
  a pending save (cancel only resets the form, the request still settles).
- Layout: identity row `168px minmax(0, 1fr)`, key row `minmax(0, 1fr) auto`, both 8px apart
  vertically and 10px horizontally, actions aligned to the input baseline.

### Design-system mutation

None. `DESIGN.md`, `design/tokens.json`, `openui.json`, and `stories/` are unchanged, so the
designmd research gate is not entered. No new token, component variant, or catalog entry is
introduced; the region reads existing custom properties only.

## Storybook

No shipped component changes, so no CSF story is added. The existing `design-system.stories.ts`
already covers `Button` and the input primitive's states. The dialog itself is validated in the
running dashboard instead (see `validation.md`).

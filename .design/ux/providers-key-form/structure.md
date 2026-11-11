# Providers key form — structure

## Regions and order

The dialog is fixed-width (`min(640px, 100vw - 32px)`) and modal over the shell. Only the compose
card is new; the dialog header and the key list keep their current regions.

```
Modal (dialog_modal)                         "Providers"
├─ region_header       Row: title + Refresh (unchanged)
├─ region_error        one-line alert, present only when the store reports an error
├─ region_compose      Card — the redesigned top part
│  ├─ compose_head     Column: title, caption
│  ├─ fields_identity  Row: provider_choice | label_input
│  ├─ fields_key       Row: key_input | actions (cancel, submit)
│  └─ compose_notice   one-line confirmation/refusal, present only after a save settles
└─ region_keys         Column/List: empty line or configured rows (unchanged)
```

- `region_compose` is one `surface` card with a 1px `border`, `md` radius, 10px padding, 8px gaps.
  It is the only new container, and it earns its place: it separates the three inputs and their
  submit from the configured rows, which previously floated in one undifferentiated column.
- `compose_head`: `h3` at `panel-title` (12px/600) reading `Add a key`, or `Edit key` in edit mode;
  under it one 11px `muted-foreground` caption holding both the rotation rule and the refresh
  cadence.
- `fields_identity` is a 2-column grid, `168px minmax(0, 1fr)`, 10px column gap: provider select
  (fixed width so both provider names fit) and label input. Both fields carry the shared 11px
  muted field label above the control and a 4px gap, matching `.resources-field`.
- `fields_key` is a grid row `minmax(0, 1fr) auto`, 8px gap, `align-items: end`: API key input and
  the action group. Actions sit with the field they commit: the filled primary is the submit, and
  in edit mode a ghost `Cancel` precedes it.
- No model line remains in the form; the configured row's mono model line already states it.

## Journey mapping

| Region | Journey |
|---|---|
| `region_compose` + `fields_identity` + `fields_key` | Add a key (steps 2–6), Edit a key (steps 2–4) |
| `compose_head` caption | Add a key step 2 |
| `compose_notice` | Add/Edit success and refusal |
| `region_error` | Failure routes for any read/save |
| `region_keys` | Success signal (row appears), No key registered, Delete (unchanged) |

## Significance mapping

- P0: `provider_choice` (C1), `key_input` (C3), `submit` (C4) — the two-row band is visible without
  scrolling at the top of the modal.
- P1: `compose_notice` (C11) directly under the action row; `region_error` (C12) above the card.
- P2: `compose_title` (C10), `compose_caption` (C6+C7), `label_input` (C2), `cancel` (C5, edit only),
  the disabled provider select while editing (C14).
- C8, C9 are absent.

## Primary action

Exactly one filled primary exists in the dialog: `Add key` in add mode, `Save changes` in edit
mode. `Refresh` stays `outline`. The list's row actions stay `outline`/`ghost`/`destructive`.

## State coverage

| State | Structure |
|---|---|
| Add resting | Title `Add a key`; empty provider select at OpenCode Go, empty label, empty key; submit disabled until the key is non-blank |
| Edit resting | Title `Edit key`; provider select disabled; label prefilled; key empty with `Leave blank to keep the current key`; `Cancel` + `Save changes` |
| Saving | Submit shows its busy word (`Adding…`/`Saving…`) with `aria-busy`; inputs stay editable; the draft is never cleared before the answer |
| Refusal | `compose_notice` states the reason under the actions; draft and typed key stay |
| Store error | `region_error` alert above the card; the form stays usable |
| Empty list | `region_keys` shows one 12px muted line stating no subscription is configured and peers cannot start |
| Partial/loading | Existing list behavior; no skeleton is added here |
| Success | Key field and label reset, form returns to add mode, the row appears below |

## Responsive order

The supported viewport is at least 1024×720, at which the dialog is already 640px wide; nothing
reflows. Below a 520px dialog (outside the supported shell, but reachable if a host embeds the
client), `fields_identity` and `fields_key` collapse to one column each, actions right-align under
the key, and the caption wraps. The primary action never leaves the form card.

## Rationale

The obvious alternative — keeping a flat field column and right-aligning the submit under
everything — is what reads as "weird": the submit is separated from the key it commits, the label
column starts at a different baseline than the provider column, and nothing marks where the form
ends and the list begins. Grouping the three inputs in one card, putting the submit on the key's
own row, and deleting the truncated model line makes the region a single readable unit without
adding information the list already carries.

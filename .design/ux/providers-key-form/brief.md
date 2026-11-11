# Providers key form — UX brief

## Identity

- Route: `/`, opened from the status bar's provider indicator
  (`data-testid="providers-indicator"`) or the command palette (`settings.providers`).
- Surface: the `Providers` modal dialog over the whole shell. The redesigned region is its top
  part — the form that adds or edits one provider key. The configured-key list below it keeps its
  current structure.
- Title: `Providers` on the dialog; the redesigned region names itself `Add a key` or `Edit key`.
- Auth/role: local developer or operator. The interface has no account or role model.
- Entry points: the status-bar provider item (shows the active provider and remaining quota), the
  command palette, or a peer start that reports no usable provider.

## Primary goal

Register one provider API key so agent peers have a credential: choose the provider, optionally
name the key, paste the secret, submit. The observable success signal is a saved subscription in
the list below the form, an emptied key field, and a local confirmation beside the submit control.
A second, equal job in the same region edits an existing key's label or replaces its secret.

## Secondary goals

- Understand why a key is not used: the rotation rule and the usage-refresh cadence.
- Refresh quota readings without leaving the dialog.

## Arrival context

- What the user knows: peers cannot start without a provider key, and the status bar names the
  provider in use. They may arrive with a key on the clipboard and no key registered yet.
- What they carry in: the provider they intend to use (OpenCode Go or OpenRouter), the secret, and
  possibly a preferred label.
- Prior page/state: any workspace, usually after a failed agent start or a quota notice. The dialog
  is modal, so the underlying page state is frozen while it is open.
- Device/network assumptions: desktop, at least 1024×720, local dashboard; the key never leaves the
  machine except to the provider's usage endpoint.
- Urgency: moderate. Adding a key unblocks agent work; a mistyped key surfaces as a provider error
  in the list after a usage check.

## Relationship to other pages

- Upstream: the status bar provider indicator, the command palette, and any "no provider" refusal.
- Downstream: the configured-key list in the same dialog (validation status, quota windows, the
  enable/edit/delete row actions), and every agent start that picks a provider.
- Loop: add a key, watch its usage check settle in the list, edit or replace it from its row, and
  return to the form by pressing `Edit`.

## User journeys

### Add a key

1. Trigger: click the provider indicator in the status bar.
2. Read the rotation rule and the refresh cadence.
3. Choose the provider in the select. The provider's fixed model is not a choice here; the list
   rows already name the model each configured key runs.
4. Optionally type a label.
5. Paste the API key. `Add key` enables only once the key field holds non-whitespace text.
6. Submit. The button states `Adding…` with `aria-busy` until the server answers.
7. Success: the key field clears, the form returns to its resting state, and the new row appears in
   the list below.
8. Failure routes: a refusal keeps the typed key and label and states the reason beside the submit;
   a provider usage failure appears on the row, never as a form error; a dropped connection leaves
   the draft in place.
9. Exit: close the dialog (`Esc`, overlay, or the dialog's close path). Nothing is saved on close.

### Edit a key

1. Trigger: `Edit` on a list row.
2. The form names itself `Edit key`, shows the row's provider (not changeable) and label, and leaves
   the secret field empty with the placeholder `Leave blank to keep the current key`.
3. Change the label and/or paste a replacement secret.
4. Submit with `Save changes`, or leave with `Cancel` (also clears the form).
5. Failure routes: identical to adding; a refusal keeps the draft, and a cancel discards it.
6. Success: the form resets to `Add a key` and the row shows the new label or masked key.

### No key registered

1. Trigger: open the dialog on a host with no provider subscription.
2. The list states that no subscription is configured and that peers cannot start until one is
   added; the form is the only action and holds focus order first.
3. Add a key; the empty line disappears once the row arrives.

### Delete a key (unchanged, list region)

1. `Delete` asks for confirmation in place; the confirmed request is destructive and irreversible.
2. If the deleted key is the one under edit, the form resets.

## Non-goals

- Redesigning the configured-key list, its quota windows, status words, or row actions.
- Changing provider selection or rotation semantics, the usage endpoint, or the save protocol.
- Exposing the raw secret anywhere, including after save.
- Adding a provider not in the catalog, or letting the operator edit the model per key.
- Mobile layout: below 1024×720 the shell shows the viewport guard.

## Assumptions

- Multiple keys per provider are supported and common, so the label field stays (the list shows
  three OpenCode Go rows). Inferred from the list and from the server's `label` field.
- The provider's model is fixed by the catalog and read-only for the operator. Inferred from
  `provider-catalog.ts`.
- The key field is cleared after a successful save and never repopulated. Inferred from the current
  form behavior and confirmed by the absence of a masked-secret read path.

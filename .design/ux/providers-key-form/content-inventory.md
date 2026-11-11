# Providers key form — content inventory

Candidates come from the shipped `ProvidersDialog.svelte`. The list region is out of scope and is
not scored here; only the information in and around the top form is.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Provider choice | `PROVIDER_IDS` select | Add, Edit | Choose which provider the key belongs to | Keep | P0; the form cannot submit without it |
| C2 | Label | `label` field, default provider name | Add, Edit | Tell two keys of one provider apart in the list | Keep | P2; row identity depends on it, and defaults exist |
| C3 | API key | `key` field | Add, Edit | The credential itself | Keep | P0 |
| C4 | Submit action | `Add key` / `Save changes` | Add, Edit | Commit the credential | Keep | P0 |
| C5 | Cancel edit | `Cancel` button | Edit | Leave edit mode without changing the row | Keep | P2; Scoped to edit mode only |
| C6 | Rotation rule | `providers.rule` | Add | Explains why the harness picks this key or skips it | Keep | P2; one caption above the fields |
| C7 | Usage refresh cadence | prose in the current rule paragraph | Add | Explains the `Refresh` control and why figures can lag | Keep | P2; second sentence of the same caption |
| C8 | Selected provider's model | `PROVIDERS[provider].model` | Add, Edit | None: the model is fixed per provider and not editable | Drop | Duplicates each row's model line and truncates illegibly in a 150px column |
| C9 | Fixed provider order | `PROVIDER_IDS.map(...)` sentence | Add | None: the select already lists the order | Drop | Derivable from the select itself |
| C10 | Form identity (`Add a key` / `Edit key`) | new | Add, Edit | States which of the two modes the fields are in | Keep | P2; a region without a name reads as stray fields |
| C11 | Save confirmation / refusal | `SaveFeedback` + `CommandNotice` | Add, Edit | Tells whether the save settled and why not | Keep | P1 |
| C12 | Store error | `providers.error` | All | States a failed read or save that is not field-specific | Keep | P1; alert above the form |
| C13 | Quota windows, status word, masked key, checked time | list rows | Edit (context) | Already carried by the list | Keep (unchanged) | Out of scope; the row owns it |
| C14 | Editing row's provider | `editing.provider` | Edit | Confirms which key is edited | Keep | The select shows it disabled |

## Resolutions

- **Model (C8) wins over the form.** The link between a provider and its model is fixed; the
  configured row's mono model line is the source of truth and is already in the list. Removing it
  from the form removes the only truncated text in the region.
- **Rule and cadence (C6, C7) merge into one caption.** One 11px muted sentence pair sits under the
  form title; it is read before pasting, not after.
- **Provider order (C9) is dropped as prose.** The select renders the same order.

The result is three inputs, one submit, one optional cancel, one caption, one region title, and two
feedback lines. Nothing in the form repeats the list.

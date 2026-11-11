# Providers key form — significance inventory

Score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk).

| ID | Information | Goal | Action | Frequency | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C3 | API key | 5 | 5 | 2 | 5 | 5 | 91 | P0 | First field group; inline with its submit |
| C4 | Submit action | 5 | 5 | 2 | 4 | 3 | 84 | P0 | Same row as the key it commits |
| C1 | Provider choice | 5 | 4 | 2 | 5 | 2 | 80 | P0 | Leading field of the form |
| C11 | Save confirmation / refusal | 4 | 4 | 2 | 3 | 2 | 67 | P1 | Beside the submit, inside the form card |
| C12 | Store error | 4 | 4 | 1 | 4 | 2 | 67 | P1 | Alert above the form card |
| C6 | Rotation rule | 3 | 3 | 1 | 5 | 2 | 58 | P2 | Caption in the form card, above the fields |
| C7 | Refresh cadence | 2 | 2 | 1 | 4 | 0 | 39 → 44 | P2 | Second sentence of the same caption |
| C10 | Form identity | 3 | 2 | 2 | 3 | 0 | 46 | P2 | Form-card title |
| C5 | Cancel edit | 3 | 3 | 1 | 3 | 0 | 48 | P2 | Ghost action, edit mode only |
| C2 | Label | 3 | 2 | 2 | 3 | 0 | 46 | P2 | Secondary field, same row as provider |
| C14 | Editing row's provider | 3 | 3 | 1 | 3 | 1 | 48 | P2 | Disabled select, already visible |
| C8 | Selected provider's model | 2 | 2 | 1 | 4 | 0 | 39 | P3 | Omitted; the list row is authoritative |
| C9 | Fixed provider order prose | 1 | 1 | 1 | 2 | 0 | 20 | Drop | Omitted; the select renders it |
| C13 | Quota windows and status | — | — | — | — | — | — | — | List region, out of scope |

C7 is scored 39 numerically; it merges into C6's caption where the read cost is shared, so the
pair is kept as one P2 region statement rather than split into two lines.

## Layout consequence

- P0 (C1, C3, C4) is a two-row band: provider + label, then key + submit.
- P1 (C11, C12) attaches to the region that caused it: the notice inside the form card under its
  action row, the store alert above the card.
- P2 (C10, C5, C2, C6, C7, C14) frames or fills the band without competing: the title and caption
  lead it, the cancel appends to the submit, the label shares the provider row, the model is gone.
- No P3 or dropped item is rendered.

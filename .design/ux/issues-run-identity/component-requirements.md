# Issues agent focus — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Output panel frame | Reuse | `Panel` (existing `.panel` convention; no OpenUI component entry) | none — `.panel` is not a Storybook component | Renders only after a live agent or run history loads; loading and unavailable states use an empty panel body | Native section/div; panel title stays an `h2` | Existing `surface`, `border`, `md` radius, 30px header |
| Run identity chip | Reuse | none — inline `.code-chip` utility documented in `DESIGN.md` | none — CSS utility, not a component | Always the run id verbatim; long ids ellipsis at 220px with the full value in `title`; no id renders no group | The chip is a `<code>` with a `title` naming it a run identifier; it is not focusable and carries no action | Existing `background`, `border-subtle`, `mono-small`, `sm` radius |
| Run start age | Compose | none — a muted `<span>` inside the identity row | none | Live agent `startedAt`; history fallback after the agent ends; missing or invalid timestamp renders no age; relative label refreshes every 30 seconds | Full ISO timestamp in `title`; the text is a phrase, not a bare number | Existing `muted-foreground`, 11px |
| Identity row | Compose | none — page-level flex row in the panel header | none | 8px gap; right-aligned; chip caps at 220px; age yields first when narrow | Reading order is id then age; the row never overlaps the panel title | Existing 8px gap, no new token |

## Decisions

- **No new shared component and no design-system mutation.** The chip is the existing inline-code
  style; the row is a page-level layout. Therefore no `designmd` research receipt and no
  `DESIGN.md`/`design/tokens.json`/OpenUI/Storybook synchronization is required.
- **No status in the panel header.** The page header already carries one status badge; duplicating
  it would violate the one-state-per-surface rule in `DESIGN.md`.
- **No new color, radius, size, or spacing value.** Every value comes from the existing tokens or
  the documented 8px rhythm.

## States the component must survive

- A live run with a fresh start (`Started just now`) and an old start (hours/days).
- A finished run restored from history, including `startedAt` present and absent.
- A pruned run: the output panel does not render at all; the unavailable panel takes over.
- Loading: the output panel does not render yet.
- Long ids: an ISO run id is 24 characters; the chip caps at 220px and the tooltip keeps the whole
  value.
- Narrow header at 1024px: the title stays untruncated and the age yields; no wrapping of the title.
- Dark and light themes: chip and age use theme tokens, not literals.

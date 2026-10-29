# Auto Scout agent header — structure

## Regions

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Header row: identity, status cluster, run action | J1, J2, J3, J4, J5 | C1, C2, C3, C4, C5, C8 | P0/P1/P2 |
| 2 | region_settings | Header footer: two labeled settings groups | J1, J3, J4 | C6, C7, C9, C10, C11, C12, C13 | P1/P2 |
| 3 | region_alerts | Existing alert position below the header | J2, J3, J4, J5 | C14–C18 | P1/P2 |

The header is one surface: the row and the footer share the `surface` fill and `border` frame,
separated by a `border-subtle` hairline. Alerts stay outside the header so a long reason never
changes its height.

```
PageHeader (bar, surface, border, 4px radius)
  row (8px 12px padding, 16px column / 6px row gap)
    identity (left):  h1 "Auto Scout"  ·  purpose sentence
    status cluster (right): [lifecycle badge] [forge sync badge] [Last read clock]
    action (far right): [Start] or [Stop]  ← the only filled primary
  footer (6px 12px padding, border-top border-subtle, 24px group gap)
    CADENCE:  Every [30] min · Last run 09:32 · Next run 09:33 · [Save cadence]
    FILING LIMITS:  Per hour [20] · Open issues [5] · [Save limits]
alerts (only when present): sync error · worker error · cadence error · limits error
```

## Order and hierarchy

- P0 first: the page name, the lifecycle word, and Start/Stop. The status cluster sits beside the
  action it qualifies, so the operator reads "stopped → Start" as one decision.
- C4/C5 follow the lifecycle because they qualify the result list, not the run action.
- The footer is a secondary band: it spans the header width, each group is named in `overline`
  type, and every editable field sits immediately before its save control.
- C6/C7 are read-only clocks inside the cadence group. They are evidence for the interval, never
  independent metrics in the identity row.
- No fact appears twice: lifecycle once, sync once, last read once, interval once, each limit once.

## State coverage

- Stopped: `stopped` badge, Start filled primary, clocks show `never`, fields show saved values.
- Starting/running/stopping: lifecycle word changes; Stop replaces Start while owned; Start is
  disabled while the socket is closed or the legacy timer blocks it.
- Failed: `failed` badge + the worker error alert below; the header height is unchanged.
- Sync ok/stale/error: badge word and tone change; the last successful read clock stays visible.
- Invalid cadence or limits: the field keeps the typed value, an inline alert appears below the
  header, and the last saved values remain in effect.
- Unknown agent: the page error replaces the header entirely (existing behavior).
- Before the first snapshot: lifecycle `stopped`, sync `stale`, clocks `never`, Start disabled.

## Responsive order

- Wide (≥ ~1200px workspace): identity and purpose on the left; status cluster and action on the
  right of the same 44px row; both settings groups share the 40px footer.
- 1024px workspace: the 300px identity floor forces the status cluster and action to wrap below
  the identity; the title stays whole. The footer groups stack, 6px apart, each left-aligned.
- Supported floor: 1024×720. The page never scrolls horizontally; `Every` stays 64px wide.
- Nothing collapses into a menu: all state words and editable values remain visible.

## Rationale

- **Two bands, not one crowded row.** The earlier composition mixed five status facts and six
  controls on one line. At 2101px it read as a wall of labels; at 1024px it broke into four
  fragments (identity, meta, Start, settings) and truncated nothing usefully.
- **Why a footer band instead of a separate panel.** The limits are the budget the run action
  consumes; keeping them on the header surface preserves that relationship without spending body
  height on a panel header and border.
- **Why the settings are always visible.** They are the page's only editable values and their
  current state answers "when will it run next" and "how much may it file". A disclosure or a
  dialog would hide the answer J1 asks for; the footer is two compact groups instead.
- **Why the page-name floor.** A shared bar that squeezes the title to `Aut…` is worse than a
  second line. The state and the action wrap; the name never does.
- **Rejected:** an all-in-one row (fails at 1024), a side rail for settings (steals width from the
  filed table), a collapsible settings panel (hides J1 answers), and a third badge for the sync
  error reason (the alert already owns it).

## Accessibility

- One `h1` from `PageHeader`; the footer groups are named by visible `overline` text, and the
  outer group carries `aria-label="Cadence and filing limits"`.
- Start/Stop, the number inputs, and both save controls are native controls with native labels;
  the input labels wrap the field and its unit, so each accessible name states the unit.
- Lifecycle and sync states are words; tone is redundant. Sync error keeps `role="alert"`.
- Focus order follows DOM order: identity → status → action → cadence group → limits group.
- The 28px controls keep the shared focus ring; disabled controls are non-interactive at 45%.

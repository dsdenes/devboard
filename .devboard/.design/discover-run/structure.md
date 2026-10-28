# Structure — Discover / Run header

## Regions

One 30px panel header above the activity terminal; the panel body is unchanged.

1. **Identity (left).** A 6px `accent` status dot and the `h2` `Run in progress` in `panel-title`.
   The dot is the at-a-glance live marker; the title states the same fact in words so color never
   carries meaning alone. The group shrinks first and truncates with the title's tooltip.
2. **Meta (right, before the action).** `Started <relative>` at 11px `muted-foreground`, with the
   ISO start clock in its `title`. A missing start time omits the item entirely.
3. **Action (far right).** One quiet destructive `Stop`: 24px tall, 11px word, transparent fill,
   `border-subtle` outline, `muted-foreground` text. Hover and keyboard focus take the
   `error-surface` fill, `error` outline, and `error` word, matching the running-agent close
   control. It is never a filled red block in a 30px header.

The header has no second line, no eyebrow, and no tinted fill. Its background is
`surface-raised`, one elevation step above the panel, with the standard `border` bottom edge.

## Ordering and rationale

- C1 (81) leads: state is the panel's reason to exist.
- C2 (77) sits at the end of the row, where every panel header puts its action.
- C4 (54) follows the identity: age answers "is it moving?" more directly than an opaque id.
- C5 and C6 are removed; the rail, sidebar, and page header already name Discover, and the
  state word carries what the blue tint used to shout.
- C3 is removed; the run identifier added no decision the state and age do not already serve, and
  the server log remains its home.

## States covered

- **Running** (only state the server publishes for this panel): dot + `Run in progress` + meta +
  Stop.
- **No start time**: the meta item is absent; no placeholder.
- **Narrow pane** (1024px viewport): title truncates before any meta; Stop and the state survive.
- **Stop in flight / refused**: the header does not add a second state; the page notification
  region reports the failure, as before.
- **Light theme**: all roles resolve through existing tokens; no literal color is added.
- **Reduced motion**: the design adds no animation.

## Responsive priority

Desktop only by contract (≥1024×720). At the minimum width the identity truncates, the meta group
absorbs the remaining slack, and the 24px Stop keeps its size. Nothing wraps to a second header
row and nothing overflows horizontally.

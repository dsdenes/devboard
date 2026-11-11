# Structure — status bar project identity

## Regions and order

The footer is one 26px strip (`footer.status-bar`) read left to right:

| A2UI ID | Region | Contents | Priority |
|---|---|---|---|
| `region_left` | Left group | `region_connection`, then `region_project` | P0 |
| `region_connection` | Connection item | 7px state dot plus the state word | P0 |
| `region_project` | Project identity chip | folder glyph, repository name, full path as tooltip | P0 |
| `region_right` | Right group | lanes, issues, watchdog, notifications, versions, reload | P1–P2 |

## Journey mapping

- `region_project` serves journey 1 (confirm the attached repository) and pairs with
  `region_connection` for journey 2 (confirm the dashboard is live).
- Journey 3 (find the full path) is served by the chip's tooltip, not a second region.

## Significance mapping

- P0 name and P0 connection state both sit in the always-visible strip.
- P2 full path is disclosed through the tooltip.
- P3 glyph is present as supporting detail beside the name.
- P1/P2 metrics stay in the right group and are untouched.

## Primary action

The footer has no action. Its primary job is to state identity and liveness; the only controls in
it are the provider, issues, notifications, and reload controls that already exist.

## State coverage

- **Default:** connection word plus dot, then the project chip.
- **Empty:** `connection.projectPath` blank renders `No project` in the same chip.
- **Long name:** the chip caps at 320px and the name ellipsizes inside it; the full path stays in the
  tooltip.
- **Connecting / disconnected:** only the connection item changes; the chip keeps the last known
  project.
- **Narrow viewport:** the right group gives ground first; the chip keeps its place and never wraps.

## Responsive order

Fixed order at every width. The right group is the flexible side, so a narrow window never pushes
the project identity out of the strip.

## Rationale

The name is an identifier, and the interface already has exactly one treatment for identifiers: the
shared inline-code chip. Giving the project item that treatment separates it from the bare state
word beside it, gives the glyph a measured 4px gap instead of a collision, and removes the second
vertical rule that previously sat 4px from the divider — the chip's own hairline now separates
identity from state. Wrapping the name in a heavier surface (a page header, a sidebar copy) would
duplicate the sidebar; leaving it bare keeps a 12px mono word louder than every state word in a bar
whose job is ambient status.

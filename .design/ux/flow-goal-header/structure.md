# Flow goal header — structure

## Regions
| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | Header row | 1, 2, 3 | C1, C2, C3, C4 | P0 |

## Primary action
- Action: state-dependent. `Create flow goal` while no goal exists; `Save` while the
  draft has unsaved changes; otherwise no filled primary is required.
- Why it is primary: it is the only action that advances the goal from its current
  state to the state implementation needs.
- Where it lives: right end of the header action group, after the create/recreate
  control.

## State coverage
- Empty: `No goal yet` badge; `Create flow goal` is the filled primary; Save is a
  disabled secondary control.
- Saved: `Saved` success badge; `Recreate flow goal` is the outline control; Save is a
  disabled secondary control.
- Dirty: `Unsaved changes` warning badge; Save is the filled primary; recreate remains
  outline.
- Interview running: `Interview running` accent badge; create/recreate remains
  available, Save follows the draft state.
- Error: server errors stay in the Flow notice region; the header keeps the last known
  state and never invents a saved state.
- Loading: the shell renders the header from the mounted flow state; no skeleton is
  needed because state arrives with the session snapshot.

## Responsive order
- Desktop: identity at the left, actions at the right, one 44px row.
- Narrow (1024px): the same order; the action group never wraps below 1024px because
  the workspace is at least 952px wide after the rail and sidebar.
- Collapsed/moved/hidden: nothing collapses. The header stays one row while the
  interview panel replaces the editor below it.

## Rationale
- Grouping: title and state form one identity; actions form one group. The state is a
  badge on the title line rather than a second text line, so the 30px panel-header
  convention no longer crowds two baselines.
- The header grows to 44px because it is the lead surface of a full-page editor; 8px
  vertical breathing room keeps the 28px controls and the 18px title from touching the
  panel edges.
- Alternatives rejected: a page-header component would introduce a second page title
  and 10px padding rhythm; keeping the two-line identity would preserve the crowding
  the issue reports; moving state into the editor status bar would hide it from the
  action it explains.

# Issues run identity — validation

## Scope

Issue #227 selected the run-id `panel__subtitle` inside the Issues overview's activity panel. On
the current integration line that overview panel no longer exists: `1757344` replaced the single
active-run activity panel with the Agents surface and a per-agent focus tab. The surviving panel
subtitle that shows a run id is the Output panel in that focus tab, so the redesign was applied
there. The change uses only existing design-system tokens and the existing inline `.code-chip`
style; no token, color, component variant, OpenUI entry, or Storybook story changed, so no `designmd`
mutation or design-system synchronization was required.

## What changed

- `client/lib/components/IssuesAgentFocus.svelte` — the Output panel header now renders a `Run`
  label, the run id as a `.code-chip` capped at 220px with the full value in its `title`, and
  `Started <relative time>` whose `title` carries the ISO start. The relative label refreshes every
  30 seconds. The start comes from the live agent, then from run history.
- `client/app.css` — `.issues-run-identity`, `__label`, `__id`, `__started`; all values are
  existing tokens or the documented 8px rhythm.
- `client/lib/components/IssuesAgentFocus.test.ts` — asserts the label, the chip, the full-id
  tooltip, and the relative start with its ISO tooltip for a live run and for a run restored from
  history; removing the identity group from the component fails it.

## Commands

Run from `.devboard` in the worktree:

```bash
bun install --frozen-lockfile
bun run build
bun run check      # svelte-check: 0 errors, 0 warnings
bun test           # client unit suite, including IssuesAgentFocus.test.ts
cargo test --workspace
```

`bun run check` runs `svelte-check`, `bun test` runs the client unit suite, and
`cargo test --workspace` runs the harness suite.
`bun test client/lib/components/IssuesAgentFocus.test.ts` runs the focus-page test alone. The
change touches only the client and this record, so the Rust suite is unaffected.

## Evidence

| Viewport / state | Evidence | Result |
|---|---|---|
| 1440×900, dark, live run | `screenshots/focus-desktop.png` | `RUN` label, chip, full id, `Started 6 hours ago`; panel title intact |
| 1440×900, light, live run | `screenshots/focus-light.png` | same content; chip and age read at the light-theme contrast |
| 1024×720, dark, live run | `screenshots/focus-1024x720.png` | identity stays inside the panel header; chip ≤ 220px; title not clipped |
| Live run identity | `client/lib/components/IssuesAgentFocus.test.ts` | chip carries the run id and the full-id tooltip; the relative start carries the ISO start |
| Restored from history | `client/lib/components/IssuesAgentFocus.test.ts` | with no live agent, the chip and the start come from the run history frame |
| No raw subtitle | `client/lib/components/IssuesAgentFocus.svelte` | the panel header's only run text is the identity group; no `panel__subtitle` |

The pre-change markup rendered only the bare ISO id in 11px muted text
(`<span class="panel__subtitle mono">{runId}</span>`); the diff shows the replacement.

## Not run

- Mobile layout: the shell declares 1024×720 its minimum supported viewport and shows the
  unsupported-viewport notice below it.
- A pairwise contrast calculation for the chip: its colors are the existing `background` and
  `border-subtle` tokens already used by every `.code-chip`; the light and dark screenshots confirm
  legibility, not a new token pair.

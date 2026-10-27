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
- `client/app.css` — `.issues-run-identity`, `__label`, `__id`, `__started`; all values are existing
  tokens or the documented 8px rhythm.
- `scripts/verify-interface.ts` — the focus-tab check asserts the label, chip, full-id tooltip, the
  relative start with its ISO tooltip, the absence of a bare `panel__subtitle`, and no header
  overflow with the chip capped at 1024×720; it writes desktop, light, and 1024×720 screenshots.
- `.devboard/README.md` — documents the panel header's test ids and content.

## Commands

Run from `.devboard` in the worktree:

```bash
bun install --frozen-lockfile
bun run build
bun run check            # 0 errors, 0 warnings after the concurrent FeedbackOverlay type fix
bunx tsc --noEmit
bun test                 # 567 pass, 0 fail
bun run verify:interface # passed
```

`bun run check` on the merge base reports one unrelated error in `client/FeedbackOverlay.svelte:265`
(`Object is possibly 'undefined'`), introduced by the concurrently merged Ask-conversation change
(`ac6f5da`). With that one-character upstream fix applied locally, svelte-check reports 0 errors and
0 warnings; the fix is not part of this commit.

`verify:interface` drives the seeded Issues fixture in headless Chrome at 1440×900 and 1024×720 and
reports: shell, modes, sidebar, pages, splits, palette, keyboard, theme, tables, editors,
terminals, accessibility, notifications, status bar, issues mode, ask transcript, persistence, and
boundary passed.

## Evidence

| Viewport / state | Evidence | Result |
|---|---|---|
| 1440×900, dark, live run | `screenshots/focus-desktop.png` | `RUN` label, chip, full id, `Started 6 hours ago`; panel title intact |
| 1440×900, light, live run | `screenshots/focus-light.png` | same content; chip and age read at the light-theme contrast |
| 1024×720, dark, live run | `screenshots/focus-1024x720.png` | identity stays inside the panel header; chip ≤ 220px; title not clipped |
| Focus after reload | `verify:interface` reload check | final status and activity restore; identity still renders |
| No raw subtitle | `verify:interface` check | `.issues-agent-focus .panel__subtitle` count is 0 |

The pre-change markup rendered only the bare ISO id in 11px muted text
(`<span class="panel__subtitle mono">{runId}</span>`); the diff shows the replacement.

## Not run

- Mobile layout: the shell declares 1024×720 its minimum supported viewport and shows the
  unsupported-viewport notice below it.
- A pairwise contrast calculation for the chip: its colors are the existing `background` and
  `border-subtle` tokens already used by every `.code-chip`; the light and dark screenshots confirm
  legibility, not a new token pair.

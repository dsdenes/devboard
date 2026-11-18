# Watchdog page — validation

- Date: 2026-11-18. Issue: #2102. Type: documentation correction; no client or server source
  changed.
- Changed surface: this packet now documents the shipped Watchdog surface — `AgentPage` for the
  `watchdog` family, `AgentActivityBar`, `AgentIssuesTable`, `AgentSettings`, and the status bar's
  watchdog indicator. The retired `.watchdog-page` page, its Issues-mode route, its REST read, and
  its `verify:watchdog` verifier are recorded nowhere as shipped or as having run.
- The superseded duplicate packet under `.devboard/.design/watchdog/`, its wireframe pair, and the
  retired layout's captures were removed with this change; `.design/ux/watchdog/` is the one packet.

## Commands

Each command is a script in `.devboard/package.json` and runs from `.devboard/`:

| Command | Result |
|---|---|
| `bun run check` | pass; `svelte-check`: 1825 files, 0 errors, 0 warnings |
| `bun run test:client` | pass; 765 tests, 0 fail, 3512 expectations, 108 files |

No build ran: the change edits documentation only, so the client bundle and the server binary are
untouched. A verifier who changes the documented surface runs `bun run build` in the same package
root before capturing new evidence.

## Live inspection

The shipped page was inspected in the running dashboard at its 1440×900 viewport and at the
1024×720 floor. The dashboard served the checkout's released source (`1.57.15`, source), and the
client bundle is identical to the one this documentation describes.

- Header: `Watchdog` h1, the descriptor description, peers badge, worker version `1.57.15`, forge
  badge `ok`, and `Last read Nov 18, 02:11`. The settings footer held `Every 10 min`, its last and
  next run, and `unlimited` filing limits.
- Filed issues: 87 rows, subtitle `87 filed · 0 pending filing`, columns Title, Category, Filed,
  State, Shipped at measured tracks 110/132/86/76px and 27px rows with a sticky header.
- Activity log: expanded to 100 cycle lines, 179px client height against a 180px cap, oldest first
  and newest last, each line `start · action · window · findings · reason`.
- Prompt disclosure: `Watchdog runs no agent, so it has no prompt to show or edit.`
- Indicator: trigger read `watchdog none · 51s ago`; the popover was `role="dialog"` named
  `Watchdog report`, 520px wide by a 450px cap (the 50vh limit), and listed 87 issue links. The
  indicator's window handler closes it on Escape, which the trigger's `aria-expanded` reports.
- Page box: 1063×874 CSS pixels at 1440×900 and 647×694 at 1024×720, with `scrollWidth` equal to
  `clientWidth` at both sizes, so the page never scrolls horizontally at its floor.
- Column drop: the table's stylesheet hides Category, Filed, and Shipped below a 900px viewport;
  the shell replaces the workspace with the viewport guard below 1024×720, so the shipped product
  never reaches that rule.

## Evidence files

| Evidence | Viewport | State |
|---|---|---|
| `wd-page-1440-dark.png` | 1440×900 | Shipped page, activity bar collapsed, filed issues |
| `wd-activity-1440-dark.png` | 1440×900 | Activity bar expanded: retained cycle lines |
| `wd-page-1024-dark.png` | 1024×720 | Supported floor, all five table columns |
| `wd-popover-1440-dark.png` | 1440×900 | Status-bar indicator popover open |

## Not run

- Light theme: the surface reuses documented tokens; this pass captured dark only.
- Keyboard traversal and screen reader session: not available in this pass; the control roles,
  labels, and focusable elements were read in the DOM.
- The full Rust workspace suite: no Rust source changed.

# UI issue actions — validation

Source of truth: `DESIGN.md` (tokens and rationale) and the buttons' exact token contract from the
existing `Button` primitive. No token, color, shadow, or component variant was added.

## Scope and journeys

The three UI issue actions live in the activity bar's application actions, beside commands,
notifications, and theme; the operator's review batch that moved the report control there is
`.design/ux/operator-ui-tweaks/validation.md`. Every route carries them; they are shell chrome,
not a page. The action's result, or its failure, appears as one line at the bottom of the
workspace, above the status bar.

- **Report journey.** Operator sees a wrong or unclear element → picks `Report UI issue` → the
  element under the pointer is outlined → click it → read the selector → type the problem →
  `File issue` → the issue URL is filed and the mode returns to selection. Failure: the panel
  keeps the server's message and the text.
- **Remove journey.** Operator decides an element should not exist → picks `Remove element` →
  clicks the element → the issue is filed at once → the mode stays armed → clicks the next
  element. Failure: `Removal issue failed: <message>` while the mode stays armed.
- **Redesign journey.** Operator sees an element that does not look good → picks
  `Redesign element` → clicks the element → a redesign ticket with the fixed design-system
  instruction is filed → the mode stays armed for the next element.
- **Exit.** `Esc`, the active control, or `app.report.cancel` from the palette returns to idle.

Non-goals: previewing the issue before filing, editing the fixed instruction, filing in the host
project's tracker.

## Information inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| A1 | Which action is armed | dock `aria-pressed` | all | yes | yes | One mode at a time is the contract. |
| A2 | What the next click does | hint line | all | yes | yes | Selection has no other affordance. |
| A3 | Filing in progress | `Filing…` on the active control | all | yes | yes | Prevents a second click. |
| A4 | Filed issue URL | success status | remove/redesign | yes | yes | Proof the ticket exists. |
| A5 | Failure message | error status / panel | all | yes | yes | Recovery route. |
| A6 | Selected element's selector | panel code line | report | yes | yes | Anchors the ticket. |
| A7 | Free-text report | panel textarea | report | yes | yes | The report's content. |
| A8 | Element outline | marker | all | yes | yes | Confirms the target before the click. |

Everything else on the panel (drag handle, close control) is existing component structure and is
retained unchanged.

## Significance

| ID | Goal | Action | Frequency | Unique | Risk | Score | Priority |
|---|---:|---:|---:|---:|---:|---:|---|
| A1 | 5 | 5 | 5 | 5 | 3 | 98 | P0 |
| A2 | 5 | 4 | 5 | 5 | 3 | 92 | P0 |
| A3 | 3 | 5 | 2 | 5 | 4 | 76 | P1 |
| A4 | 4 | 3 | 2 | 4 | 2 | 63 | P1 |
| A5 | 4 | 4 | 2 | 5 | 3 | 74 | P1 |
| A6 | 4 | 3 | 3 | 4 | 2 | 66 | P1 |
| A7 | 5 | 5 | 2 | 5 | 2 | 82 | P0 |
| A8 | 4 | 4 | 4 | 4 | 3 | 79 | P1 |

## Structure

Three 28px ghost icon controls in the rail's application actions, in a stable order — report,
remove, redesign — each with an accessible name, a tooltip, `aria-pressed` while armed, and a
disabled state while a filing runs or the report panel owns the selection. The result line is one
centered `surface-raised` row above the status bar: `role="status"` with the issue link on
success, `role="alert"` with the message on failure. The hint stays in the shell's existing
top-center position. The notification region keeps its lower-right corner and never intersects
the result line.

Wireframe: not produced. These are shell chrome whose order, names, and surfaces follow the
existing mode rail and the operator's review, so an A2UI structural pass would restate the
specification rather than decide anything. Step 4 decision: reuse the `IconButton` primitive for
all three actions and the `Button` token contract for the result line; the shared primitives,
catalog, and stories are unchanged.

## Evidence

| Check | Viewport | Evidence | Result |
|---|---|---|---|
| Three controls with `data-command` ids and accessible names on every route (Goal, Flow, Discover) | 1440×900 | `bun run verify:interface` assertions | pass |
| Report panel path unchanged (title, placeholder, `File issue`/`Cancel`, selector, drag) | 1440×900 | `bun run verify:interface` assertions | pass |
| Two consecutive removals and two consecutive redesigns from one armed mode | 1440×900 | stub records + CDP request bodies | pass |
| Delayed filing disables all three controls and reads `Filing…`; a double-click files once | 1440×900 | `bun run verify:interface` assertions | pass |
| Failure alert keeps the mode armed, re-enables the controls, shows no link | 1440×900 | `bun run verify:interface` assertions | pass |
| Actions stay inside the rail; result line clears the status bar and the notification region | 1024×720 | `issue-actions-1024x720.png` | pass |
| Dark and light rendering | 1440×900 | `issue-actions-dark.png`, `issue-actions-light.png` | pass |
| Console errors and failed requests | 1440×900 | `bun run verify:interface` final check | pass |

Spacing audit: the 28px icon controls, the 4px result-line padding, and the 6px 8px result-line
box are the existing primitive and spacing values. Focus rings are the existing 2px `ring` ring
with a 1px offset.

Playwright: not used. The project's documented browser gate is `bun run verify:interface`, which
drives headless Chrome over CDP; it is the evidence source above.

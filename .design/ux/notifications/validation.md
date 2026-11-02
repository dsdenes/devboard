# Notification issue filing — validation

Source of truth: `DESIGN.md`, especially the notification region's place in the shell and the
`Button` primitive. No token, color, shadow, or component variant was added.

## Scope and journey

Issue #297 asks for a control on a notification that files an issue from it immediately. The
notification region is shell chrome in the lower-right corner; it appears over every mode.

- **File journey.** An error or warning arrives (server diagnostic, lost connection, failed
  command) → the operator reads it → clicks `File issue` → the issue is filed at once with the
  notification text as its title line and the card as captured context → the control becomes an
  `Open issue` link to the filed ticket. No panel, confirmation, or text entry intervenes.
- **Failure.** `gh` or the server fails → the card keeps the notification and adds one `error`
  line naming the server's message; the button returns for a retry.
- **Repeat.** Notices and successes carry no filing action, so "Closed issue #N" cannot recursively
  file an issue. Dismissal behavior is unchanged, and the same control is available in the
  notification history.

Non-goals: editing the report text, filing in the host project's tracker, filing from a success
or notice card.

## Information inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| N1 | Severity and text | notification card | file | yes | yes | The issue's title line and the reason to file. |
| N2 | `File issue` control | actions row | file | yes | yes | The requested action. |
| N3 | `Filing…` state | actions row | file | yes | yes | Prevents a double filing and shows progress. |
| N4 | Filed issue URL | `Open issue` link | file | yes | yes | Proof the ticket exists and a way to open it. |
| N5 | Failure message | card error line | file failure | yes | yes | Recovery route. |
| N6 | Dismiss control | actions row | all | yes | yes | Existing behavior, unchanged. |

## Significance

| ID | Goal | Action | Frequency | Unique | Risk | Score | Priority |
|---|---:|---:|---:|---:|---:|---:|---|
| N1 | 5 | 5 | 3 | 5 | 3 | 86 | P0 |
| N2 | 5 | 5 | 3 | 5 | 3 | 86 | P0 |
| N3 | 3 | 5 | 2 | 5 | 3 | 74 | P1 |
| N4 | 4 | 3 | 2 | 4 | 2 | 63 | P1 |
| N5 | 4 | 4 | 2 | 5 | 3 | 74 | P1 |
| N6 | 2 | 3 | 3 | 3 | 2 | 54 | P2 |

## Structure

The actions row sits at the card's trailing edge: `File issue`, then the existing dismiss icon,
with a 2px gap. `File issue` is the existing `Button` primitive at `ghost`/`sm`; the success link
and the failure line use the card's existing 6px 8px padding, the 11px `body-small`/`overline`
sizes, `accent` for the link, and `error` for the failure line. The history dialog reuses the same
actions snippet, so both surfaces stay identical.

Wireframe: not produced. The control is a single action in an existing 380px card; the card,
severity stripe, dismiss icon, and history list already define the structure, so an A2UI pass
would restate the specification rather than decide anything. Step 4 decision: reuse `Button`
(`ghost`, `sm`) and the Lucide dismiss icon; no new primitive, variant, catalog entry, or story.

## Evidence

| Check | Viewport | Evidence | Result |
|---|---|---|---|
| An error notification shows an enabled `File issue` with an accessible name | 1440×900 | `notification-issue-file-1440x900.png`, `verify:interface` assertions | pass |
| One click files exactly one issue through `/feedback` with the notification text, severity, timestamp, route, selector, visible text, and DOM excerpt | 1440×900 | `verify:interface` feedback stub record and captured request | pass |
| The filed title is `[ui] Error notification: <text>` and the body carries `## Operator report` plus the captured context | 1440×900 | `verify:interface` assertions on the stub call | pass |
| Success replaces the button with an `Open issue` link to the returned URL | 1440×900 | `notification-issue-filed-1440x900.png`, `verify:interface` assertions | pass |
| A failed filing shows `Issue not filed: <message>` and returns the button for a retry | 1440×900 | `verify:interface` failure-mode stub and assertions | pass |
| The retry files the same notification once the server reports success | 1440×900 | `verify:interface` second stub call and link | pass |
| Dismissal still works after the actions row grows | 1440×900 | `verify:interface` dismissal assertion | pass |
| Notices and successes carry no filing action | 1440×900 | `NotificationRegion.svelte` severity guard; `svelte-check` | pass |
| Unit coverage for the report text, labels, and the server's 8000-character bound | n/a | `bun test client/lib/notification-issue.test.ts` | pass |
| Console errors and failed requests | 1440×900 | `bun run verify:interface` final check | pass |

Commands run from `.devboard`: `bun test`, `bun run check` (0 errors, 0 warnings), `bun run
build`, `bun run verify:interface`.

Spacing audit: the actions row uses the approved 2px gap inside the existing 6px 8px card
padding, the 24px action height comes from the `sm` button, and focus stays on the existing
`Button` 2px ring. No arbitrary spacing value was introduced.

Playwright: not used. The project's documented browser gate is `bun run verify:interface`, which
drives headless Chrome over CDP and is the evidence source above.

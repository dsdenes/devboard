# Issues Automation poll line — redesign (#226)

One operator report against the Issues overview. The selected element is the Automation panel's
subtitle, `#workspace-issues ... .panel__header .panel__subtitle`, which read
`Every 2s · last 2026-10-27T14:03:22.854Z · next 2026-10-27T14:03:24.854Z`.

Skill mapping: this repository records small operator-report batches as one consolidated file per
surface, following `.design/ux/operator-ui-tweaks/validation.md` and
`.design/ux/ui-issue-actions/validation.md`. Brief, information inventory, significance, structure,
component decision, and validation are the sections below. No separate A2UI wireframe was
produced: the change is one status line inside an existing 30px panel header, so a structural
wireframe would restate the specification instead of deciding anything.

## Brief

- **Page identity.** Issues mode → Overview (`/`, `#workspace-issues`), no auth or role. Entry
  points: the Issues rail tab, the status-bar issues indicator, and `view.mode.issues`.
- **Primary goal.** See whether the issues worker is polling and how fresh its last tracker check
  is, so the operator can decide whether to wait, run `Check now`, or Stop/Start the worker.
- **Secondary goal.** Recover the exact timestamps when a relative time is not precise enough.
- **Arrival context.** The operator is watching the automation loop; the page header already names
  the lifecycle (`stopped`, `idle`, `running`, `paused`, `failed`) in a badge.
- **Relationship to other pages.** The same worker's queue, running agents, and run history are
  the other panels; failures and notices render in the Automation body.
- **Journeys.**
  - *Confirm the loop is live.* Open Issues → read the Automation subtitle → `Every 2s · checked
    2s ago` with a success dot → continue. Failure route: the worker is paused or stopped, the
    line says so in words, and the operator decides whether to Resume/Start.
  - *Diagnose a stalled poll.* Failure reaches the body as an error line; the subtitle reads
    `Poll failing · checked 5m ago` and the dot takes the error tone. Rate limiting reads
    `Rate limited`, not a generic failure. A check older than three intervals reads `Check
    overdue`, so a dead loop never keeps a success dot. Hovering the line reveals interval, last
    check, and next check as exact timestamps.
- **Non-goals.** Changing the poll interval, adding controls, replacing the lifecycle badge,
  exposing internal provider errors in the subtitle.
- **Assumptions.** Browser and worker clocks agree closely; a future timestamp is clock skew and
  reads `just now`.

## Information inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| P1 | Poll is on, paused, stopped, failing, or rate limited | snapshot `enabled`/`paused`/`lifecycle`/`poll.error`/`poll.rateLimitedUntil` | both | yes | yes | The one fact that decides wait vs act. |
| P2 | Poll cadence (`Every 2s`) | `poll.intervalMs` | confirm live | yes | yes | Distinguishes a 2s console loop from a long interval. |
| P3 | Freshness of the last check (`checked 5s ago`) | `poll.lastPollAt` | both | yes | yes | Proves the loop is actually running, not merely enabled. |
| P4 | Relative time ticking every second | client clock | both | yes | yes | A static `now` would lie after the first render. |
| P5 | Exact last/next timestamps | `poll.lastPollAt`, `poll.nextPollAt` | diagnose | yes | yes, in the tooltip | Precision needed on demand, not in the header. |
| P6 | Next poll instant in the subtitle | `poll.nextPollAt` | confirm live | no | removed | Derived from P2/P3 and already in the tooltip; it made the line long and duplicated the cadence. |
| P7 | Raw ISO strings in the subtitle | `poll.lastPollAt` | — | no | removed | Machine form in the operator's header; relative time is the readable form. |
| P8 | Poll error text | `poll.error` | diagnose | yes | stays in body | The body already owns the full diagnostic; the subtitle carries only the state word. |
| P9 | Whether the last check is overdue | `lastPollAt` vs `intervalMs` | both | yes | yes | A green dot on a dead loop would be a false claim. |

## Significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Goal | Action | Frequency | Unique | Risk | Score | Priority |
|---|---:|---:|---:|---:|---:|---:|---|
| P1 | 5 | 4 | 5 | 5 | 3 | 91 | P0 |
| P3 | 5 | 4 | 5 | 4 | 2 | 87 | P0 |
| P2 | 4 | 3 | 4 | 3 | 1 | 72 | P1 |
| P4 | 4 | 3 | 4 | 3 | 1 | 72 | P1 |
| P5 | 3 | 3 | 2 | 4 | 1 | 62 | P1 (tooltip) |
| P9 | 5 | 4 | 3 | 5 | 3 | 87 | P0 |
| P6 | 2 | 1 | 3 | 1 | 1 | 36 | drop |
| P7 | 1 | 1 | 2 | 1 | 1 | 27 | drop |

## Structure

One inline line at the right end of the existing Automation panel header, after the `Automation`
title: a 6px state dot then one 11px `muted-foreground` label, separated by 6px. Order is state
statement first, cadence and freshness second, so the decision word survives truncation. The label
never wraps; the header ellipsizes it when the panel narrows. The dot is decorative (`aria-hidden`),
and every tone is also a word (`Not polling`, `Polling paused`, `Rate limited`, `Poll failing`,
`Check overdue`, `Every 2s`), satisfying the design system's rule that color never carries meaning
alone. The element is not interactive; its `title` carries interval, last check, and next check as
exact ISO timestamps. No loading, empty, or permission states exist beyond `Starting up` and `Not
polling`; the whole line is absent only while the Issues page is not mounted.

The states map to the existing token pairs: active → `success` dot; paused, rate limited, and
overdue → `warning`; failing → `error`; stopped or starting → `border-strong`. Type, spacing,
radius, and colors are existing tokens; no new token, component, OpenUI entry, or Storybook story
is needed. Step 4 decision: compose in place from the existing panel subtitle and the existing
status-dot pattern (`.status-dot`, `.status-issues__dot`). No design-system mutation was made, so
the designmd research receipt rule is not triggered.

## Implementation

- `client/lib/poll-status.ts` — `pollStatus(snapshot, now)` returns the tone, the human text, and
  the exact-timestamp tooltip; `pollInterval` and `pollAge` keep the two formulas in one place.
- `client/lib/components/IssuesWorkspace.svelte` — derives the line from the snapshot, ticks `now`
  every second on the Overview and Agents pages, and renders the dot, label, test ids, and title.
- `client/app.css` — `.issues-poll` layout and `.issues-poll__dot` tone rules, tokens only.
- `scripts/verify-interface.ts` — browser assertions for the stopped line and the running line
  (text, tone, tooltip, 6px dot).

## Validation

Commands run from `.worktree/issue-226/.devboard`:

```bash
bun install --frozen-lockfile
bun test client/lib/poll-status.test.ts
bun run build
bunx tsc --noEmit
bun run check
bun run verify:interface
```

Evidence (filled by the run):

| Check | Viewport | Evidence | Result |
|---|---|---|---|
| Unit: interval, age, active, overdue, limited, failing, paused, stopped, starting, clock skew, invalid timestamps | — | `bun test client/lib/poll-status.test.ts` — 12 pass | pass |
| Full harness suite | — | `bun test` — 548 pass, 0 fail | pass |
| Build, types, Svelte diagnostics | — | `bun run build`, `bunx tsc --noEmit`, `bun run check` — 0 errors, 0 warnings | pass |
| Stopped worker reads `Not polling` | 1440×900 | `verify:interface` assertion | pass |
| Running worker reads `Every 2s · checked …`, success tone, exact tooltip, 6px dot | 1440×900 | `verify:interface` assertion | pass |
| No collision with `Automation`, dot inside the 30px header, label not clipped | 1024×720 | `verify:interface` assertion; `issues-poll-1024x720.png` | pass |
| Dark rendering | 1440×900 | `issues-poll-dark.png` | pass |
| Light rendering | 1440×900 | `issues-poll-light.png` | pass |
| Console errors and failed requests | 1440×900 | `verify:interface` final check | pass |

State coverage outside the seeded browser run: `Check overdue`, `Rate limited`, and `Poll failing`
are covered by the unit test, because the browser fixture publishes a live poll with no provider
error. The browser run drives the default (dark, 1440×900), narrow (1024×720), and light states of
the changed element.

Spacing audit: 6px dot, 6px gap, 11px subtitle, header padding 0 8px — all existing values on the
approved scale. No animation is introduced. Mobile is not applicable: the supported viewport is
1024×720 or larger.

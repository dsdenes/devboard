# Auto Scout — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Page identity and actions | Reuse | `PageHeader` | `stories/page-header.stories.ts` | eyebrow, title, subtitle, meta badges, one action; truncates a long title | native `header`, sole `h1`, action group | existing page-header, spacing, typography |
| Start/Stop control | Reuse | `Button` | `stories/design-system.stories.ts` | `default` while stopped, `destructive` while attached; disabled when the socket is closed or the server refuses | native button, focus ring, disabled opacity | button-primary and destructive |
| Lifecycle badge | Compose | — (`.badge` CSS primitive) | design-system overview specimens | `data-tone` from `statusTone(lifecycle)`; words `stopped`, `idle`, `scanning`, `failed` | word carries meaning, colour is redundant | success, warning, error, border-strong |
| Read-health badge | Compose | — (`.badge` CSS primitive) | design-system overview specimens | `data-state` = ok/error/stale, `data-tone` from the same state; text `GitHub read <state>` | word carries meaning | success, warning, error |
| Last-read timestamp | Compose | — | — | `sync.at` or `never`; formatted local date/time with the raw value in `title`; stable across a failed read | visible text, mono | mono-small |
| Worker facts | Compose | — (definition list) | — | pending count 0–many; worker pid/version or `none`; next attempt formatted or `none`; empty and long values | `dl`/`dt`/`dd` semantics; wraps without overflow | muted, mono, spacing |
| Limit inputs | Reuse | `Input` | `stories/design-system.stories.ts` | integers 1–100, invalid values, empty, 2 digits and 3 digits; 28px height | wrapping `label`, numeric input mode, range attributes | input component; border-strong |
| Save limits | Reuse | `Button` | `stories/design-system.stories.ts` | secondary; enabled while connected; validation failure keeps the last saved values | native button, focus ring | button-secondary |
| Limits alert | Compose | — (`.issues-error`) | — | visible validation message; `role="alert"` | announced, not colour-only | error, error-surface |
| Filed issues table | Compose | — (`.panel` + table markup) | — | zero, one, many rows; long titles ellipsize with tooltip; pending/implemented badges; missing category/version render `—`; body scrolls | column headers, link text, badge words | panel, table, badge, mono, row-hover |
| Empty table | Compose | — | — | centered 20px inbox mark above a 13px/600 title and one 12px explanatory line; max 360px; not focusable | decorative mark is `aria-hidden`; title and copy are plain text | muted, spacing |
| Activity log | Reuse | — | — | `IssuesAgentLog` with empty state; appends live; follows the newest line unless scrolled up | `pre` text, command rows keep their `$` prompt | activity log styles, accent-surface |
| Alert banner | Compose | — (`.issues-error`) | — | sync error, worker error (`role="alert"`) | announced; sits before the panels in reading order | error/warning surfaces |

## Component details

### PageHeader
- Decision: reuse unchanged.
- Why: every other Issues page uses it, and it supplies the one `h1`, meta row, and
  right-aligned actions this page needs. The bespoke `issues-overview__header` duplicated
  those rules with a smaller title and no action slot.
- Real API: `.devboard/client/lib/components/ui/page-header.svelte`; `eyebrow`, `title`,
  `subtitle`, `meta`, `actions`, `flat`, `testid`.
- States: only empty and populated states of the meta/actions; the header itself has no
  loading state.
- Edge cases: a long owner/repo or timestamp stays on the meta row and wraps; the action
  never wraps below the identity at 1024px.
- Tokens: existing page-header and badge tokens only.

### Button
- Decision: reuse two instances (the same control swaps label, variant, and testid).
- Why: Start and Stop are one state-dependent action, and the primitive already covers
  filled, destructive, and disabled states.
- Data/state: `scout.canStop` selects destructive Stop with `scout-stop`; otherwise
  default Start with `scout-start`. Disabled when neither flag is true.
- Edge cases: socket closed → Start disabled; an attached worker → Stop enabled.
- Accessibility: native button, visible focus, disabled non-interactive.

### Input
- Decision: reuse for both limits.
- Why: replaces the ad-hoc 24px input so the fields match the design-system control
  height and focus ring.
- Data/state: the component's text state is the source while typing; the snapshot's
  signature overwrites it only when the saved limits change.
- Edge cases: empty, `0`, `101`, non-numeric, pasted whitespace; the error covers all.
- Accessibility: the wrapping `label` names each field; `inputmode="numeric"`,
  `min`, `max`, `step` remain.
- Tokens: input component; no new tokens.

### Panels, table, and activity log
- Decision: compose existing `.panel`, `.badge`, table markup, and `IssuesAgentLog`.
- Why: these are already the shared page vocabulary; a new card or table component would
  have a single consumer.
- Edge cases: zero/many rows; long titles; pending/implemented; missing category/version;
  empty and long activity logs; 1024px single-column layout.
- Accessibility: panel headings (`h2`), table headers, link names, log text.
- Storybook/OpenUI: unchanged. No shared component API or token is modified.

## Storybook / catalog action
- No design-system mutation. `PageHeader`, `Button`, and `Input` already have catalogue
  entries and stories; `.badge`, `.panel`, table, and log styles are documented
  primitives, not OpenUI components. No story or catalogue edit is required.

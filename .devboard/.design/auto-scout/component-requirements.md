# Auto Scout — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Page identity and actions | Reuse, `bar` layout | `PageHeader` | `stories/page-header.stories.ts` | eyebrow, title, subtitle, meta badges, the filing limits, and one action on one band; title and repository truncate | native `header`, sole `h1`, limits group, action group | existing page-header, spacing, typography |
| Start/Stop control | Reuse | `Button` | `stories/design-system.stories.ts` | `default` while stopped, `destructive` while attached; disabled when the socket is closed or the server refuses | native button, focus ring, disabled opacity | button-primary and destructive |
| Lifecycle badge | Compose | — (`.badge` CSS primitive) | design-system overview specimens | `data-tone` from `statusTone(lifecycle)`; words `stopped`, `idle`, `scanning`, `failed` | word carries meaning, colour is redundant | success, warning, error, border-strong |
| Last-read timestamp | Compose | — | — | `sync.at` or `never`; formatted local date/time with the raw value in `title`; stable across a failed read; the sync error banner carries the read state | visible text, mono | mono-small |
| Worker facts | Compose | — (definition list) | — | pending count 0–many; worker pid/version or `none`; next attempt formatted or `none`; empty and long values | `dl`/`dt`/`dd` semantics; wraps without overflow | muted, mono, spacing |
| Limit inputs | Reuse | `Input` | `stories/design-system.stories.ts` | header group: inline labels, integers 1–100, invalid values, empty, 2 digits and 3 digits; 28px height, 56px width | wrapping `label`, numeric input mode, range attributes | input component; border-strong |
| Save limits | Reuse | `Button` | `stories/design-system.stories.ts` | secondary, in the header group; enabled while connected; validation failure keeps the last saved values | native button, focus ring | button-secondary |
| Limits alert | Compose | — (`.issues-error`) | — | header group, full row under the controls; visible validation message; `role="alert"` | announced, not colour-only | error, error-surface |
| Filed issues table | Compose | — (`.panel` + table markup) | — | zero, one, many rows; long titles ellipsize with tooltip; pending/implemented badges; missing category/version render `—`; body scrolls | column headers, link text, badge words | panel, table, badge, mono, row-hover |
| Empty table | Compose | — | — | centered 20px inbox mark above a 13px/600 title and one 12px explanatory line; max 360px; not focusable | decorative mark is `aria-hidden`; title and copy are plain text | muted, spacing |
| Activity log | Reuse | — | — | `IssuesAgentLog` with empty state; appends live; follows the newest line unless scrolled up | `pre` text, command rows keep their `$` prompt | activity log styles, accent-surface |
| Alert banner | Compose | — (`.issues-error`) | — | sync error, worker error (`role="alert"`) | announced; sits before the panels in reading order | error/warning surfaces |

## Component details

### PageHeader
- Decision: reuse with `layout="bar"`.
- Why: one operational band reads as a status header. The title and repository sit on one
  line while the lifecycle badge, last read, filing limits, and Start/Stop share the
  trailing edge, so the budget and the action it qualifies sit beside the state instead of
  in a second column under the title.
- Real API: `.devboard/client/lib/components/ui/page-header.svelte`; `eyebrow`, `title`,
  `subtitle`, `meta`, `actions`, `flat`, `layout`, `testid`.
- States: only empty and populated states of the meta/actions; the header itself has no
  loading state.
- Edge cases: a long owner/repo truncates without moving the trailing cluster; the limits
  group and the cluster wrap below the identity only when the workspace is too narrow for
  both, and the action never detaches from the state.
- Tokens: existing page-header, badge, and limits styles only.

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

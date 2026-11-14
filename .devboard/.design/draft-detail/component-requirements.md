# Draft detail — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Draft identity | Compose | — (`.panel` header region) | design-system overview specimens | heading empty → file name; long heading and long path truncate with full values in `title`; path is repo-relative | `h2` names the panel; path visible, not tooltip-only | panel-title, mono-small, spacing |
| Status badge | Compose | — (`.badge`) | design-system specimens | `running`, `stopped`, `succeeded`, `failed`; filtered to the selected draft's run; an idle draft renders no badge and no action group at all | word carries state; tone is redundant | badge, success, error, accent, border-strong |
| Start elaboration | Reuse | `Button` | `stories/design-system.stories.ts` | rendered once on each draft row, never in the detail header; `outline` at `sm`; disabled while that draft runs; tooltip carries the blocker; re-enabled after stop/failure | native button, focus ring, disabled 45% | button outline |
| Stop elaboration | Reuse + compose | `Button` (`ghost`) | `stories/design-system.stories.ts` | present only while this draft's run is live; 24px word; hover/focus takes error treatment | native button with visible label, `data-command` | error, error-surface, border-subtle |
| Error banner | Compose | — (`.issues-error`) | — | refused read, failed peer, retryable; `role="alert"` | announced; sits before content | error, error-surface |
| Question block | Reuse + generalise | — | — | message, 0–3 options, recommended flag, free-text answer; empty, long text, narrow width; answer clears on submit | option buttons are named by their label and description; wrapping `form`; labelled input | warning, warning-surface, choice styles |
| Activity log | Reuse | — | — | empty, one line, many lines, command rows; auto-follows newest unless scrolled up; only mounted while a run exists | `pre` text; command `$` retained | activity log, accent-surface |
| Proposal | Compose | — | — | leading H1 removed (header owns it), cut at the writer's capture section, long lines wrap, empty proposal | plain text block without a visible overline; section carries `aria-label="Draft"` | mono, body spacing |

## Component details

### Panel and header
- Decision: compose `.panel`, `.panel__header` conventions and page classes; no new primitive.
- Why: the detail is one panel of an existing two-column page. A dedicated component would
  have one consumer and duplicate the panel contract.
- Header height: 44px, matching the documented Flow goal header, because two identity lines
  and 28px controls cannot share a 30px row without clipping.
- Edge cases: a heading with no words, a 200-character heading, a path at the 1024px floor.
  The heading and path ellipsize; the action group never shrinks or wraps below the identity.
- Idle: the header renders the identity alone. The action group is mounted only while the
  selected draft's run status is not `idle`, and Stop only while it is `running`.

### Button
- Decision: reuse. Start is `outline` at `sm` and belongs to the draft row; Stop is `ghost` with
  the quiet-destructive class already documented for the running-agent close control.
- Data/state: the row's Start uses `disabled={issues.draftRunning(path)}` with `title` = blocker
  or the normal hint; the detail header carries no Start of its own.
- Accessibility: the visible labels are the accessible names; `data-command` preserved.

### IssuesQuestion (generalised from IssuesAgentQuestion)
- Decision: modify. Add `onanswer`, optional `runId`, and per-surface test ids/command.
- Why: the draft question and the agent question are the same grammar (message, exclusive
  option cards, recommended label, free-text answer). Two copies already drifted in test ids.
- States: no options, one option, recommended/unrecommended, long message, long option
  description, blank answer (submit disabled), submit resets the field.
- Integration: `IssuesAgentFocus` passes nothing new and keeps its current behaviour;
  `DraftsPage` answers through `goalDrafts.submitDraftAnswer` and passes the draft test ids.

### IssuesAgentLog
- Decision: reuse unchanged for the draft activity.
- Why: it already follows the newest line without fighting manual scrolling and highlights
  shell commands. The previous draft log was a plain `pre` with no follow behaviour.
- Mounted only while `draftRun` exists; the empty state is its own text.

## Design-system action
- No token, color, radius, typography, or primitive variant changes. `Button`, `Input`,
  `.panel`, `.badge`, `.issues-error`, `.issues-activity`, and the choice styles are reused.
- `openui.json`: unchanged; the generalised question form is not a catalog primitive.
- Storybook: unchanged; no primitive API used by the stories changes.
- No `designmd` mutation receipt is required because no design-system artifact changes.

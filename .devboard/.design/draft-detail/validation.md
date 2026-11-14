# Draft detail — validation

- Page: `/` → Issues → Draft goals → second panel (`section.issues-draft-detail`).
- Scope: the design record reconciled with the shipped panel. No product code, test, or
  design-system artifact was changed, so this pass ran no product UI gate; the earlier captures
  of the removed capture block were deleted with the regions they showed. The rewritten
  wireframe was rendered once at 1200×1000 to confirm its own layout.
- Source of truth:
  - `.devboard/client/lib/components/DraftsPage.svelte:251-339` — header, optional alert,
    question, proposal, activity.
  - `.devboard/client/lib/components/DraftsPage.svelte:271-295` — the action group renders only
    while `status !== "idle"`, and Stop only while `running`.
  - `.devboard/client/lib/draft-format.ts:75-79` — `draftProposal` cuts the draft at the writer's
    capture section and strips the leading H1.
  - `.devboard/crates/devboard/src/goal_proposal.rs:21` — `UNPROCESSED_NOTICE`, the proposal's
    first line.
  - `.devboard/client/app.css:3916-4060` — panel, header, section, and quiet Stop styles.
- Commands declared in `.devboard/package.json` and run from `.devboard` when the change itself
  needs them:
  - `bun run build` — client bundle and the embedded-asset copy.
  - `bun run check` — `svelte-check` over the client.
  - `bun run test` — the workspace test runner.
  - `bun run test:client` — the client unit suite.
- What this pass checked instead: the three state rules the record states were read from the
  component above (`{#if status !== "idle"}`, `{#if running}`, `{#if run !== null}`), the
  proposal copy was compared with `UNPROCESSED_NOTICE`, and the acceptance searches over
  `.devboard/.design/a2ui/draft-detail.*` and `.devboard/.design/draft-detail/` were run for the
  removed region and for every script the record names.

## Journeys exercised

The panel and these journeys shipped in #275 and its follow-ups; this pass re-read the record
against the source instead of re-running them. What a reviewer reads:

- Review a draft: header identity, then the proposal without its leading H1 and without the
  writer's capture section.
- Start, question, answer: start a draft from its row, see the question above the proposal and
  the activity log, answer an option, see the draft leave the list and the spec written.
- Status scoping: while one draft runs, an idle draft's header stays bare and its row Start
  stays enabled.
- Stop: start a draft, see `Stop` beside the `running` badge, stop it, see `stopped` with no
  Stop and its row Start re-enabled.
- Refresh/reload: the report-panel write appears without reload; a reload restores the selected
  path.
- Read refusal / vanished draft: the page clears the selection and shows the list, or reports
  the refusal in the panel's alert.

## States

| State | Source | Surface |
|---|---|---|
| Idle | `DraftsPage.svelte:271` | identity only: no badge, no Stop; row Start |
| Another draft running | `DraftsPage.svelte:32-36` | as idle here: the run is filtered by this draft's path |
| This draft running | `DraftsPage.svelte:271-295` | `running` badge, quiet Stop, activity section |
| Question pending | `DraftsPage.svelte:300-317` | warning block above the proposal and the log |
| Stopped | `DraftsPage.svelte:271-295` | `stopped` badge, no Stop, activity retained |
| Failed | `DraftsPage.svelte:297-299` | `failed` badge and the alert with the server reason |
| Empty proposal | `DraftsPage.svelte:318-323` | `This draft holds no proposal text yet.` |
| No selection | `DraftsPage.svelte:340-353` | the detail column's selection stack |

## Spacing and accessibility

- Spacing uses the approved scale only: 2/4/6/8/12/16/24/28 px. The 44px header matches the
  documented Flow goal header; 24px is the documented quiet-destructive control height. Radius
  3/4px, panel and badge rules unchanged.
- One `h1` (page), panel `h2`, question `h3`, activity overline `h3`; native buttons and form.
- Status is written as a word; color is redundant. Focus rings come from the existing Button and
  Input primitives.
- The proposal section is labelled `aria-label="Draft"` and renders no visible overline; the
  question block is labelled `aria-label="Elaboration question"` and renders no visible label
  above its `h3`.

## Duplicate information

The proposal renders once, cut at the writer's capture section, with its H1 moved into the
header. The captured page facts and the inline evidence are not rendered on any surface. The
nested `Activity` header and its run path are gone.

## Wireframe

`.devboard/.design/a2ui/draft-detail.a2ui.jsonl` and `draft-detail.wireframe.html`, rendered
state `running` with a pending question: the header carries the `running` badge and Stop, the
question block sits above the proposal, and the activity section follows it. The region
annotations state where the action group and the activity section are absent: the group at idle,
Stop outside `running`, activity without a run. Both files carry no page facts, Visible text, or
DOM excerpt.

## Not run / blocked

- Product UI gates (`bun run build`, `bun run check`, `bun run test`, `bun run test:client`):
  this change edits design records only; no code those gates compile or exercise changed.
- Browser pass: not required for a documentation reconciliation; the record names the source
  lines each state claim came from.
- Product mobile layout: the shell declares 1024×720 its minimum and renders the
  unsupported-viewport notice below it.
- Storybook: no OpenUI primitive, token, or story changed.
- `designmd` research: not required; no design-system artifact was mutated.

## Verdict

reconciled with the shipped panel.

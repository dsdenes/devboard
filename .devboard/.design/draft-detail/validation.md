# Draft detail — validation

- Page: `/` → Issues → Draft goals → second panel (`section.issues-draft-detail`).
- Branch: `issue-275` in `.worktree/issue-275`.
- Commands run from `.devboard`:
  - `bun install --frozen-lockfile`
  - `bun run build`
  - `bun run check` — 0 errors, 0 warnings.
  - `bunx tsc --noEmit` — pass.
  - `bun test` — 630 pass, 0 fail (includes `client/lib/draft-format.test.ts`).
  - `bun run verify:interface` — passed after integrating `origin/main`: shell, modes, sidebar,
    pages, splits, palette, keyboard, theme, tables, editors, terminals, accessibility,
    notifications, status bar, issues mode, ask transcript, persistence, and boundary.
- Playwright source: the project's `@playwright/test` Chromium driven by
  `scripts/verify-interface.ts`, plus OMP browser Playwright for the live draft and wireframe.
- Viewports: 1440×900 and 1024×720 (the shell's supported floor). The wireframe additionally
  rendered at 390 px to prove its own responsiveness; the product has no mobile layout.

## Journeys exercised

- Review a draft: open the report-written draft, read the proposal before the marker, read the
  five captured facts and the inline Visible text and DOM excerpt, and open the exact source.
- Read a draft without captured context: 001-question shows `No captured UI context.`.
- Start, question, answer: start 001-question, see the question above the activity log, answer
  an option, see the draft leave the list and the spec written.
- Status scoping: while 001-question runs, 002-hang shows `idle`, not `running`.
- Stop: start 002-hang, see `Stop`, stop it, see `stopped` and Start re-enabled.
- Refresh/reload: the report-panel write appears without reload; a reload restores the selected
  path and its exact bytes.
- Read refusal / vanished draft: the suite's refused-path and missing-file checks pass.

## States exercised

| State | Evidence | Result |
|---|---|---|
| Idle with captured context, dark | `idle-dark-1440.png` | heading + path, idle badge, Start; proposal, five facts, inline evidence, collapsed source |
| Idle with captured context, light | `idle-light-1440.png` | same content; labels and borders hold in the light palette |
| Question pending and running | `question-dark-1440.png` | warning question block above the proposal and log; disabled Start; quiet Stop; activity follows |
| Question pending at the floor | `question-dark-1024x720.png` | header fits, title truncates, no horizontal overflow |
| No captured context | `verify:interface` assertion | `No captured UI context.` |
| Stopped / failed | `verify:interface` assertions | `stopped` badge, Start re-enabled; error banner path covered |

## Dependent pages

`IssuesQuestion` is the generalised `IssuesAgentQuestion`; the component is also rendered by the
Issues overview output panel, the Agents page cards, and the agent focus tab. `verify:interface`
exercises all three (agents grid, overview output, focus tab, answer flow) after the change and
reports them passing; their test ids and store submit path are unchanged.

## Spacing and accessibility

- Spacing uses the approved scale only: 2/4/6/8/12/16/24/28 px. The 44px header matches the
  documented Flow goal header; 104px is the documented fact-label column; 24px is the documented
  quiet-destructive control height. Radius 3/4px, panel and badge rules unchanged.
- One `h1` (page), panel `h2`, section `h3`, evidence `h4`; native `dl`/`dt`/`dd` for facts,
  one native `details`/`summary` for the source, native buttons and form.
- Status is written as a word; color is redundant. Focus rings come from the existing Button and
  Input primitives. The exact bytes stay selectable in the source block.

## Duplicate information

The previous detail rendered the captured context once as its own box and again inside the whole
draft. Now the structured facts and inline evidence are the only visible copy; the byte-exact
source is a collapsed disclosure required by the README contract. The heading lives in the header only and
is stripped from the proposal body. The nested `Activity` header and its run path are gone.

## Wireframe

`.devboard/.design/a2ui/draft-detail.a2ui.jsonl` and `draft-detail.wireframe.html`; rendered at
1440 and 390 px (`wireframe-1440.png`, `wireframe-390.png`). Scroll width equals client width at
both sizes; the primary action stays visible.

## Console and network

No runtime page error in the exercised states. The suite itself briefly shows a
`Not connected to the server` toast during its reconnect check; the evidence helpers dismiss
notifications before capture, so the screenshots show the surface only.

## Not run / blocked

- Product mobile layout: the shell declares 1024×720 its minimum and renders the
  unsupported-viewport notice below it.
- Storybook: no OpenUI primitive, token, or story changed. `IssuesQuestion` is a page component,
  not a catalog primitive.
- `designmd` research: not required; no design-system artifact was mutated.

## Verdict

pass.

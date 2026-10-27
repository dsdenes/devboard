# Operator UI tweaks — brief, decisions, validation (2026-10-27)

One batch of operator reports (`#191`–`#201`) over the same operator console. No new page and no
new information architecture: each report corrects a specific surface the operator was looking at.

## Journeys the batch serves

- **Read the testing posture of a repository.** Arrive on Discover → Testing card → read total,
  level count, happy-path share, the whole-suite invocation, and the command per level. Decision:
  whether the suite is worth trusting and which command runs the level under review.
- **Resume work on one decision record.** Goal → ADRs → open a record. The header must state the
  document status once, in color and in words, without a duplicate resolved/pending badge and
  without a "Next" fact that repeats the header marker.
- **Reset an implementation.** Goal → Implementation → Danger zone. The panel must read as
  destructive before the button is pressed.
- **Inspect a prepared skill.** Goal → Skills → disclosure → click a skill. Decision: what the
  agent will be told, without leaving the interface.
- **File a UI issue.** Any page → activity bar → report control. The control must be part of the
  application menu, not a floating pill over the workspace.
- **Scan the left menu.** The three modes and the four application actions must share one visual
  grammar; navigation items must not look like dropdowns.

## Information decisions

| Report | Decision |
|---|---|
| #191 facts column | Widen the Discover facts track to 260–340px; the facts are the sheet's index and its labels were wrapping. |
| #192 menu icons | Drop decorative leading chevrons from Flow navigation. Keep the Skills disclosure chevron: it toggles a group and is the only affordance for it. |
| #193 Close button | Remove the ADRs header's Close control; closing stays available through the palette command and tab semantics. |
| #194 status badges | One status badge, colored by meaning, word always present. The resolved/pending badge duplicated "Accepted" and is removed. |
| #195 Next fact | Remove the `Next` row from the record facts; the header already carries the Next marker and the ADR list marks the record. |
| #196 skill click | Selecting a skill opens its SKILL.md in a read-only panel, with the name and description as the panel header. |
| #197 danger zone | Use the error pair the design system already owns: error border, error-surface header, error title, `Destructive` error badge. |
| #198 menu padding | Widen the rail to 72px and the mode tabs to 64×52px with 6px/4px padding so labels stop touching the tab edge. Values stay on the approved scale. |
| #199/#200 testing detail | Show happy-path share and per-level counts; show the declared invocation for the whole suite and each level (`npm test`, `npm run <script>`); keep the recorded program as the command's tooltip. |
| #201 report control | Move the trigger into the activity-bar application actions; the overlay keeps its selection mode and panel, and its phase drives the control's pressed state. |
| #202 project path removal | Superseded by #205 (same element, 38 seconds later): removal and redesign cannot both hold. The element is redesigned, not deleted. |
| #203/#204 mode status | Remove the active-mode status from the status bar: the sidebar and workspace already state it, and the status bar is 26px of global facts. #204 is the same report as #203. |
| #205 project path redesign | The status bar names the project (last path segment) with a folder mark and the full path in the tooltip; the empty tail is closed by a spacer so counts, versions, and reload align right. |
| #206 sidebar identity | Remove the 44px sidebar title block: the mode is named in the rail and the project in the status bar, so it repeated both. |
| #207 facts rail width | The Discover facts track grows to 320–420px so the facts column balances the content column. |
| #208 command placeholders | The `N of 8 found` count becomes a disclosure: expanding it lists all eight command slots, and an unrecognized slot renders a muted `not found` placeholder with the unknown reason in its title. |
| #209 command presentation | One inline code chip (`.code-chip`) for every command, path, package, and boundary value: mono-small, background fill, subtle border, 3px radius, 2px/6px padding. Commands carry a `$`; paths do not. The older plain row, tinted suite chip, and borderless context chips are gone. |

## Structure

No region changed order. The Discover Testing card gained one stat and two table columns; the
record header lost a badge and the facts list lost a row; the Skills page gained one panel below
its list; the activity bar gained a fourth action; the rail geometry grew by one step.

## Validation

Commands, run from `.devboard` in the worktree:

```bash
bun run build
bunx tsc --noEmit
bun run check            # svelte-check: 0 errors, 0 warnings
bun test                 # full harness suite
bun run verify:interface # headless Chrome, seeded host, 1440×900 and 1024×720
```

`verify:interface` is the browser evidence: it seeds an ADR set and a Discover crawl, drives the
built bundle in headless Chrome, and asserts, among the existing checks:

- the mode tabs measure 64×52 inside the 72px rail and their labels never leave the tab;
- the activity-bar report control enters picking mode, sets `aria-pressed`, and cancels itself;
- the Discover testing table headers are `Level | Tests | Happy path | Command`, the suite line
  reads `npm test`, a level command reads `$ npm run test:unit`, the happy-path stat reads `100%`,
  and the facts rail is at least 260px wide;
- the Flow workspace group renders no icons inside its navigation items;
- the decision-records header has no close button, the record header shows one `Accepted` badge
  with tone `success`, and the record facts carry no `Next` term;
- the danger zone carries an `error` badge and a tinted header distinct from its border;
- clicking a prepared skill renders its document (`skill-content-name` equals the clicked name and
  `skill-content-text` is non-empty);
- the status bar shows the project's last path segment with its folder mark and the full path in the
  item's title, carries no `status-mode` item, and right-aligns its tail (versions end within 48px
  of the bar's right edge);
- the sidebar renders no mode/project header;
- the Discover facts rail measures at least 320px, every command row draws the shared `.code-chip`,
  the suite line and a bounded-context path draw the same chip, and expanding `N of 8 found`
  renders eight rows with `not found` placeholders whose titles carry the reasons, then collapses
  back to the found rows.

Screenshots written by the same run: `.devboard/.tmp/interface/discover-overview.png`,
`goal-overview.png`, `flow-overview.png`, `1024x720.png`.

Not run: a mobile layout check — the supported viewport is 1024×720 or larger and the shell has no
mobile scale.

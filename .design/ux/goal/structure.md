# Goal mode — structure

One shell, six pages. The shell is shared with Flow and Discover; the pages replace one another
inside the Goal workspace. Exactly one page is visible at a time, and the active page survives a
mode switch and a reload.

## Shared shell (common menu)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_mode_rail | Vertical app menu: three modes, then app actions | 1–13 | C30, C32, C33, C34 | P0/P2 |
| 2 | region_sidebar | Goal navigation: context header, Plan, Run, ADR records, Lanes | 1–13 | C11, C24, C37, C38, C20 | P0/P1 |
| 3 | region_workspace | The active Goal page | 1–13 | page regions | P0 |
| 4 | region_status_bar | Ambient connection, project, mode status, versions | all | C28, C29, C12, C31 | P2 |

The rail is one column: the mode tabs keep their 56×48px icon-over-label shape and gain a state
dot (no text) whose accessible name states the mode's work state. Below a divider, three 28px
ghost icon buttons — commands (`Ctrl+K`), notifications, theme — form the app menu. The rail is no
longer a bare tablist; the tabs sit in their own `role="tablist"` group so the footer buttons are
not mistyped as tabs.

The sidebar identity keeps the mode over the repository path: the shell contract requires the sidebar
to name the repository for every mode, so this is a deliberate repetition of the status bar's full
path. Goal operating context lives next to the page it describes: the Run entry states the
lifecycle stage or `manual`/`idle`, and the ADRs entry states the pending count.

Sidebar sections, top to bottom:

1. **Plan** — Goal document (ready/unsaved), ADRs (pending count), Skills (prepared count with a
   disclosure listing each prepared skill).
2. **Run** — Implementation (current stage), no separate "Overview" alias.
3. **ADR records** — a progress line, the next record, every pending record, and an "All records"
   entry. Resolved records are not listed here; the ADRs page owns them.
4. **Lanes** — running/total count in the group head, then one row per lane with its status badge.

## Implementation page (`overview`)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_notice | Error, upgrade, stopped, and operation notices | 13, 9, 1 | C26, C27, C2, C3, C8 | P1 |
| 2 | region_header | Eyebrow `Goal`, title `Implementation`, stage summary, action group | 4, 5, 9 | C12, C16, C10 | P0 |
| 3 | region_stage | Stage track: Goal → Epics → ADRs → Implementation → Finished, with pass, pause, current work link | 4, 5, 9 | C12, C13, C14, C15 | P0 |
| 4 | region_question | The queued question with options and free text | 6, 4, 7 | C19 | P0 conditional |
| 5 | region_now | What is running now: a manual run's identity and verb | 7, 9 | C17 | P1 |
| 6 | region_activity | Current action terminal plus folded history | 1–9 | C18 | P1 |
| 7 | region_danger | Reset disclosure: rule text, arm, confirm, result | 10, 13 | C25, C39 | P1 |

Primary action: `Start implementation` (filled) or `Stop implementation` (filled destructive) —
never both. `Resolve next ADR` is an outline button beside it. `Pause`/`Resume` is one secondary
button whose label follows the paused state; the palette still offers both commands. A queued
question renders directly under the header, before the stage track, and also above every other
Goal page, because the run cannot advance until it is answered. The sidebar's Run entry carries an
`answer` badge whenever a question waits.

Desktop layout: full-width header and stage track, then the activity panel fills the remaining
height. The danger zone is the last panel of the scroll column, below the activity panel, so it is
never adjacent to the primary action; its warning and confirm step appear only after the reset is
armed.

## ADRs page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_adr_header | Eyebrow `Plan`, title `Decision records`, progress line, Close | 11 | C11, C10 | P0 |
| 2 | region_adr_filters | Search field and All / Pending / Resolved filter | 11 | C9 | P1 |
| 3 | region_adr_table | Dense record table | 11, 12 | C9, C10 | P0 |
| 4 | region_adr_empty | No records, or no match with a reset action | 11 | C11 | P1 conditional |

The table keeps six facts per row: title (with a `Next` badge instead of its own column), document
status, implementation state, file, decision summary, and the start action. Rows stay 28px. The
record page repeats the file only because it is the record's raw identity.

## ADR detail page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_record_header | Back to records, title, document status, implementation state, Next badge | 12 | C9, C10 | P0 |
| 2 | region_record_meta | File, document status, implementation state | 12 | C9 | P1 |
| 3 | region_record_decision | Decision summary | 12 | C9 | P0 |
| 4 | region_record_action | Start, only while pending | 12, 7 | C9, C10 | P0 conditional |

File, state, and next marker appear once: in the header badges and the metadata row. The header
does not repeat the file name.

## Goal document page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_doc_header | Title, saved/unsaved/read-only state, operation state; Save, Recreate, Skills | 1, 2, 3 | C1, C2, C3, C5 | P0 |
| 2 | region_doc_editor | The Monaco goal editor | 1, 3 | C1 | P0 |
| 3 | region_doc_revision | Revision guidance field and Revise | 3 | C4 | P1 |

Primary action: `Save goal`. `Recreate goal` is secondary. `Skills` replaces itself with
`Show skills (N)` once skills exist; the page does not repeat the skills list. The page scrolls and
reserves 56px at its bottom so the revision field can scroll clear of the fixed notification region
and report control.

## Skills page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_skills_header | Title, readiness (prepared count or none), Prepare again, Close | 2 | C5, C8 | P0 |
| 2 | region_skills_list | One accordion row per skill: name and description; expanded row opens its document inline; the panel body owns the scroll | 2 | C5, C6 | P0 |
| 3 | region_skills_contradictions | Contradiction warnings, or a "no contradictions" line | 2 | C7 | P1 |
The expanded row is specified in `.design/ux/goal-skill-detail/`: its file path sits above a
rendered Markdown document, the frontmatter is not shown, and no separate detail panel exists.

Primary action: `Prepare skills` / `Prepare skills again` (secondary when skills exist). The
sidebar disclosure is the fast path to one skill; the page is the audit surface.

## Lane page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_lane_header | Lane label, status badge, attempt, Close | 8 | C20, C22 | P0 |
| 2 | region_lane_identity | Kind, record or epic title, upstream link | 8 | C21 | P1 |
| 3 | region_lane_question | The lane's queued question | 8, 6 | C22 | P0 conditional |
| 4 | region_lane_activity | Current action and folded history | 8 | C22 | P1 |

## Fallback page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_workspace_empty | "No page is open" plus one control to open Implementation | all | C36 | P3 |

## Primary action per screen

| Screen | Primary action |
|---|---|
| Implementation, idle | `Start implementation` |
| Implementation, running | `Stop implementation` (filled destructive) |
| Implementation, paused | `Resume` (secondary) and `Stop implementation` (filled destructive) |
| ADRs, records page | none; search and filters only; rows open |
| ADR detail, pending | `Start` |
| Goal document | `Save goal` |
| Skills | `Prepare skills` when none; otherwise no filled action |
| Lane | none; the question's answer is the action |
| Fallback | `Open implementation` |

## State coverage

- **Loading (socket closed):** every dispatch control is disabled and its title names the
  connection; the last known stage, records, and activity stay readable; the status bar reports
  the disconnection. No skeleton and no layout shift.
- **Empty:** no records shows `No records yet` with how records arrive; no skills shows the
  prepare action and the lifecycle start remains disabled with its reason; no lanes shows an empty
  line under the group.
- **Error:** one `.message` with `role="alert"` at the top of the page. The working state below it
  stays readable. The reset failure reports its own status line in the danger zone.
- **Partial:** a lifecycle that has never reported a non-`goal` stage renders the stage track at
  `Goal` with `not started`; it never claims progress. A record without a summary says `No decision
  summary recorded.` rather than an empty row.
- **Permission-denied:** not applicable; refusals come from run state and are shown as disabled
  controls with a reason, or as one error after the fact.
- **Success:** stage `finished`, zero pending records, zero open lanes; the start control is
  available again and the activity panel keeps the last action.
- **Busy:** one of the five exclusive slots (creation, revision, skills, manual run, lifecycle)
  drives a single operation banner and disables the controls the other slots own. The banner never
  duplicates the activity panel.
- **Paused:** the stage track marks the current stage paused, Resume becomes available, and the
  goal editor becomes editable.
- **Stale/unknown tab:** a record or lane that disappeared shows a single "no longer listed" line
  with a way back to the list.

## Responsive order

- Supported viewport: 1024×720 minimum; the shell is replaced by the viewport guard below it.
- The rail stays 64px wide at every supported size and never collapses to icons only.
- The sidebar stays resizable 200–600px; its groups keep their order.
- At workspace widths below 900px the implementation page keeps one column: header, stage, question,
  now, activity. The stage track drops explanatory lines and keeps the five stage names, pass, and
  the current work link.
- The ADR table drops the decision-summary column below 900px of workspace width; the row keeps
  title, statuses, next, file, and action. The record page still shows the summary.
- No page scrolls horizontally at 1024×720 or 1440×900; panels own their scroll.

## Rationale

- **The lifecycle is the spine.** Stage, pass, paused, and the current work item answer "what is
  happening now" and "can I act"; they earn the page header rather than a row of counters. A stage
  track is the cheapest shape that shows both order and position, and it makes `finished` legible.
- **One filled action.** The shipped header put two filled primaries (`Start implementation` and
  `Resolve next ADR` in some states) in the same row and spread Pause and Resume as separate
  buttons. Start/Stop is now the single filled action; Resolve next ADR is the manual path and is
  visually secondary; Pause/Resume is one contextual button.
- **Destructive action moves to the end.** Reset was in a row with the lifecycle controls. It is
  irreversible, rare, and needs a second step, so it is the last panel after the activity panel —
  still one click from the page, never adjacent to Start.
- **ADR rows carry five facts, not seven.** `State` and `Status` were both badges plus a word, and
  `File` repeated what the detail page showed. The list keeps the decision-relevant facts; the
  record page owns the raw identity.
- **Sidebar is navigation, not a second page.** It no longer repeats every resolved record or the
  full skills list outside one disclosure. It shows progress, pending records with the next one
  marked, and lanes because those are the shortcuts an operator takes mid-run. The repository path
  stays because the shell contract puts the repository name in the sidebar identity.
- **The rail is the app menu.** Theme and notifications were floating in a 26px status bar while the
  command palette had no visible affordance. The rail now holds mode selection and the three app
  actions, with state dots so a failed lane or a stale Discover is visible from another mode.
- **Rejected alternative: a run dashboard of stat tiles.** Counts of lanes, epics, and ADRs would
  duplicate the sidebar and the progress line and add weight without a decision.
- **Rejected alternative: tabs inside Goal.** The layout contract is one page per mode; pages
  replace one another and close back to Implementation.
- **Rejected alternative: renaming the lifecycle "Overview" page.** The page is the lifecycle
  console; `Implementation` names the job and is still the `overview` tab id, so persistence and
  commands keep working.

# Discover mode — structure

## Regions

The mode is one shell plus five pages. The shell is shared with Goal and Flow; the pages replace
one another inside the Discover workspace. Each page is one scroll container except the skill
editor, which owns its pane height.

### Shell (all modes)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_mode_rail | Labeled mode rail, left edge | 1–8 | C32 | P0 |
| 2 | region_sidebar | Contextual sidebar, incl. mode header | 1–8 | C33, C34, C12 | P0 |
| 3 | region_workspace | The active Discover page | 1–8 | page regions | P0 |
| 4 | region_status_bar | Status bar, unchanged | all | C36 | P2 |

### Overview page (default when artifacts exist)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_notice | Error, interrupted, stop notice stack above the page | 1, 3, 6, 8 | C9, C10, C11 | P0 / P1 |
| 2 | region_header | Project identity, definition, freshness, run action | 1–3 | C1, C2, C3, C4, C5 | P0 |
| 3 | region_run | Active run, question, or clone progress | 1, 4, 7, 8 | C6, C7, C8, C31 | P0 conditional |
| 4 | region_commands | Commands card, main column | 2 | C13, C45 | P0 |
| 5 | region_testing | Testing card, main column | 2 | C14 | P0 |
| 6 | region_architecture | Bounded contexts, boundaries, shared kernels, main column | 2, 5 | C18, C19 | P1 |
| 7 | region_platform | Runtime facts, rail | 2 | C15 | P2 |
| 8 | region_delivery | Deployment, CI, branching, rail | 2 | C16 | P1 |
| 9 | region_stack | Stack chips, rail | 2 | C17 | P2 |
| 10 | region_remote | Manual-testing target strip, last region | 8 | C30 | P2 conditional |

Desktop layout: commands, testing and bounded contexts in the main column; platform, delivery and
stack in the rail. The two columns balance at the fixture's 1440×900, so neither leaves a tall
hole. The remote strip follows both columns.

### Glossary page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_glossary_header | Title, count line, search, threshold | 5 | C20, C21, C22 | P0 |
| 2 | region_glossary_body | One card per bounded context with the term table | 5 | C20 | P0 |
| 3 | region_glossary_empty | Filtered-empty panel with a reset action | 5 | C20 | P1 conditional |

### Term page (drill-in from a glossary row)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_term_header | Back to glossary, term title, context | 5 | C23 | P1 |
| 2 | region_term_main | Definition, uses, examples, kind, status | 5 | C23 | P1 |
| 3 | region_term_detail | Labels, related terms | 5 | C24 | P2 |

### Skill page (five variants)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_skill_header | Title, file path, state, purpose | 6 | C27, C28, C47 | P0 |
| 2 | region_skill_editor | Editor with save, restore, dirty marker | 6 | C25, C26 | P0 |

### Warnings page

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_warnings_header | Title and count | 2, 3 | C29 | P1 |
| 2 | region_warnings_body | Numbered warning list | 2, 3 | C29 | P1 |

### Empty page (no published artifacts)

| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_notice | Notice stack, only when one exists | 1 | C9, C10 | P0 |
| 2 | region_header | Project identity placeholder and run action | 1 | C1, C4, C5 | P0 |
| 3 | region_empty | What a run reads, writes, and never touches | 1 | C35 | P1 |
| 4 | region_remote | Manual-testing target strip, last region | 8 | C30 | P2 conditional |

## Primary action

- **Overview, empty, and stale:** `Discover project` / `Re-discover` in the header. One filled
  button; it is the only action that starts host-owned work. Its disabled state and title name
  the blocking reason.
- **Active run:** `Stop` in the run region is the only filled destructive action; the start
  control is disabled.
- **Skill page:** `Save` is the primary action; `Restore generated version` / `Discard edits` is
  the secondary recovery action.
- **Glossary and term pages:** no primary action. Search and threshold are filters; a term row
  opens the term page. Back returns to the glossary.
- **Warnings:** no primary action; the sidebar remains the way back.

## State coverage

- **Loading (socket closed):** the start and remote controls are disabled; their titles name the
  reason. No skeleton layout: the last published sheet stays readable and the status bar reports
  the disconnection. No layout shift.
- **Empty:** header plus the empty explanation; no sheet cards are rendered. The run action is
  present and enabled when the socket is open and no work is active.
- **Error:** one `.message` with `discover-error` at the top of the page body, above the sheet.
  The sheet remains readable; the error names the reason and the recovery is a retry.
- **Partial:** unknown fields are not rendered as values; the card shows `Not observed.` inside
  the card. Stale artifacts carry a `stale` word in the header. Nothing is inferred.
- **Permission-denied:** not applicable. The dashboard has no accounts, roles, or per-user
  permissions; the server refuses work by run state, not identity. Refusals surface as error.
- **Success:** after publication the header shows the new commit and time, the stale badge is
  gone, and the five skills show their state. A mode switch keeps the page and scroll position.
- **Active:** run region first, start disabled, Stop available; published artifacts stay visible
  below so the last result is not hidden.
- **Indexed/glossary empty:** the filtered-empty panel shows the active filters and one reset
  action.

## Responsive order

- Desktop (workspace ≥ 1100px): two columns, commands/testing left, platform/delivery/stack
  right, architecture full width. Term page two panes, main 58% / detail 42%.
- Narrow workspace (1100px down to 660px, the 1024×720 shell): one column in task order:
  commands, testing, bounded contexts, platform, delivery, stack. Term panes stack: main above
  detail; the split handle is hidden below 900px of workspace width.
- There is no mobile layout; below 1024×720 the shell is replaced by the viewport guard.
- The rail keeps its 64px width at every supported size; labels never collapse to icon-only.

## Rationale

- **Grouping by decision, not by data source.** Commands and Testing answer "how do I run this?";
  bounded contexts answer "where does this live?"; platform, delivery, and stack answer
  "what is it built on?". The shipped grouping mixed the two columns by where the crawler found
  the facts.
- **Run first, sheet second.** Starting or stopping the crawl is the only mutation and the only
  irreversible-feeling action; it earns the header. The manual remote target is a developer-only
  escape hatch and is the last region of the page, after the sheet or the empty state.
- **One primary action per screen.** In the shipped Overview, `Discover from URL` and
  `Re-discover` were both filled primary buttons in the first screen; the remote submit is now
  `outline` and the header keeps the only filled action.
- **Rejected alternative: a Discover landing dashboard with stat tiles.** Counts of commands,
  tests, and contexts are already card headers; tiles would duplicate them and add visual weight
  without a decision.
- **Rejected alternative: a tab strip for Discover pages.** The layout contract is one page per
  mode; a tab strip would add a second navigation model. Drill-in pages use a back control in
  their header instead.
- **Rejected alternative: a collapsed remote disclosure.** The verification contract requires the
  URL field while `remoteAvailable` is true; the strip is visually secondary but present.

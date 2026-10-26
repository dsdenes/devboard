# Discover mode — content inventory

Candidates come from the shipped interface (`.devboard/client/lib/components/DiscoverOverview.svelte`,
`DiscoverWorkspace.svelte`, `Sidebar.svelte`), the Discover contract in `.devboard/README.md`, and
the client types. Journey numbers refer to `brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Project name (last path segment), full path on demand | `discoverState.freshness.project` | 1–3, 5 | Confirm which repository the sheet describes | yes | Identity is required before trusting any fact |
| C2 | Freshness: commit and discovery time | `discoverState.freshness` | 2, 3 | Decide whether the sheet predates the work at hand | yes | The only evidence of currency |
| C3 | Stale marker | `discoverState.stale` | 2, 3 | Decide to re-discover before relying on the sheet | yes | Action-critical signal; 90 score |
| C4 | One-line project definition | `sheet.definition` | 1, 2 | Orient before reading details | yes | Highest-value single sentence |
| C5 | Run control: start/re-discover with disabled reason | `discover.startDisabled`, `startTitle`, `hasArtifacts` | 1, 3 | Run the crawl | yes | The mode's only mutation of host state |
| C6 | Active run: run id, start time, stop | `discover.active`, `runId`, `startedAt` | 1, 4 | Stop a long run; know a run is live | yes | Server-owned work must be visible |
| C7 | Activity stream | `discover.activity` | 1, 3 | Judge progress and failure during a run | yes | Only progress evidence the crawl offers |
| C8 | Question and answer | `discover.question`, `answerDraft` | 7 | Unblock the crawl | yes | Blocks the run when present |
| C9 | Error | `discover.displayError` | 1, 3, 6, 8 | Understand and recover from a refusal | yes | Recovery route |
| C10 | Interrupted-run notice | `discover.interrupted` | 1 | Know the last run did not publish | yes | Prevents assuming fresh data |
| C11 | Transition notice | `discover.transition` | 1 | Know a run was replaced | yes | Short-lived status; P2 |
| C12 | Warnings count and entry | `discover.displayedWarnings` | 2, 3 | Recognise partial or suspicious artifacts | yes | One entry, not repeated text |
| C13 | Commands: task and exact command | `sheet.commands` | 2 | Run and test the project | yes | Primary actionable content |
| C14 | Testing: total tests, levels, suite command | `sheet.testing`, `discover.testCommand` | 2, 6 | Choose the test level and command | yes | Required by Journey 2 and the testing skill |
| C15 | Runtime facts | `sheet.runtime` | 2 | Choose the runtime before running | yes | Supporting detail; P2 |
| C16 | Delivery facts: deployment, CI, branching | `sheet.deployment`, `sheet.ci`, `sheet.branching` | 2 | Know how a change reaches production | yes | One grouped card, not three sections |
| C17 | Stack chips with repository links | `sheet.stack`, `discover.repositoryLink` | 2 | Inspect a dependency | yes | Supporting detail; P2 |
| C18 | Bounded contexts: name, path, responsibility, entry points | `sheet.architecture.contexts` | 2, 5 | Find the code that owns a term | yes | Connects the sheet to the glossary |
| C19 | External boundaries and shared kernels | `sheet.architecture` | 2 | Judge coupling | yes | Role rows inside C18's card; the widget's own inventory owns the detail |
| C20 | Glossary terms: kind, term, uses, definition, examples | `glossaries`, `glossaryUsage` | 5 | Choose the project's word | yes | Core glossary content |
| C21 | Glossary search | `discover.glossarySearch` | 5 | Find a term in a large glossary | yes | Keeps the table usable |
| C22 | Minimum-use threshold with current value | `discover.glossaryThreshold`, `glossaryMaxUses` | 5 | Hide noise terms | yes | Explicitly opt-in filter |
| C23 | Term detail: definition, uses, examples, origin, status | `Concept`, `ConceptUsage` | 5 | Adopt a term with evidence | yes | Review surface |
| C24 | Preferred/alternate labels, related terms | `Concept.prefLabels`, `altLabels`, glossary siblings | 5 | Match the term to code identifiers | yes | P2 supporting detail in the detail pane |
| C25 | Skill text editor with save | `discover.skillDraft`, `saveSkill` | 6 | Correct policy for this host | yes | Primary skill action |
| C26 | Skill restore / recreate | `discover.restoreSkill`, `DiscoverSkill.state` | 6 | Undo an edit or recover a missing file | yes | Recovery route |
| C27 | Skill state (generated, edited, missing) and dirty marker | `DiscoverSkill.state`, `skillDirty` | 6 | Know whether the file diverges | yes | Prevents accidental loss |
| C28 | Skill purpose | fixed five-skill contract | 6 | Decide which skill owns a rule | yes | One line per skill; P2 |
| C29 | Warning detail list | `discover.displayedWarnings` | 2, 3 | Diagnose a partial artifact | yes | Full text lives on its own page |
| C30 | Manual remote target: URL, active banner, clear | `remoteAvailable`, `remoteUrl`, `remoteTarget` | 8 | Test a crawl against a public repository | yes | Source checkout only; P2 |
| C31 | Clone progress | `discover.cloning` | 8 | Know a clone is in flight | yes | Conditional on C30 |
| C32 | Mode navigation | layout mode rail | 1–8 | Reach Discover and leave it | yes | Shell; P0 |
| C33 | Discover navigation: sections and five skills | `SECTION_TABS`, `SKILL_TABS` | 1–8 | Reach a page | yes | Shell; P0 |
| C34 | Skill exception state in navigation | `DiscoverSkill.state` | 6 | Notice an edited or missing skill while browsing | yes | Only for `edited`/`missing`, not `generated` |
| C35 | Empty-state explanation and written paths | `.omp/discover/`, `.omp/skills/` contract | 1 | Decide whether to run | yes | The only place the write boundary is stated |
| C36 | Status-bar connection, project, versions | shell | all | Know the socket and version | yes | Outside Discover; unchanged |
| C37 | Concept id | `Concept.id` | — | — | no | Internal identifier; no journey needs it |
| C38 | Grounding count | `Concept.grounding.length` | — | — | no | A count of evidence records, not evidence |
| C39 | Recent notifications inside Discover sidebar | `notifications.items` | — | — | no | Duplicate of the status-bar bell and notification region |
| C40 | Duplicate warning row above the page | current header banner | — | — | no | Duplicates C12/C29 |
| C41 | Busy text repeated in the empty state | `discover.busy` | — | — | no | Same fact as the header's disabled reason |
| C42 | Skill count ("5") in the sidebar group | fixed contract | — | — | no | The five entries are the count |
| C43 | Raw full project path as the Overview title | `freshness.project` | — | — | no | Long, unwrappable; use C1 and keep the path in the sidebar/status bar |
| C44 | Origin and per-concept status as prominent facts | `Concept.origin`, `status` | 5 | Judge trust | no | No user decision turns on the origin; status stays as a quiet term attribute |
| C45 | "Commands found n of 8" denominator | `COMMAND_TOTAL` | 2 | Judge coverage | yes | A missing command is itself evidence |
| C46 | Bounded-context count in C18's heading | derived | 2 | Scan | yes | Cheap orientation, not repeated elsewhere |
| C47 | Skill file path | `DiscoverSkill.name` | 6 | Locate the file on disk | yes | Mono line in the skill page header |

## Conflicts and resolutions

- Visible project title: `freshness.project` (full path) vs the sidebar title (full path, also the
  document title). Winner: the header shows the last path segment, the sidebar keeps the full
  path, and the freshness line carries the commit. The two are not duplicates: one is the name,
  the other is the location.
- Skill state: sidebar and page header. Winner: both, but the sidebar shows only `edited` or
  `missing`; the page header always states the state. The navigation badge exists to surface an
  exception, not to repeat `generated` on every screen.
- Warnings: sidebar count, page list, and (currently) a banner row. Winner: sidebar count and the
  warnings page. The banner row is removed.
- Test command: `sheet.commands.test` and the "Whole suite" line in Testing. Winner: one
  canonical command line in Testing; the command table also lists it because the table is the
  complete command set and the suite line pairs it with the test count. The duplicate row for
  `tryOut` equal to the test command is already suppressed.

## Removed candidates

- C37 concept id, C38 grounding count, C44 origin: internal or non-decisional.
- C39 recent notices: duplicate surface; the bell remains in the status bar.
- C40 warning banner, C41 busy repeat, C42 skill count: redundant copies.
- C43 full path as the page title: unwrappable and duplicated by the sidebar.

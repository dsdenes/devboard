# Draft detail — content inventory

The current detail renders one scrolling column: actions, a boxed captured-context blob,
the whole draft bytes (which contain the same captured context again), an `Activity` header
inside the body, a log, and the question. Every candidate below was judged against the
journeys in `brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Draft heading | `GoalDraftSummary.heading` (first Markdown heading) | Review, Start | Recognise which goal is proposed | Keep | Primary identity; the heading is the human title |
| C2 | File name and relative path | `GoalDraftSummary.name/path` | Review, Start | Correlate with the list, the report, and the spec written later | Keep | The durable identity; the list already shows it, the detail owns the full path |
| C3 | Run status for this draft | `issues.draftRun.status` filtered by `path` | Review, Start | Know whether this draft is idle, running, stopped, or failed | Keep | Owns the header badge; must not borrow another draft's run |
| C4 | Start elaboration | `issues.draft.start` | Start | Run the elaboration | Keep | The single primary action |
| C5 | Stop elaboration | `issues.draft.stop` | Start | Stop the peer and keep the draft | Keep | The only way to interrupt a wrong elaboration |
| C6 | Start blocker reason | `draftStartBlocker(path)` | Start | Understand a disabled Start | Keep | Stated in the control's tooltip; the list also carries it |
| C7 | Draft or peer error | `draftError`, `draftRun.error` | Review, Start | Recover from a refused read or failed peer | Keep | Needs a visible alert, not a raw log line |
| C8 | Proposal text before `## Captured UI context` | `GoalDraftDetail.text` | Review | Judge the proposal | Keep | The reading surface; currently buried inside the raw bytes |
| C9 | Captured route, URL, selected element, viewport, time | `## Captured UI context` facts | Review | Decide whether the evidence matches the report | Keep | Compact facts; currently a wall of text |
| C10 | Visible text | `### Visible text` | Review | See what the reporter saw | Keep | Evidence, one level below the facts |
| C11 | DOM excerpt | `### DOM excerpt` | Review | See the exact element | Keep | Evidence, scroll-bounded |
| C12 | Exact draft bytes | `GoalDraftDetail.text` | Review | Debug the raw source; hard contract in README/verify | Keep | Required verbatim; behind a disclosure so it never leads |
| C13 | Elaboration activity | `issues.draftRun.activity` | Start | Follow progress and failures | Keep | Live stream; follows its newest line |
| C14 | Question message | `draftRun.question.message` | Start | Answer to unblock | Keep | P0 while present; currently below the log |
| C15 | Question options and recommendation | `question.options` | Start | Choose the intended answer | Keep | One click per option; recommendation is labelled |
| C16 | Free-text answer and submit | `issues.draftAnswer` | Start | Answer outside the offered options | Keep | Disabled until non-blank |
| C17 | Nested `Activity` header with the run path | `draftRun.path` | Start | Nothing: the header already names the draft | Drop | Duplicate identity, wrong hierarchy inside the body |
| C18 | Page-level `draftStatus` line and draft count | `issues.draftStatus`, `issues.drafts.length` | — | Page context, outside this panel | Keep (outside) | Out of the selected element; owned by the page header |
| C19 | `No elaboration` subtitle | static | Start | Nothing | Drop | Empty-state noise; the absent activity section says it |
| C20 | `No captured UI context.` | static | Review | Know the draft carries no evidence | Keep | Only shown when the marker is absent |
| C21 | Draft row blocker reason | list row | — | Already in the list | Keep (outside) | Not duplicated in the detail |
| C22 | `> Unprocessed draft` note | draft bytes | Review | Know the draft needs elaboration | Keep | Part of the proposal text; it is the writer's own instruction |

## Deduplication
- C9 and C10/C11 no longer render twice: the exact bytes (C12) move to a collapsed source
  disclosure, while the structured context is read once.
- C1 and C2 share one two-line header instead of the heading appearing again inside the text.
- C17 and C19 are removed outright.
- C3 is filtered to the selected draft; the previous component showed the global run status
  even when another draft was elaborating.

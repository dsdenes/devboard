# Draft detail — content inventory

The shipped detail renders one scrolling column under a two-line header: an optional error
alert, the question while one is pending, the proposal, and the activity log while a run exists.
Every candidate below was judged against the journeys in `brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Draft heading | `GoalDraftSummary.heading` (first Markdown heading) | Review, Start | Recognise which goal is proposed | Keep | Primary identity; the heading is the human title |
| C2 | File name and relative path | `GoalDraftSummary.name/path` | Review, Start | Correlate with the list, the report, and the spec written later | Keep | The durable identity; the list already shows it, the detail owns the full path |
| C3 | Run status for this draft | `issues.draftRun.status` filtered by `path` | Review, Start | Know whether this draft is running, stopped, or failed | Keep | Owns the header badge; must not borrow another draft's run; absent at idle |
| C4 | Start elaboration | `issues.draft.start` | Start | Run the elaboration | Keep (outside) | Each row owns the single Start; the detail does not repeat the primary |
| C5 | Stop elaboration | `issues.draft.stop` | Start | Stop the peer and keep the draft | Keep | The only way to interrupt a wrong elaboration |
| C6 | Start blocker reason | `draftStartBlocker(path)` | Start | Understand a disabled Start | Keep (outside) | The row Start's tooltip states it; the detail does not repeat it |
| C7 | Draft or peer error | `draftError`, `draftRun.error` | Review, Start | Recover from a refused read or failed peer | Keep | Needs a visible alert, not a raw log line |
| C8 | Proposal text | `GoalDraftDetail.text` through `draftProposal` | Review | Judge the proposal | Keep | The reading surface: the leading H1 and the writer's capture section are removed |
| C13 | Elaboration activity | `issues.draftRun.activity` | Start | Follow progress and failures | Keep | Live stream; follows its newest line |
| C14 | Question message | `draftRun.question.message` | Start | Answer to unblock | Keep | P0 while present; the first block after the header |
| C15 | Question options and recommendation | `question.options` | Start | Choose the intended answer | Keep | One click per option; recommendation is labelled |
| C16 | Free-text answer and submit | `issues.draftAnswer` | Start | Answer outside the offered options | Keep | Disabled until non-blank |
| C17 | Nested `Activity` header with the run path | `draftRun.path` | Start | Nothing: the header already names the draft | Drop | Duplicate identity, wrong hierarchy inside the body |
| C18 | Page-level `draftStatus` line and draft count | `issues.draftStatus`, `issues.drafts.length` | — | Page context, outside this panel | Keep (outside) | Out of the selected element; owned by the page header |
| C19 | `No elaboration` subtitle | static | Start | Nothing | Drop | Empty-state noise; the absent activity section says it |
| C21 | Draft row blocker reason | list row | — | Already in the list | Keep (outside) | Not duplicated in the detail |
| C22 | `> Unprocessed draft` notice | `goal_proposal.rs` `UNPROCESSED_NOTICE` | Review | Know the draft needs elaboration | Keep | Part of the proposal text; it is the writer's own instruction |
| C23 | Empty proposal copy | static | Review | Know the draft carries no proposal text | Keep | `This draft holds no proposal text yet.` replaces the empty block |

## Deduplication
- C8 renders the proposal once. The writer's capture section — route, URL, selected element,
  viewport, captured-at, Visible text, and DOM excerpt — is not rendered at all, so nothing
  repeats it.
- C1 and C2 share one two-line header instead of the heading appearing again inside the text.
- C4 and C6 stay on the draft row; the detail header carried a second Start with the same
  blocker, and that copy is gone.
- C17 and C19 are removed outright.
- C3 is filtered to the selected draft; the previous component showed the global run status
  even when another draft was elaborating, and an idle draft renders no badge at all.
- Dropped with the capture block: the page facts, the Visible text, and the DOM excerpt, plus
  the `No page context was captured.` sentence. No shipped surface reads them.

# Draft goals body — content inventory

The current body is a two-column grid in every state. With no drafts, the left panel holds the
single line `No drafts exist.` and the right panel holds `Select a draft to read it and elaborate
it.`, so a 783px-tall region carries two short stranded sentences. Candidates were judged only
against the journeys in `brief.md`.

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | No drafts exist (`No drafts yet`) | `issues.drafts.length === 0` | 1 | yes | keep | The state word that explains the empty body. |
| C2 | `New goal` and report proposals are the ways to create a draft | panel header and report writer | 1 | yes | keep | One line that turns the empty state into a next step. |
| C3 | Decorative notebook mark | none | 1 | no | keep | Orients the eye in a full-height panel; `aria-hidden`, carries no meaning. |
| C4 | Draft rows | `GoalDraftSummary[]` | 2, 3 | yes | keep | The list is the page's primary content when present. |
| C5 | A draft must be selected to read or elaborate it (`No draft selected`) | selection state | 2 | yes | keep | Explains why the right column is empty while drafts exist. |
| C6 | Decorative pointer mark | none | 2 | no | keep | Same empty-state grammar as C1/C3; decorative only. |
| C7 | Repository identity, workspace status, draft count | page header | 1–3 | yes | keep outside | Stated once by the page header; the body does not repeat it. |
| C8 | Second detail column with no drafts | layout | 1 | no | drop | An empty panel beside an empty list adds chrome without information. |
| C9 | `Start` on each row | row action | 2, 3 | yes | keep outside | The row owns the only elaboration start control. |
| C10 | Another `New goal` action inside the empty state | would duplicate C2's control | 1 | no | omit | The panel header keeps the single filled primary. |
| C11 | Draft count inside the empty state | `issues.drafts.length` | 1 | no | omit | The panel header and page header already state it; zero is implied. |

## Deduplication

- C1 and C2 share one 360px stack; C8's second panel is gone in the empty state.
- C5 replaces the old free-floating sentence with the same centered grammar, so the selection
  state no longer looks like an empty container.
- C7 stays outside the element; the body never repeats the repository or the count.
- C10 is omitted: `New goal` in the panel header remains the only filled primary.

# Draft goals body — UX brief

## Identity

- Route `/` → Issues mode → Draft goals (`#workspace-issues`, `section.issues-drafts-page`), body
  `div.issues-drafts__body`.
- Entry points: the Issues sidebar's `Draft goals` item, the command palette's
  `open.issues.drafts`, and the restored Draft goals tab after a reload.
- Auth/role: the local operator of one repository's dashboard; no accounts or roles.

## Goal

- Primary goal: review proposed goal drafts, then select one to read and elaborate it.
- Success signal: an operator with no drafts understands what the body is for and how to create
  one; an operator with drafts sees the list and knows that selecting a row opens its detail.
- Secondary goal: keep the creation action discoverable without duplicating it in the empty body.

## Arrival context

- The page header already states the repository, workspace status, and draft count.
- The operator may arrive after a report or Auto Scout wrote a proposal, or with no proposals at
  all. The list is polled every two seconds, so an empty body can become populated in place.
- Desktop at 1024×720 or wider; the shell replaces the workspace below that floor.

## Relationship to other pages

- Upstream: the report panel and Auto Scout write `goal-proposals/*.md`; the sidebar shows the
  draft count.
- Downstream: elaborating a selected draft writes a spec and files an issue, then the draft leaves
  the list.
- State left behind: the selected draft path is stored in `localStorage` and restored on return.

## Journeys

1. *First arrival, no drafts.* Open Draft goals → the page header reads `0 draft(s)` → the single
   Proposed goals panel explains the empty state and names `New goal` and report proposals as the
   ways in → `New goal` opens the creation band. Failure route: a failed list read leaves the last
   known body and reports through the store's existing notices; the empty state never claims a
   read succeeded.
2. *Drafts exist, none selected.* Open Draft goals with drafts on disk → the left panel lists
   them → the right panel states that a row must be selected before anything can be read or
   elaborated → selecting a row opens the detail.
3. *Select another draft.* The list stays visible; the right panel swaps to that draft's detail
   without a page reload. Restored state reopens the same path.

## Non-goals

- Changing the page header, the Proposed goals rows, the creation band, or the detail panel's
  internal sections.
- Adding a second `New goal` control or an automatic selection.
- Loading skeletons; the store keeps the last snapshot and the page has no separate list spinner.

## Assumptions

- A zero-length draft list is the only empty state in this element.
- The detail panel is the right column at ≥1100px and the second stacked panel below that.

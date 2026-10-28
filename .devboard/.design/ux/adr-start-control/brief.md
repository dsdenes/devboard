# Decision record start control — brief

Slug: `adr-start-control`. Scope: the `Start` control in the action column of
`[data-testid="adr-table"]` on Goal mode's Decision records page, plus the cells it occupies.
Design artifacts live under `.devboard/.design/` per the harness convention; the interface is
the harness's own UI.

## Page identity

- Route: Goal mode → `ADR records` (`section.panel.goal-adrs-panel`). The issue's captured
  selector names `main > section.run`; the shipped table is that surface, with `.start-button`
  as the captured child.
- Title: `Decision records`; subtitle meta is `N of M resolved · K ADRs pending`.
- Auth/role: local operator console; no accounts, no roles.
- Entry points: the Goal rail tab then the sidebar's `All records` item, or the `Show decision
  records` command, or a pending record's sidebar entry.

## Primary goal

Start resolving a decision record without leaving the register. The observable success signal:
the lifecycle or manual run begins for the chosen record and the activity surface names it.

## Secondary goals

- Identify the next record the lifecycle will pick before starting it.
- Override the order and start a different pending record deliberately.
- Read a resolved record as resolved without seeing a repeated state word.
- Reach the control by keyboard in the same row order as the table.

## Arrival context

The operator has read the pending count and is scanning the register for the next decision.
Records arrive newest by file order; the `Next` marker sits on the lowest-numbered pending file.
The operator may have an active lifecycle or manual run, in which case Start is disabled.

## Relationship to other pages

- Upstream: the Goal overview's pending summary and the sidebar's ADR group.
- Downstream: the record detail tab (row click) and the Activity panel (lifecycle start).
- Loops: status badges and the pending summary change in place as records are resolved.
- State left behind: the Decision records page; no dialog or mode change.

## User journeys

J1 — Start the next record.

- Trigger: the pending list is ready and the operator accepts the lifecycle order.
- Steps: scan the table; find the row with the `Next` badge; click its filled `Start`.
- Decision points: is this the record to resolve now?
- Success: the run starts for that record.
- Failure: the filled control blends into three identical blue buttons, so the operator cannot
  tell which record the lifecycle will pick.
- Recovery: read the `Next` badge and the file name.
- Exit: the Activity panel.

J2 — Override the order.

- Trigger: a later pending record is more urgent.
- Steps: scan to that record; click its outlined `Start`.
- Decision points: is this record safe to resolve out of order?
- Success: the run starts for the chosen file.
- Failure: the control is too small to hit, or its border disappears against the row hover.
- Recovery: use the keyboard or open the row and start from the detail surface.
- Exit: the Activity panel.

J3 — Read a resolved row.

- Trigger: the operator checks whether a record is already accepted.
- Steps: read the Implementation column's `Resolved` word.
- Success: the row has no action affordance to mistake for work remaining.
- Failure: the action column repeats `Resolved`, so the eye scans two state words per row.
- Exit: continue scanning, or open the record.

## Non-goals

- Changing lifecycle ordering, filtering, or record statuses.
- Adding a row-level menu or a second action.
- Reworking the table's columns, header labels, or sorting.
- Starting work from the sidebar or from a global header control.

## Assumptions

- `goal.next` names exactly one pending record or `null`.
- A pending record can be started directly; a resolved record cannot.
- The supported viewport is at least 1024×720 and the table keeps its fixed column tracks.
- Start is disabled while creation, revision, skills preparation, or a manual run owns the
  workspace; the disabled state must still be legible.

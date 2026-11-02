# Artifact templates

Use these as starting points. Delete sections that do not apply; do not leave empty headings.

## Step 0 — `brief.md`

```md
# <Page> — UX brief

## Identity
- Route:
- Title:
- Auth/role:
- Entry points:

## Goal
- Primary goal:
- Success signal:
- Secondary goals:

## Arrival context
- What the user knows:
- What they carry in:
- Prior page/state:
- Device/network assumptions:
- Urgency:

## Relationship to other pages
- Upstream:
- Downstream:
- Loops:
- State left behind:

## Journeys

### Journey 1 — <name>
- Trigger:
- Steps:
- Decision points:
- Success:
- Failure routes:
- Recovery:
- Exit:

## Non-goals

## Assumptions
```

Do not add information, component, color, font, or style sections here.

## Step 1 — `content-inventory.md`

```md
# <Page> — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | | | | | yes/no | |

## Conflicts and resolutions
- <source A> vs <source B>:
- Winner:
- Why:

## Removed candidates
- <candidate>:
- Why removed:
```

## Step 2 — `significance.md`

```md
# <Page> — significance inventory

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | | | | | | | | P0/P1/P2/P3/drop | |

## Deduplication
- <items>:
- Kept:
- Removed:
- Why:

## Notes
- Score is information importance, not visual size.
```

## Step 3 — `structure.md`

```md
# <Page> — structure

## Regions
| Order | A2UI ID | Region | Journey | Items | Priority |
|---|---|---|---|---|---|
| 1 | region_header | | | C1, C2 | P0 |

## Primary action
- Action:
- Why it is primary:
- Where it lives:

## State coverage
- Loading:
- Empty:
- Error:
- Partial:
- Permission-denied:
- Success:

## Responsive order
- Desktop:
- Tablet:
- Mobile:
- Collapsed/moved/hidden:

## Rationale
- Grouping:
- Alternatives rejected:
```

## Step 4 — `component-requirements.md`

```md
# <Page> — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| | reuse/modify/compose/new | | | | | |

## Component details

### <Component>
- Decision:
- Why this decision:
- Real API:
- Data shapes:
- States: default / loading / empty / error / partial / permission
- Edge cases: zero / one / many / long text / large numbers / nulls / high cardinality
- Accessibility:
- Tokens:
- Storybook story to add/update:
- OpenUI entry to add/update:
```

## Research receipt — `.design/research/<date>-<slug>.md`

```md
# designmd.ai research

- Task:
- Tools and arguments:
- Candidates (include designmd.ai URLs):
- Adopted:
- Rejected:
- Why:
- Effect on DESIGN.md / tokens / components:
```

## Final validation — `validation.md`

Use the template in `skill://devboard-ui-ux/references/validation.md`.

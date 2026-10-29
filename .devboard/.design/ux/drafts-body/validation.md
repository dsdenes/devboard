# Draft goals body — validation (#761)

Consolidated ui-ux record for the operator report against the Draft goals body. The selected
element is `#workspace-issues > section.issues-drafts-page > div.issues-drafts__body`, captured at
`/` on 2026-10-29 at 2101×1017. Sections map to skill steps 0–6 and final validation.

## Brief

- **Page identity.** Issues mode → Draft goals (`#workspace-issues`,
  `[data-testid="issues-drafts"]`), no auth or role. Entry points: the Issues sidebar item, the
  command palette (`open.issues.drafts`), and the restored Draft goals tab after a reload.
- **Primary goal.** Understand what the body holds and either create a draft (empty) or select one
  to read and elaborate (populated).
- **Secondary goal.** See the Proposed goals list without losing the reason the detail column is
  empty.
- **Arrival context.** The page header already states repository, status, and draft count. The
  list is polled every two seconds, so the body can swap state in place.
- **Relationship to other pages.** Reports and Auto Scout write drafts; elaboration writes a spec
  and files an issue, then the draft leaves the list.
- **Journeys.** *No drafts:* header `0 draft(s)` → one panel with `No drafts yet` and the two
  creation paths → `New goal` opens the band. *Drafts, none selected:* list on the left → right
  panel says a draft must be selected → selecting opens the detail. *Restore:* the stored path
  reopens the same detail; a vanished path clears the selection.
- **Non-goals.** Page header, draft rows, creation band, detail internals, automatic selection.
- **Assumptions.** A zero-length list is the only empty state here; failures are owned by the
  store's notices and the detail's error alert.

## Information inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | No drafts exist | `issues.drafts.length === 0` | empty | yes | yes | State word for the region. |
| C2 | Ways to create a draft | header action + report writer | empty | yes | yes | One next-step line. |
| C3 | Notebook mark | decorative | empty | no | yes | Orients the eye; `aria-hidden`. |
| C4 | Draft rows | `GoalDraftSummary[]` | populated | yes | yes | Primary content. |
| C5 | Selection instruction | selection state | no selection | yes | yes | Explains the empty detail column. |
| C6 | Pointer mark | decorative | no selection | no | yes | Same grammar; `aria-hidden`. |
| C7 | Identity/status/count | page header | all | yes | outside | Stated once by the page header. |
| C8 | Empty detail column | layout | empty | no | no | Chrome without information. |
| C9 | Row `Start` | row | populated | yes | outside | Row owns the only start control. |
| C10 | Second `New goal` | would duplicate | empty | no | no | Header keeps the one primary. |
| C11 | Count in the empty body | derived | empty | no | no | Header already states it. |

## Significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Goal | Action | Frequency | Unique | Risk | Score | Priority |
|---|---:|---:|---:|---:|---:|---:|---|
| C1 | 5 | 3 | 5 | 5 | 1 | 82 | P0 |
| C2 | 4 | 3 | 4 | 4 | 0 | 67 | P1 |
| C4 | 5 | 5 | 5 | 5 | 1 | 89 | P0 |
| C5 | 4 | 4 | 4 | 5 | 0 | 74 | P1 |
| C9 | 5 | 5 | 3 | 5 | 2 | 85 | P0 |

C3 and C6 are decorative and not scored; C7, C9 live outside the body; C8, C10, C11 are dropped.

## Structure

```
[page header: Draft goals · owner/repo · idle · 0 draft(s)]          outside

empty, zero drafts
body (one full-width panel; no detail column)
  Proposed goals panel
    header: title + filled New goal
    centered stack: notebook mark, No drafts yet, creation copy      360px cap, 24/16 padding

drafts, no selection
body (240–340px list + 1fr detail, 12px gap; one column below 1100px)
  Proposed goals panel: header + rows
  detail panel: pointer mark, No draft selected, selection copy

selected
  detail panel: unchanged draft detail
```

- One primary action: the panel header's `New goal`; the empty stack adds none.
- The empty state removes the detail column instead of rendering a second empty panel.
- States: empty; drafts/no selection; selected; vanished draft returns to no selection or empty;
  errors stay in the store notices and the detail alert; no skeleton is added because the store
  keeps its last snapshot.
- Responsive: 1024×720 keeps the 360px stack inside a 618px body with no horizontal scroll; below
  1100px the list and detail stack, list first. Mobile is not a supported shell surface.
- Rationale: remove chrome with no information, reuse the documented compact empty-state grammar,
  and keep the single filled primary in the header.

## Component decisions

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Empty body state | Compose panel body + local `.issues-drafts__placeholder*` + Lucide `NotebookPen` | — | — | zero drafts; title + one line; 1024 and 1440; light/dark | `aria-hidden` mark; real text; no focus target | muted-foreground, foreground, type sizes, spacing |
| Selection state | Compose the same stack + Lucide `MousePointerClick` | — | — | drafts, no selection; same widths/themes | same | same |
| Panel, rows, detail, button | Reuse | `.panel`, `.panel__body`, `.issues-draft-row`, `Button` | design-system specimens | unchanged | unchanged | unchanged |

- No token, DTCG, OpenUI, Storybook, or shared component API changed; no `designmd` mutation
  receipt is required.
- Rejected: two empty panels, a dashed drop zone (no drop affordance), a second `New goal`
  (duplicate primary), and auto-selecting the first draft (writes a selection the operator did not
  make).

## Validation

- Page: Issues mode → Draft goals, `#workspace-issues`, `[data-testid="issues-drafts"]`.
- Worktree/branch: `.worktree/issue-761`, branch `issue-761`.
- Command: `cd .devboard && bun run build`, then the source dashboard on `PORT=8093` with
  `STATE_DIR` under the worktree, `ADRS_DIR=../adrs`, `REPO_DIR=..`, and `STATIC_DIR=dist`.
- Browser: OMP browser (Playwright-backed Chromium), direct helpers.
- Viewports: 1440×900 and 1024×720 (supported floor), dark and light.
- States exercised:
  - Empty, 0 drafts, dark, 1440×900: `empty-1440-dark.png`
  - Empty, 0 drafts, dark, 1024×720: `empty-1024-dark.png`
  - Empty, 0 drafts, light, 1024×720: `empty-1024-light.png`
  - Drafts, no selection, light, 1440×900: `selection-1440-light.png`
  - Drafts, no selection, light, 1024×720: `selection-1024-light.png`
  - Drafts, no selection, dark, 1024×720: `selection-1024-dark.png`
  - Selected draft detail: checked in the browser, unchanged from the documented detail panel.
- Measured result:
  - Empty at 1440×900: `issues-drafts__body` grid resolves to one 1033.86px track; exactly one
    panel; no detail or selection panel. Stack 360×83.67px, horizontal center 907.06 against the
    body center 907.07. Notebook mark 20×20px, `aria-hidden="true"`, `rgb(139,148,158)`.
  - Empty at 1024×720: one 618.89px track; stack 360px wide and two copy lines; document
    `scrollWidth === clientWidth === 1024`.
  - Drafts, no selection at 1440×900: `340px 681.86px` tracks, 12px gap; the selection stack is
    centered on both axes of the detail panel (center deltas below 0.5px horizontal and 32px
    vertical, the latter only from the 30px panel header).
  - Drafts, no selection at 1024×720: one column, list panel above the selection panel;
    `scrollWidth === clientWidth === 1024`.
  - Selected row: `issues-draft-detail` carries the selected path, the selection panel is gone,
    and the proposal text renders; the detail panel's internals are unchanged.
  - Creation band: `New goal` keeps `aria-expanded="true"` and `aria-controls`, the empty stack
    stays, and the body remains one panel.
- Console/network: zero console entries and zero failed requests among 10 observed requests on
  the Draft goals page in the empty state; the tab reported no exceptions.
- Checks: `bun run check` — 0 errors, 0 warnings across 1763 files. `bun test
  --max-concurrency=1` — 1073 pass, 0 fail across 83 files (6469 assertions).
  `bun run verify:design` — pass, including the normative documents, page shape, and freshness
  gates. The machine was running other agents' suites at the same time; default-concurrency runs
  intermittently timed out unrelated Flow, discover-remote, and launcher tests, each of which
  passed in isolation and in the serial full run. An earlier Flow concurrent-start failure came
  from stale `.devboard/.tmp/flow-tests` state and disappeared after that directory was removed;
  the same test passed in a fresh detached `origin/main` worktree without cleanup.
- Dependent pages: none. No shared component, token, DTCG, OpenUI, or Storybook artifact changed;
  `Button` and the panel primitives are reused. `verify:design` exercises the shared page shape.
- Not run: `bun run verify:interface` does not reach the Draft goals checks. It stops at the shared
  Issues poll assertion (`scripts/verify-interface.ts:5341`) with
  `poll: "Tracker sync starting"` instead of `"Not polling"`. A clean detached `origin/main`
  worktree at `9b9808d` reproduces the same failure at the same line, so the gate is blocked by a
  canonical-line defect outside this change. The Draft goals surface is verified by the browser
  evidence above.
- Verdict: pass for the changed surface; one repository-wide gate is blocked upstream and named
  above.

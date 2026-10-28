# Filed issues empty state — redesign (#284)

Consolidated ui-ux record for one operator report against the Auto Scout surface. The selected
element is `#workspace-issues > section.issues-scout ... div.scout-issues__empty`
(`data-testid="scout-issues-empty"`), captured at `/` on 2026-10-28 at 2101×1017. The repository
records small operator-report batches as one consolidated file per surface, following
`.devboard/.design/issues-agents/` and `.design/ux/issues-poll-status/validation.md`; the sections
below map to skill steps 0–6 and final validation. No new A2UI wireframe was produced because the
change is one state inside an existing panel and the existing `auto-scout` A2UI and wireframe
artifacts were synchronized instead.

## Brief

- **Page identity.** Issues mode → Auto Scout (`#workspace-issues`, `[data-testid="issues-scout"]`),
  no auth or role. Entry points: the Issues sidebar entry, the command palette, and the restored
  Issues page after reload.
- **Primary goal.** Read the Filed issues panel and know whether it is empty because nothing has
  been filed, then trust the page's Start/Stop state and scan activity.
- **Secondary goal.** Understand what will appear in the table when Auto Scout files something.
- **Arrival context.** The operator may have just started or inspected the worker; the page header
  already names lifecycle, GitHub read state, and last read, and the side rail names the filing
  limits. The empty panel is the largest region on the page.
- **Relationship to other pages.** The Issues overview owns automation controls; Scan activity
  below the table owns scan progress and failures. An empty table is a valid result, not a failed
  read.
- **Journeys.**
  - *Confirm an empty result.* Open Auto Scout → the panel header reads `Filed issues 0` → the
    centered stack says `No issues filed yet` and what will be filed → continue to Start or read
    activity. Failure route: the read state is `error`/`stale` in the page header and the reason is
    in the alert row, so the empty panel never claims the tracker is empty when it could not read.
  - *Wait for a scan.* The same empty state stays until the first row arrives; the store swap
    replaces it with the table in place.
- **Non-goals.** Changing the panel header, the page header, the filing limits, the activity log,
  or the table's populated state.
- **Assumptions.** A zero-row response is the only empty state; loading and errors are owned by the
  page and store, not this element.

## Information inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | No issues are filed (`No issues filed yet`) | `rows.length === 0` | confirm | yes | yes | The one state word that explains the empty region. |
| C2 | Auto Scout will file significant findings after each scan | page purpose | wait | yes | yes | Explains what the panel will hold; kept to one line. |
| C3 | Inbox mark | none (decorative) | confirm | no | yes | Orients the eye in a 590px panel; `aria-hidden`, carries no meaning. |
| C4 | Row count `0` | `rows.length` | confirm | yes | stays in panel header | Already the source of truth for emptiness; not repeated in the body. |
| C5 | Hourly/open limits and score threshold | side rail | — | no | omitted | Already stated once on the page. |
| C6 | Start/Stop control | page header | confirm/wait | yes | omitted | The page header keeps the only primary action. |

## Significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Goal | Action | Frequency | Unique | Risk | Score | Priority |
|---|---:|---:|---:|---:|---:|---:|---|
| C1 | 5 | 3 | 5 | 5 | 1 | 82 | P0 |
| C2 | 4 | 3 | 5 | 3 | 1 | 69 | P1 |
| C3 | — | — | — | — | — | — | decorative, not scored |

C4 stays in the header because it is the panel's own count, not a second body statement.

## Structure

One stack centered on both axes inside the flush panel body, in reading order:

```
[20px muted inbox mark, aria-hidden]
No issues filed yet                      13px/600, foreground
Auto Scout files significant findings here after each scan.
                                         12px/400, muted, line-height 1.45
```

- The stack is a column with a 4px gap, capped at 360px, with 24px 16px panel padding. Centering
  is horizontal and vertical; the panel body fills the table's flex area.
- No container, frame, fill, border, or shadow is added: the panel already owns the only frame, and
  a nested box would add chrome without information.
- The mark sits 4px above the title (8px total), matching the micro-icon-to-text step.
- Only the empty state changes; the populated table, its headers, and scrolling are untouched.
- Loading, error, permission, and partial states are not rendered here: the page header and the
  alert row own read failures, and the parent always supplies either zero rows or the table.
- At 1024×720 the page stacks and the Filed issues panel is capped at 320px; the same centered
  stack fits without clipping.

## Component decisions

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Empty results message | Compose the existing `.panel` body with local `.scout-issues__*` styles and a Lucide `Inbox` icon | — | — | zero rows; one title; one explanatory line; 317px natural width, 360px cap; 1024 and 2101 widths | `aria-hidden` mark, plain text title/copy, no focus target | `muted-foreground`, foreground, type sizes, spacing |

- **Reuse:** Lucide `Inbox` from `lucide-svelte/icons/inbox`, the same icon stack already used by
  the rail and feedback overlay. The icon is decorative because the words carry the state.
- **No design-system mutation:** no token, DTCG, OpenUI catalog, Storybook, or shared component API
  changed. `.scout-issues__empty` has one consumer. The composition is documented as one
  `DESIGN.md` component bullet, and the Auto Scout A2UI, wireframe, structure, and component
  requirements are synchronized.
- **Rejected:** a new EmptyState component (one consumer), a full-width banner (the page has no
  banner after #278), a Start action inside the empty state (duplicates the page's primary action),
  and repeating filing limits (already in the side rail).

## Accessibility

- The mark is `aria-hidden="true"`; the title and copy are real text, so the state is available to
  assistive technology without an icon name.
- No interactive element is added, so focus order is unchanged; the next tab stop remains Start.
- Dark and light both use `foreground` for the title and `muted-foreground` for the copy and mark;
  the mark is redundancy, never the only signal.
- Centered text is two short lines at a 360px cap, not a paragraph measure that becomes hard to
  track; line height is 1.45 for the copy.

## Validation

- Page: Issues mode → Auto Scout, `#workspace-issues`, `[data-testid="issues-scout"]`.
- Worktree/branch: `.worktree/issue-284`, branch `issue-284`.
- Command: `cd .devboard && bun run build`, then the source dashboard at
  `http://127.0.0.1:8093/` with `PORT=8093`, `STATE_DIR` under the worktree, and `ADRS_DIR`,
  `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR` pointing into the worktree.
- Browser: OMP browser (Playwright-backed Chromium); `bun run verify:scout` for the deterministic
  gate.
- Viewports: 2101×1017 and 1024×720 (the supported floor), dark and light. Mobile is not a
  supported surface; below 1024×720 the shell renders its viewport notice.
- States exercised:
  - Empty/stopped, dark, 2101×1017: `.devboard/.design/scout-filed-issues-empty/empty-2101-dark.png`
  - Empty/stopped, dark, 1024×720: `.devboard/.design/scout-filed-issues-empty/empty-1024-dark.png`
  - Empty/stopped, light, 1024×720: `.devboard/.design/scout-filed-issues-empty/empty-1024-light.png`
  - Populated, failed read, limits save, and worker start are exercised by `bun run verify:scout`.
- Measured result at 1024×720: panel and stack centers both at x=699; natural stack width 317.8px
  inside the 360px cap; icon 20×20 with `aria-hidden="true"` and `rgb(139,148,158)`; title 13px/600
  in `rgb(230,237,243)`; copy 12px/400 in `rgb(139,148,158)`; `scrollWidth === clientWidth === 1024`.
- Console/network: zero console entries and zero failed requests among 29 observed requests on the
  Auto Scout page at both viewports.
- Checks: `bun run check` — 0 errors, 0 warnings; `bun test` — 604 pass, 0 fail across 46 files;
  `bun run verify:scout` — passed (empty state before the first scan, then populate, limits,
  release update, failed read, stop).
- Dependent pages: no shared component or token changed; the table's populated rendering is
  unchanged and covered by `verify:scout`.
- Not run: `bun run verify:interface` (it covers shared primitives and unrelated workspaces that
  this local change does not touch); `bun run verify:scout` already owns this surface.
- Design research receipt: `.devboard/.design/research/2026-10-28-scout-filed-issues-empty.md`
  (MCP manager unavailable; sources of truth recorded).

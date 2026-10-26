# Validation — Goal mode redesign

- Pages: Goal Implementation, Decision records, ADR detail, Goal document, Skills, Lane, the empty
  page, the global run question, plus the shared mode rail, sidebar navigation, and status bar.
- Commit/branch: `goal-mode-redesign` worktree, based on `main` at `243a9a0`.
- Commands:
  - `cd .devboard && bun install --frozen-lockfile`
  - `cd .devboard && bun run build`
  - `cd .devboard && bun run check` → 1047 files, 0 errors, 0 warnings.
  - `cd .devboard && bun test` → 364 pass, 0 fail, 2900 expectations.
  - `cd .devboard && bun run verify:interface` → passed (run twice: before and after the final
    client changes).
  - `npx --yes @google/design.md@0.4.0 lint --format json DESIGN.md` → 0 errors, 29 warnings
    (pre-existing orphaned-token warnings; unchanged).
  - `npx --yes @google/design.md@0.4.0 export --format dtcg DESIGN.md` diffed against
    `design/tokens.json` → identical; no token changed.
  - `cd .devboard && npx --yes storybook build -o .tmp/storybook` → completed successfully.
- Fixture: a host under `.devboard/.tmp/goal-ux/host` (goal, four ADRs — two pending, five managed
  skills) served by `createApp` in-process with the deterministic ACP stub
  (`--generate-epic=12:Ledger API --question-epic=12 --lane-delay=12:6000`) and an injected tracker
  returning epic #12. Every path stayed inside the worktree.
- Browser: project `@playwright/test` 1.64.1, headless Chromium 1248 from the repository's
  `.design/browsers`, driven directly (not through a server restart).
- Viewports: 1440×900 and 1024×720 (the supported boundary). The standalone wireframes were also
  rendered at 1440×900 and 390×844.
- Journeys exercised:
  1. Read the implementation console: header, lifecycle stage track, pending line, activity empty
     state, danger zone.
  2. Start the lifecycle; the stage track advances, a lane appears in the sidebar with status.
  3. Open the lane while it waits on a question; answer once; the lane continues and the panel
     leaves.
  4. Read the ADR set; filter to pending; open one record; return to the set.
  5. Open the Goal document; confirm the saved state and the revision field at the bottom.
  6. Open Skills; confirm the prepared list and the no-contradictions line.
  7. Start goal creation from the **Goal document** page; the queued question renders on that page
     and the sidebar Run entry shows the `answer` badge.
  8. Light theme and 1024×720 for every page type.
- States exercised:
  - idle console, active lifecycle, active lane with a question, lane after the answer (retrying),
    ADR all/pending filters, pending and resolved rows, record detail, saved and creating goal
    document, prepared skills, dark and light, 1440 and 1024.
- Screenshots (`.design/ux/goal/screenshots/`):
  - `goal-implementation-idle-desktop-dark.png`, `goal-implementation-lifecycle-desktop-dark.png`,
    `goal-implementation-desktop-light.png`, `goal-implementation-1024-dark.png`
  - `goal-lane-question-desktop-dark.png`, `goal-lane-after-answer-desktop-dark.png`
  - `goal-adrs-desktop-dark.png`, `goal-adrs-pending-desktop-dark.png`,
    `goal-adrs-1024-dark.png`, `goal-record-desktop-dark.png`
  - `goal-document-desktop-dark.png`, `goal-document-question-desktop-dark.png`,
    `goal-document-1024-dark.png`
  - `goal-skills-desktop-dark.png`, `goal-skills-1024-dark.png`
  - `wireframe-goal-implementation-1440.png`, `wireframe-goal-implementation-390.png`,
    `wireframe-goal-pages-1440.png`, `wireframe-goal-pages-390.png`
- Layout/overflow: every captured state reported 0px of horizontal document overflow. Panels own
  their scrolling; the Goal document page scrolls with 56px bottom clearance so the revision field
  clears the fixed notification region and the report control.
- Console/network: the capture listener recorded no console error, no page exception, no failed
  request, and no HTTP response ≥400 after adding the inline favicon.
- Accessibility (covered by `verify:interface` and the implementation):
  - mode tabs keep `aria-controls`, `aria-selected`, visible labels, and a spoken state word;
  - the stage track is an `ol` with `aria-current="step"` and state words, never color alone;
  - ADR rows are real table rows with focusable Enter/Space activation and a real button inside;
  - the document editor keeps its accessible label; the revision field is labelled;
  - question options are buttons; the free-text form has a label; errors use `role="alert"`;
  - focus rings, contrast, reduced motion, and the palette contract are exercised by
    `verify:interface`, which passed for both themes.
- Dependent pages: the mode rail and status bar are shared with Flow and Discover.
  `verify:interface` exercised both modes after the rail change (mode switching, shortcuts, palette
  mirroring, theme, 1024 boundary) and passed.
- Findings and fixes during validation:
  - The run question only rendered on the Implementation page, so a queued creation/revision
    question was invisible from the Goal document where it was started. Fixed: one question panel
    renders above every non-Implementation Goal page, and the sidebar Run entry carries an `answer`
    badge.
  - The ADR title cell collapsed to 16px at 1024 because a flex cell inherited the table's
    `max-width: 0`. Fixed by letting the inner span truncate; the column now measures 172px.
  - The Goal document's last field sat under the fixed notification/report region. Fixed with the
    documented 56px bottom clearance on the scroll container.
  - Duplicate information removed: the lifecycle panel's second stage label, the ADR `Next` column
    (folded into the title badge), the sidebar's separate Next row, the document character count,
    the filter counts, and the lane activity badge repeating the lane status.
  - Spacing audit: new work uses 2/4/6/8/10/12/14/16/24 and the documented 56px clearance; no new
    off-scale value was introduced. Existing fixed geometry (64px rail, 26px status bar, 28px rows,
    30px panel headers) is unchanged.
- Not run / blocked:
  - Paused and finished lifecycle screenshots. The stub cannot produce a stable paused lifecycle
    without a second agent process, and the finished state requires a closed tracker; both are
    covered by the `StageTrack` stories (`Paused`, `Finished`) and by the server lifecycle suite.
  - The no-records Goal page at runtime; its structure is in `goal-adrs.empty.a2ui.jsonl`, and the
    server suite covers empty record lists. The filtered-empty table row was exercised by the
    pending/resolved filters.
  - A real-model lifecycle run and a real forge; `README.md` owns those operator procedures and they
    are not a pass gate for this interface change.
  - Automated axe scanning: not configured in this repository. Keyboard, focus, contrast, and
    reduced-motion contracts are covered by `verify:interface`.
- Verdict: pass for the structural, visual, interaction, and accessibility checks listed above.

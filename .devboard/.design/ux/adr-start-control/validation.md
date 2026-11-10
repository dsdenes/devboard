# Validation — Decision record start control

- Page: Goal mode → Decision records, `#workspace-goal`,
  `section.panel.goal-adrs-panel` (`[data-testid="adrs-overlay"]`).
- Commit/branch: worktree `.worktree/issue-401`, branch `issue-401`, integrated with `main` at
  `73e70b3`.
- Commands: `cd .devboard && bun install --frozen-lockfile && bun run build`, then the source
  server at `http://127.0.0.1:8942/` with `PORT=8942`, `STATIC_DIR` in the worktree, `STATE_DIR`
  under the worktree, and `REPO_DIR`, `ADRS_DIR`, `GOAL_FILE` pointing at a fixture host under
  `.devboard/.tmp/`. The fixture copies the repository's twelve records and changes 0002, 0006,
  and 0010 to `status: proposed`, so the table renders one `Next` row, two other pending rows,
  and nine resolved rows.
- Viewports: 2101×1017, 1440×900, 1280×720 (the issue's capture size), and 1024×720; dark and
  light.
- Playwright source: OMP browser (Playwright-backed Chromium).
- States exercised:
  - Default table, dark, 1440: `.devboard/.design/ux/adr-start-control/records-dark-1440.webp`
  - Default table, dark, 1280: `.devboard/.design/ux/adr-start-control/records-dark-1280.webp`
  - Default table, dark, 1024×720:
    `.devboard/.design/ux/adr-start-control/records-dark-1024.webp`
  - Default table, dark, 2101:
    `.devboard/.design/ux/adr-start-control/records-dark-2101.webp`
  - Default table, light, 1440:
    `.devboard/.design/ux/adr-start-control/records-light-1440.webp`
  - `Next` row filled, other pending rows outlined, resolved action cells empty in every shot.
- Measurements on the rendered page:
  - Before: 20px tall, 3px radius, 11px text with a 26px inherited line-height, `0 6px` padding,
    38.7px wide, filled `primary` on all three pending rows; resolved rows printed `Resolved` in
    the action column.
  - After: 24px tall, 4px radius, 11px/500, `0 10px` padding, 46.7px wide; 2.5px above and 1.5px
    below inside the 27px cell content box; row heights unchanged at 28px.
  - Exactly one Start has the `primary` fill (`#1f6feb` dark, `#0969da` light); the other two
    have the transparent `outline` variant with `border-strong` (`#6e7681` dark, `#6e7781`
    light). The verification fixture's four pending records are checked against the same rule
    in its light-theme state.
  - Accessible names are unique and start with `Start the implementation of `; the visible label
    remains `Start`. Computed cursor is `pointer` for every enabled control.
  - Resolved action cells are empty; the Implementation column keeps the only `Resolved` word.
  - At 1024×720 the document reports `scrollWidth === clientWidth === 1024`; the button keeps
    its 24px height and 46.7px width while the title, file, and summary columns truncate.
- Dependent pages: no shared component or token changed. The control composes the existing
  `Button` primitive, and every other `Button` consumer renders from the same unchanged
  primitive.
- Console/network: the live Decision records page recorded no console exception and no failed
  request at any exercised viewport.
- Not run / blocked:
  - designmd MCP research was not run: `mcp://` has no MCP manager, so no design-kit receipt is
    claimed. The `skill://ui-ux` document is not installed in this session; the repository's
    `DESIGN.md`, `design/tokens.json`, `openui.json`, and prior `.design/` receipts were used.
  - The hover fill could not be measured in headless Chrome: `matchMedia("(hover: hover)")`
    reports false, so the primitive's media-gated `hover:bg-[var(--secondary)]` rule does not
    match. The rule is present in the built bundle and is shared with every other `Button`.
  - The disabled state was not forced through the fixture: making Start unavailable requires an
    active creation, revision, skills preparation, or manual run, and the fixture host has no
    prepared skills. `client/lib/components/AdrTable.test.ts` pins that path instead by setting
    the manual-run store state and asserting every Start is disabled.
- Integration: `origin/main` gained `945e6b6 ui(adrs): remove the row Start button` for the
  malformed removal request #402, which captured the same element. Issue #401 asks for a
  redesign, so the merge keeps the redesigned control and restores `AdrTable`'s `onstart` prop
  and `GoalWorkspace`'s callback that the removal had dropped. The merge conflict was limited to
  those two files; the rest of `main` merged cleanly.
- Checks:
  - `bun run check`: 0 errors, 0 warnings (1723 files).
  - `bun test`: 366 pass, 0 fail across 59 files at this revision.
  - `client/lib/components/AdrTable.test.ts`: the Start contract is pinned by unit cases — with
    one record set as `goal.next`, exactly one Start carries `data-variant="default"` and it is
    that row's; a resolved row renders no Start; every Start's `aria-label` is
    `Start the implementation of <title>` and the names are unique; and an active manual run
    disables every Start. The 24px/4px/11px geometry, the single `primary` fill, the pointer
    cursor, and the empty resolved action cells were measured on the live page at the viewports
    above.
  - Every command cited above exists: `bun install` and `bun test` are bun subcommands,
    `bun run build` and `bun run check` resolve to defined `.devboard/package.json` scripts, and
    `client/lib/components/AdrTable.test.ts` is an existing file. The removed interface suite
    (deleted with the native harness in `8411b18d`) is no longer cited.
- Verdict: pass.

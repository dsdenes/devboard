# Validation — Decision record start control

- Page: Goal mode → Decision records, `#workspace-goal`,
  `section.panel.goal-adrs-panel` (`[data-testid="adrs-overlay"]`).
- Commit/branch: worktree `.worktree/issue-401`, branch `issue-401`, integrated with `main` at
  `b29c972`.
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
  `Button` primitive; `bun run verify:interface` covers its other consumers and the whole shell.
- Console/network: `bun run verify:interface` reports no console exceptions and no failed
  requests across the shell, including the Decision records page.
- Not run / blocked:
  - designmd MCP research was not run: `mcp://` has no MCP manager, so no design-kit receipt is
    claimed. The `skill://ui-ux` document is not installed in this session; the repository's
    `DESIGN.md`, `design/tokens.json`, `openui.json`, and prior `.design/` receipts were used.
  - The hover fill could not be measured in headless Chrome: `matchMedia("(hover: hover)")`
    reports false, so the primitive's media-gated `hover:bg-[var(--secondary)]` rule does not
    match. The rule is present in the built bundle and is shared with every other `Button`.
  - The disabled state was not forced through the fixture: making Start unavailable requires an
    active creation, revision, skills preparation, or manual run, and the fixture host has no
    prepared skills. The native `disabled` path is the shipped primitive's and is unchanged.
- Integration: `origin/main` gained `945e6b6 ui(adrs): remove the row Start button` for the
  malformed removal request #402, which captured the same element. Issue #401 asks for a
  redesign, so the merge keeps the redesigned control and restores `AdrTable`'s `onstart` prop
  and `GoalWorkspace`'s callback that the removal had dropped. The merge conflict was limited to
  those two files; the rest of `main` merged cleanly.
- Checks:
  - `bun run check`: 0 errors, 0 warnings.
  - `bun test`: 759 pass, 0 fail (57 files).
  - `bun run verify:interface`: passed, including the new Start contract (four controls, 24px
    Button at 4px radius and 11px type, centered within 1px, one filled primary on the `Next`
    row, unique record-naming accessible names, pointer cursor, and empty resolved action cells).
- Verdict: pass.

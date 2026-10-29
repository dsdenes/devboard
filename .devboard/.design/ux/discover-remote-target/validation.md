# Validation — Discover remote target

- Page: Discover mode → Overview, `#workspace-discover`,
  `[data-testid="discover-remote"]`.
- Commit/branch: worktree `.worktree/issue-775`, branch `issue-775`.
- Command: `cd .devboard && bun install --frozen-lockfile && bun run build`, then the source server
  at `http://127.0.0.1:8098/` with `PORT=8098`, `STATIC_DIR` in the worktree, `STATE_DIR` under
  the worktree, and `REPO_DIR`, `ADRS_DIR`, `GOAL_FILE` pointing at the repository. Two retained
  projects were seeded from `project.json` records; the active target was
  `https://github.com/octocat/Hello-World`.
- Viewports: 2101×1017 and 1024×720, dark and light.
- Playwright source: OMP browser (Playwright-backed Chromium).
- States exercised:
  - Retained projects, dark, 2101:
    `.devboard/.design/ux/discover-remote-target/retained-dark-2101.webp`
  - Retained projects, light, 2101:
    `.devboard/.design/ux/discover-remote-target/retained-light-2101.webp`
  - Retained projects, dark, 1024×720:
    `.devboard/.design/ux/discover-remote-target/retained-dark-1024.webp`
  - Retained projects, light, 1024×720:
    `.devboard/.design/ux/discover-remote-target/retained-light-1024.webp`
  - No retained projects, dark, 1024×720:
    `.devboard/.design/ux/discover-remote-target/empty-dark-1024.webp`
- Measurements on the rendered page (2101×1017, dark):
  - Panel 1706×256; header 30px; body 187px with an 8px rhythm; footer 37px.
  - The retained rows measured 28px and 29px (the second row adds its 1px `border-subtle`
    rule); the active row resolved to `accent-surface` `#16233a` with a 2px `#58a6ff` inset edge.
  - The URL renders in `mono-small` (11.5px mono) with its full value in the `title`; the
    `Active` badge renders exactly once; the `Remove` words sit on the trailing edge at 24px
    (`sm`), `muted-foreground` until hover.
  - Dropdown 440×28 at x=497.7; input 520×28 inside the `surface-raised` add band; the add band
    measured 1688×68; the footer's `Clear remote target` is the panel footer's only control.
  - At 1024×720 the panel measured 631×256 and the document did not scroll horizontally
    (`scrollWidth === clientWidth === 1024`).
- Interaction checks:
  - Selecting `Second-Project` produced exactly one active row and one move of the `Active`
    badge; the dropdown value followed.
  - Hovering the inactive row resolved to `row-hover` (`#1b2129`).
  - `Clear remote target` removed the active row's badge and the footer while both retained rows
    and both options stayed; selecting `Hello-World` restored the active row and footer.
- Dependent surfaces: the page header's Start control, the sheet, and the skills pages were
  unchanged; only the remote panel's markup and its page CSS changed.
- Not run / blocked:
  - The issue's captured fixture (one retained project) was replaced by a two-project fixture so
    active, inactive, and hover states could be compared in one panel.
  - No OpenUI or Storybook mutation was made; the panel composes the shipped `Button` and `Input`
    primitives, so no designmd research receipt is claimed.
- Checks:
  - `bun run check`: 0 errors, 0 warnings (1761 files).
  - `bun test`: 1070 pass, 1 fail in `server/goal-draft.test.ts` ("a failed peer keeps its
    draft and retry starts a new peer"); that file passes alone (22 pass) and the failing path
    never touches the client, so it is an existing concurrency flake rather than this change.
  - `bun run verify:interface`: reached and passed the retained-remote section (seeding two
    projects, dropdown options and selection, active row, switch, remove, restart, clear,
    invalid URL, and the gate-off host), then aborted at an unrelated pre-existing assertion:
    `the stopped poll line does not say it is not polling` (poll text `Tracker sync starting`,
    from the tracker sync added to `main` after the suite's expectation). Retried with that one
    stale assertion relaxed in a throwaway copy; the remote section passed again and the suite
    aborted later on two other unrelated pre-existing UI assertions (the activity-bar report
    control and the question header size). The script was restored byte-identically
    (`9ef6dd26…`) and is not part of the change.
- Verdict: pass for the changed surface; repository-wide `verify:interface` is red on `main`
  before this change and is not repaired here.

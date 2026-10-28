# Validation — Issues queue row

- Page: Issues mode → Queue, `#workspace-issues`,
  `[data-testid="issues-queue-item"]`.
- Commit/branch: worktree `.worktree/issue-283`, branch `issue-283`.
- Command: `cd .devboard && bun install --frozen-lockfile && bun run build`, then the
  source server at `http://127.0.0.1:8097/` with `PORT=8097`, `STATIC_DIR` in the
  worktree, `STATE_DIR` under the worktree, and `REPO_DIR`, `ADRS_DIR`, `GOAL_FILE`
  pointing at the repository. The queue was replayed from a copied
  `issues/<repo-key>/state.json` snapshot.
- Viewports: 2101×1017 and 1024×720, dark and light.
- Playwright source: OMP browser (Playwright-backed Chromium).
- States exercised:
  - Default queue, dark, 2101: `.devboard/.design/ux/issues-queue-row/queue-dark-2101.png`
  - Default queue, light, 2101: `.devboard/.design/ux/issues-queue-row/queue-light-2101.png`
  - Default queue, dark, 1024×720:
    `.devboard/.design/ux/issues-queue-row/queue-dark-1024.png`
  - Empty queue, dark, 2101:
    `.devboard/.design/ux/issues-queue-row/queue-empty-dark-2101.png`
  - Mixed lifecycle: `pending`, `running`, `handled`, `goal` + `running`, and
    `goal` + `pending` in one list; every row measured 29px.
  - Wireframe at 1440 and 390: `scrollWidth === clientWidth` at both widths.
- Measurements on the rendered page (2101×1017):
  - All 13 rows 29px tall; before the change the goal+running row measured 56px,
    with `running` at x=404 under the 68px number track.
  - `#281` `goal` and `running` badges share `top: 199`; the `running` badge's right
    edge is 2074 on a 2084px row, so it sits on the 10px trailing padding.
  - Number track 44px (`#281` link box left 402, width 44); title truncates with its
    full text in the `title` attribute.
  - Row hover resolves to `row-hover`; a keyboard `Tab` lands on the number link with
    a 2px `ring` outline and underline.
- Dependent pages: no shared component or token changed. The row composes the
  existing `ol`/`li`, anchor, and `.badge` primitives; `bun run verify:interface`
  covers their other consumers and the whole shell.
- Console/network: no console entries and no failed requests on the Queue page at
  either viewport.
- Findings:
  - The lifecycle badge no longer wraps when the `goal` badge is present; every row
    keeps one height and the state word keeps the trailing edge.
  - The 68px number track fell to 44px, matching the existing running-agent row.
  - Long titles ellipsize instead of widening the row; the meta group never wraps.
  - At 1024×720 the document does not scroll horizontally
    (`scrollWidth === clientWidth === 1024`) and the title is the only track that
    yields.
  - The empty state is a plain 39px line inside the panel with no row chrome.
  - Light-theme row hover resolves to `row-hover` (`#f6f8fa`), the same value as the
    light `surface`; the hover is therefore not visible in light mode. This is the
    existing token pair from `DESIGN.md` and is not changed by this run.
- Not run / blocked:
  - designmd MCP research was not run: no token, OpenUI, or Storybook artifact was
    mutated, so the skill's mutation gate does not apply. No research receipt is
    claimed.
  - The tracker link was not opened against GitHub; its `href`, `target="_blank"`,
    and `rel="noreferrer"` were verified in the DOM.
- Checks:
  - UI/UX preflight: `applicable: true`, no missing prerequisites,
    `DESIGN.md` lint 0 errors.
  - `bun run check`: 0 errors, 0 warnings.
  - `bun test`: 604 pass, 0 fail (46 files).
  - `bun run verify:interface`: passed, including a new queue-row geometry
    contract (uniform row height, goal and state badges on one line, state badge on
    the trailing edge) and a fixture where issue 19 is both a goal and running.
- Verdict: pass.

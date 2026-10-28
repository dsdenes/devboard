# Prepared skill detail — validation

Date: 2026-10-28. Environment: Linux, Chromium through the agent browser tool; fixture host at
`.devboard/.tmp/issue-346-host` seeded with the repository's five prepared skills.

## Commands

| Check | Command | Result |
|---|---|---|
| Unit suite (whole harness) | `cd .devboard && bun test` | **pass** — 704 tests, 0 fail |
| New renderer tests | `bun test client/lib/skill-document.test.ts` | **pass** — 9 tests |
| Types and Svelte | `bun run check` | **pass** — 1692 files, 0 errors, 0 warnings |
| Client build | `bun run build` | **pass** |
| Interface contract | `bun run verify:interface` | **partial** — every Skills-page assertion passes (including the new document checks); the run then aborts at line 4390 on a pre-existing check that expects an `ask-spawn` log line the stub never writes (it writes `ask-start`). Reloading the same stub-log check locally reaches a second pre-existing failure, `timed out waiting for the idle issues indicator`. Neither failure touches the Skills surface. |

## Browser evidence

Server: `PORT=8137 bun run start` from `.devboard` against the fixture host, `dist` from the
changed source.

| Viewport | Theme | State | Evidence |
|---|---|---|---|
| 2101×1017 | dark | one skill selected; frontmatter removed; heading, prose, and list rendered | `screenshots/skill-detail-2101-dark.png` |
| 1440×900 | dark | same document; list capped, document fills the remaining height | `screenshots/skill-detail-1440-dark.png` |
| 1024×720 | dark | document body scrolls inside its panel; no page scroll | `screenshots/skill-detail-1024-dark.png` |
| 1440×900 | light | mirrored palette; same structure | `screenshots/skill-detail-1440-light.png` |

Measured at 1024×720: `.goal-skill-detail .panel__body` is 222px tall with 476px of content, so
the document scrolls in place; `.goal-page--fill` has 0 horizontal and 0 vertical overflow. At
2101×1017 the list panel is 317px and the document 483px.

## Checks

- **Document rendering.** The shipped `<pre>` is replaced by semantic elements (`h1`, `p`, `ul`,
  `li`, `code`); the selected fixture renders a heading, eight list rules, and no frontmatter
  (`devboard-managed` absent). Unit tests cover CRLF, unclosed frontmatter, fenced code, raw HTML,
  safe and script links, and frontmatter-only files.
- **Identity.** Header shows the skill name and
  `.omp/skills/differential-conformance-testing/SKILL.md`; the description is not repeated
  (asserted by `verify:interface`).
- **List and document height.** List caps at 40%; document takes the rest with a 240px floor and
  owns the scroll. No page-level scrollbar at 1024×720 or 2101×1017.
- **Keyboard and focus.** List rows remain native buttons; links in the document use the global
  2px `ring` focus outline; the panel body scrolls with the keyboard.
- **Theme.** Both palettes render with the existing tokens; no new colors.
- **Console/network.** No console errors and no failed requests after selecting and switching
  skills.

## Not run

- Missing-file and metadata-only messages were not exercised in the browser; both use the shipped
  `.empty` line and the new branch is covered by the renderer unit tests for an empty body. The
  missing-file branch is unchanged from the shipped code.
- A screenshot with many skills is not included; the list already scrolls at 1024×720 with five
  rows and the cap is independent of row count.
- No automated visual regression baseline exists in this project.

# Prepared skill detail — validation

Date: 2026-10-28. Environment: Linux, Chromium through the agent browser tool; fixture host at
`.devboard/.tmp/issue-346-host` seeded with the repository's five prepared skills.

## Commands

| Check | Command | Result |
|---|---|---|
| Unit suite (whole harness) | `cd .devboard && bun test` | **pass** — 708 tests, 0 fail |
| New renderer tests | `bun test client/lib/skill-document.test.ts` | **pass** — 9 tests |
| Types and Svelte | `bun run check` | **pass** — 1693 files, 0 errors, 0 warnings |
| Client build | `bun run build` | **pass** |
| Interface contract | `bun run verify:interface` | **partial** — every Skills-page assertion passes, including the new document checks; the run then times out later at the Issues-page `idle issues indicator`, outside this change. |

## Browser evidence

Server: `PORT=8137 bun run start` from `.devboard` against the fixture host, `dist` from the
changed source.

| Viewport | Theme | State | Evidence |
|---|---|---|---|
| 2101×1017 | dark | one row expanded; frontmatter removed; heading, prose, and list rendered inline | `screenshots/skill-detail-2101-dark.png` |
| 1440×900 | dark | same document; expanded row sits in the list's scroll | `screenshots/skill-detail-1440-dark.png` |
| 1024×720 | dark | document wraps at 599px; panel body scrolls; no page scroll | `screenshots/skill-detail-1024-dark.png` |
| 1440×900 | light | mirrored palette; same structure | `screenshots/skill-detail-1440-light.png` |

Measured at 1024×720: the expanded detail is 609px wide and the document 599px; the
prepared-skills panel body shows 530px of an 861px scroll height; `goal-page--fill` has 0
horizontal and 0 vertical overflow. At 1440 the document measure is 940px.

## Checks

- **Document rendering.** The shipped `<pre>` is replaced by semantic elements (`h1`, `p`, `ul`,
  `li`, `code`); the selected fixture renders 11 blocks (a heading, eight rules) and no
  frontmatter (`devboard-managed` absent). Unit tests cover CRLF, unclosed frontmatter, fenced
  code, raw HTML, safe and script links, and frontmatter-only files.
- **Identity.** The expanded detail shows `.omp/skills/differential-conformance-testing/SKILL.md`
  above the document; the description is not repeated (asserted by `verify:interface`).
- **Accordion.** Expanding a row adds the inline `skill-content` region with `aria-expanded="true"`;
  clicking it again removes the region and clears the selected row. Collapse and re-expand were
  exercised in the browser (`collapsed 0` region after the second click, then reopened).
- **Scroll.** The prepared-skills panel body owns the scroll; the shell has no page scrollbar at
  1024×720 or 2101×1017.
- **Keyboard and focus.** Rows remain native buttons with `aria-controls`; links in the document
  use the global 2px `ring` focus outline; the panel body scrolls with the keyboard.
- **Theme.** Both palettes render with the existing tokens; no new colors.
- **Console/network.** No console errors and no failed requests after expanding, collapsing, and
  switching skills.

## Not run

- Missing-file and metadata-only messages were not exercised in the browser; the missing-file
  branch is unchanged from the shipped code and the metadata-only branch is covered by the
  renderer unit test for an empty body.
- No automated visual regression baseline exists in this project.

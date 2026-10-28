# Prepared skill detail — component requirements

Catalog checked: `openui.json` holds the shipped primitives (`Button`, `IconButton`, `Input`,
`PageHeader`, `StageTrack`). None renders a document. Existing workspace components such as
`AdrTable`, `Terminal`, and `MonacoEditor` are page-local and are not cataloged, so this change
modifies the page and adds one page-local renderer rather than a design-system primitive.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Render a skill body as a readable document (frontmatter removed, headings, prose, lists, fences, inline code, links) | **New page-local** `renderSkillDocument` + `skillBody` in `client/lib/skill-document.ts`; markup stays in `GoalWorkspace.svelte` | Not cataloged: not a reusable primitive | — | 0 body, metadata-only, one screen, 10× screen length, long unbroken identifiers, fenced code with `<`/`&`, nested lists, safe and script URLs, raw HTML, CRLF and unclosed frontmatter | Output is inert HTML: no script execution, raw HTML escaped, non-safe link schemes reduced to their label, external links carry `rel="noreferrer noopener"`; document container is plain `div` | No new tokens. `foreground`, `muted-foreground`, `border-subtle`, `border-strong`, `surface-raised`, `background`, `accent`; 2/4/6/8/12/16px steps, 3/4px radii |
| Identify the selected skill and its file | **Modify** page-local panel header: mono name on the left, `.omp/skills/<name>/SKILL.md` on the right | — | — | Very long names truncate the path, never the name; full path in `title` | Header remains the panel's labelled identity; path is text, not the only access to the file | `panel-title`, `panel-subtitle`; 8px gap |
| Give the document a stable frame while the list stays visible | **Modify** page-local layout: list caps at 40% with a detail; detail takes the rest with a 240px floor and owns the scroll | — | — | 0/1/20 skills; long documents; 1024×720 and 2101×1017; no horizontal page scroll | The list remains a `ul` of native buttons with `aria-current`; the document body is keyboard-scrollable; links keep focus rings | Existing page gap 8px; no new tokens |
| Explain a missing or instruction-free file | **Compose** existing `.empty` line | — | — | `content` absent; frontmatter-only body | Plain text in place of the document | `muted-foreground` |
| Switch skills | Existing list buttons and delete control | Unchanged | — | Selected row stays marked while the list scrolls; deleting the selected skill closes the document | Existing `aria-current` and delete `aria-label` | Existing |

## Dependency note

`marked` is already a shipped dependency (`^18.1.1`, used nowhere else in the client yet). No
new package, token, catalog entry, or story is introduced. The renderer is unit-tested in
`client/lib/skill-document.test.ts`; the page contract is exercised by `verify:interface`.

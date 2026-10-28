# Prepared skill detail — component requirements

Catalog checked: `openui.json` holds the shipped primitives (`Button`, `IconButton`, `Input`,
`PageHeader`, `StageTrack`). None renders a document. Existing workspace components such as
`AdrTable`, `Terminal`, and `MonacoEditor` are page-local and are not cataloged, so this change
modifies the page and adds one page-local renderer rather than a design-system primitive.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Render a skill body as a readable document | **New page-local** `renderSkillDocument` in `client/lib/skill-document.ts`; markup stays in `GoalWorkspace.svelte` | Not cataloged: not a reusable primitive | — | 0 body, metadata-only, long document, long identifiers, fenced code, nested lists, safe and script URLs, raw HTML, CRLF, unclosed frontmatter | Inert HTML: raw HTML escaped, script links reduced to their label, external links get `rel="noreferrer noopener"` | No new tokens: `foreground`, `muted-foreground`, `border-subtle`, `surface-raised`, `background`, `accent`; 4/8/16px, 3/4px radii |
| Identify the expanded skill's file | **Compose** a `mono-small` path line above the document inside the shipped `.skill__detail` | — | — | Very long names truncate the path, never the row name; full path in `title` | Path is text with a `title`; the disclosure button carries the accessible name | `muted-foreground`, `mono-small`; 8px below |
| Grow the document inside the expanded row | **Modify** page-local detail content; the shipped accordion (`.skill__detail`, chevron, `aria-expanded`, `aria-controls`) is unchanged | — | — | 0/1/20 skills; long documents; 1024×720 and 2101×1017; no horizontal page scroll | Rows stay native buttons; the list panel body scrolls with the keyboard; links keep focus rings | Existing list/panel spacing; no new tokens |
| Explain a missing or instruction-free file | **Compose** existing `.empty` line | — | — | `content` absent; frontmatter-only body | Plain text in place of the document | `muted-foreground` |
| Switch and collapse skills | Existing accordion row and delete control | Unchanged | — | Expanding another row collapses the previous one; deleting the expanded skill closes the detail | Existing `aria-expanded`, `aria-current`, and delete `aria-label` | Existing |

## Dependency note

`marked` is already a shipped dependency (`^18.1.1`, used nowhere else in the client yet). No
new package, token, catalog entry, or story is introduced. The renderer is unit-tested in
`client/lib/skill-document.test.ts`; the page contract is exercised by `verify:interface`.

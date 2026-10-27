# Discover mode — component requirements

The page is assembled from the three shipped primitives (`Button`, `IconButton`, `Input`), the
CSS-defined structural patterns documented in `DESIGN.md` (`.panel`, `.badge`, `.message`,
`.sidebar-item`, `.discover-*`), and four existing parameterized components (`DataTable`,
`DetailSplit`, `MonacoEditor`, `Terminal`). No new primitive is required. The one shell change is
an extension of the existing `ActivityBar` component: the mode rail gains a visible label per tab.

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Mode navigation with visible labels | Modify | n/a (shell chrome, not a catalog primitive) | n/a; covered by `verify:interface` and screenshots | 3 fixed modes; active mode; disabled none | `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, visible label, tooltip with shortcut | `overline`, `muted-foreground`, `accent`, `activity-bar`, `secondary` |
| Contextual sidebar item with meta | Reuse + compose | n/a (`.sidebar-item`) | `Shell/SidebarItem` states | label, optional meta, optional badge, active, long label | native button, `aria-current`, title for full text | `body-small`, `mono-small`, `accent-surface` |
| Project identity header with stale marker | Compose (`Text` + `.badge` + `Button`) | Button | `Button/Primary`, `Button/DisabledWithReason` | project name, full path title, stale boolean, definition, commit/time | heading level 1, `title` on the name, badge carries the word | `page-title`, `body`, `mono-small`, `badge` |
| Primary run action | Reuse | Button | `Button/Primary`, `Button/DisabledWithReason` | socket state, active run, busy text, hasArtifacts | native disabled + `title` naming the reason | `button-primary` |
| Stop action | Reuse | Button | `Button/Destructive` | active run | native button, visible focus | `button-destructive` |
| Active run panel and activity log | Reuse (`Terminal`) + compose | n/a | `Shell/Terminal` | lines, run id, startedAt, stop enabled | labelled terminal region, Stop reachable by keyboard | `mono`, `surface` |
| Question and answer | Compose (`Button`, `Input`) | Button, Input | `Input/Default`, `Button/Answer` | message, 0–n options with recommended flag, draft, empty draft | labelled input, submit button, options are buttons | `input`, `choice` |
| Error / interrupted / transition lines | Compose (`.message`) | n/a | `Shell/Message` tones | severity notice/warning/error, long text | `role="alert"` on errors, `role="status"` on transient | `error-surface`, `warning-surface`, `accent-surface` |
| Remote target strip | Compose (`Input`, `Button`) | Input, Button | `Input/Url`, `Button/Outline` | URL draft, disabled reason, cloning, active target, clear | labelled input, submit disabled with title | `input`, `button-outline` |
| Fact list (runtime/deployment/CI/branching) | Reuse (`.discover-facts`) | n/a | `Data/FactList` | 0–n known facts; unknown hidden, empty section states | definition list (`dl/dt/dd`) | `body-small`, `mono-small`, `muted-foreground` |
| Commands table | Reuse (`DataTable`) | n/a | `Data/DataTable` dense rows | 0–8 rows, long commands, header hidden, wrapping | table semantics, row command optional | `mono`, `body-small` |
| Testing summary and levels | Reuse (`DataTable`) | n/a | `Data/DataTable` | total tests, 0–5 levels, suite command, paths | table semantics; stats are text, not decoration | `body`, `mono` |
| Bounded contexts table | Reuse (`DataTable`) | n/a | `Data/DataTable` | 0–n contexts, long responsibility, entry points list | table semantics, fixed columns | `mono-small`, `body-small` |
| Stack chips with links | Compose (`a` + `.chip`) | n/a | `Data/ChipLink` | 0–n entries, some with repository URLs, long names | links named by their text, external marker in title | `mono-small`, `accent` |
| Discover page header | Compose (`.discover-page__header`) | n/a | n/a; composition, not a component | eyebrow, title, subtitle, actions, meta | one `h1` per page, actions after the heading | `page-title`, `body-small`, `overline` |
| Glossary search | Reuse (`Input`) | Input | `Input/Search` | empty, long query, no matches | labelled by `aria-label`; `type="search"` | `input` |
| Minimum-use slider with output | Compose (`input[type=range]` + `output`) | n/a | `Data/Threshold` | min 0, max measured uses, current value, max=0 disabled | labelled range input, `output` shows `≥ n` | `accent` for the track, `label` |
| Glossary context card with table | Reuse (`DataTable` + `.panel`) | n/a | `Data/DataTable` | 0–n contexts, 0–n terms, long labels, examples | table semantics; row is a button-equivalent with Enter/Space | `panel`, `badge` |
| Glossary filtered-empty | Compose (`.empty` + `Button`) | Button | `Shell/EmptyFiltered` | active query and threshold, reset action | reset button named | `body-small` |
| Term main pane | Reuse (`.panel` + `.discover-facts`) | n/a | `Data/FactList` | long definition, missing definition, 0 uses, many examples | heading, definition list | `body`, `mono-small` |
| Term detail pane with split | Reuse (`DetailSplit`) | n/a | `Shell/DetailSplit` | labels missing, 0–n related terms, narrow pane | separator is keyboard-resizable; panes labelled | `panel` |
| Skill header | Compose (`.discover-page__header` + `.badge`) | n/a | `Shell/PageHeader` | state generated/edited/missing, file path, purpose | heading, state carries the word | `page-title`, `mono-small`, `badge` |
| Skill editor with dirty marker | Reuse (`MonacoEditor`) | n/a | `Editor/Monaco` | empty text, long text, dirty, save failure | labelled editor, `data-dirty`, Ctrl+S | `mono` |
| Skill save/restore | Reuse (`Button`) | Button | `Button/Primary`, `Button/Outline` | dirty, generated, missing, save in flight | disabled states carry a title | `button-primary`, `button-outline` |
| Warnings list | Compose (`.panel` + numbered rows) | n/a | `Shell/WarningList` | 0–n warnings, long text | ordered list semantics | `body-small`, `warning-surface` |
| Empty explanation and written paths | Compose (`.panel`, `code`, list) | n/a | `Shell/EmptyState` | no artifacts, run disabled reason | heading + description; list of paths | `body`, `mono-small` |

## Component details

### Mode rail (ActivityBar)

- Decision: **modify** the existing shell component. The three tabs keep their `data-testid`,
  `aria-controls`, `data-command`, tooltip, and Alt+1/2/3 behavior; each gains a visible label and
  the rail widens from 44px to 64px.
- Why: the current icon-only rail hides the product's primary navigation behind hover. The user
  asked for the common menu to be redesigned; labels are the smallest change that removes the
  discovery failure without adding a second navigation model.
- Data shapes: fixed three-mode list; active mode from `layout.mode`.
- States: default, hover, selected, focus-visible.
- Edge cases: 1024×720 (labels must not clip); tooltips still name the shortcut; the rail never
  collapses to icons.
- Accessibility: `role="tablist"` + `role="tab"`, `aria-selected`, `aria-controls`, visible text;
  `aria-label` still includes the shortcut.
- Tokens: `activity-bar`, `secondary`, `border-strong`, `accent`, `muted-foreground`, `overline`.
- Storybook: none. It is shell chrome with no reusable props; its contract is exercised by
  `bun run verify:interface` (three tabs, labels, commands, keyboard, 1024×720 clipping).
- OpenUI: none. The catalog describes the reusable primitives.

### Sidebar identity and items

- Decision: **compose**. Add a mode overline above the existing `.sidebar__title`; keep the title
  text equal to the document title (the repository path). Discover items gain an optional meta
  slot (glossary term count, skill exception state).
- Why: the header currently names only the path, so the mode is invisible below the rail; the
  glossary count and skill exceptions are navigation facts the user needs before opening a page.
- States: generated (no meta), edited, missing, active, long label.
- Accessibility: `aria-current="true"` on the active item; meta text is part of the accessible
  name, so the exception is not color-only.
- Tokens: `overline`, `mono-small`, `warning`, `error`.

### Page header

- Decision: **compose** with existing classes. Standard slots: eyebrow (mode/breadcrumb), `h1`,
  subtitle, meta row, actions.
- Why: every Discover page had a different header shape (or none); one frame makes the drill-in
  pages navigable and keeps the primary action in the same place.
- States: with/without actions; with/without meta; with a back control on term pages.
- Edge cases: long project names wrap; actions wrap below the title at narrow widths.
- Accessibility: one `h1` per page; the back control precedes the title in DOM order.
- Tokens: `page-title`, `body-small`, `overline`, `mono-small`.

### Term detail split

- Decision: **reuse** `DetailSplit` with a 58/42 default and a minimum pane width of 160px.
- Why: the split is the established pattern for a main record plus context. The shipped detail
  pane held only three short fields; the redesign fills it with labels and related terms.
- States: main always; detail may be empty (`No labels recorded.`).
- Accessibility: the existing separator keeps `role="separator"`, arrow-key resize, and the label.

### Skill page

- Decision: **compose**. The page header sits outside the `discover-skill` container so the
  editor keeps the pane height; the editor's own 34px toolbar holds the file name, dirty marker,
  Save and Restore.
- States: generated, edited/dirty, missing, save failure.
- Edge cases: 0-byte skill? A missing skill shows the recreate action and an empty editor.
- Accessibility: editor label names the skill; Save and Restore are native buttons with titles.

## Catalog scope

The OpenUI catalog documents the three reusable primitives and their props. `.panel`, `.badge`,
`.message`, `.sidebar-item`, and the `.discover-*` classes are structural CSS patterns with no
component API, and `DataTable`, `DetailSplit`, `MonacoEditor`, and `Terminal` are page-level
components whose props are documented in source. Adding catalog entries for them would describe a
second prop system that does not exist. The changed shell component (ActivityBar) is covered by
the interface verifier rather than a primitive story. `DESIGN.md` and `design/tokens.json` change only
where the shell layout prose changes; no color, type, radius, or spacing token is added.

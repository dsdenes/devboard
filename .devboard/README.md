# Devboard

Local browser interface for a repository's goal, Flow implementation, and Discover artifacts.
It renders one full-viewport, dark-first administration workspace with an activity bar, a
contextual sidebar, one workspace page per mode, resizable split panes, read-only document views, xterm
terminals, a command palette, and a status bar. Every mode is a client-side view over the existing
WebSocket contract; the server still owns all work and durable state.

## Interface

The interface is a desktop tool. It requires a viewport of at least 1024×720 CSS pixels. Below
either threshold the shell is not rendered: a notice carrying
`data-testid="unsupported-viewport"` states the minimum instead, so the application never
degrades into a clipped mobile layout.

### Application shell

`data-testid="app-shell"` fills the viewport exactly. It contains, in order:

|Region|Test hook|Role|
|---|---|---|
|Mode rail|`activity-bar`|Five labeled mode tabs and their Lucide icons|
|Sidebar|`sidebar`|Contextual navigation for the active mode|
|Workspace|`workspace`|The open surface; absorbs all remaining space|
|Status bar|`status-bar`|Connection, project name, lane count, issues state, watchdog, versions, reload|

The status bar stays visible while panes resize, and the document itself never scrolls
vertically or horizontally. Each mode's panel keeps its scroll position, focus, and open page while
another mode is shown.

### Buttons

Every button in the interface is the one primitive in
`.devboard/client/lib/components/ui/button.svelte`. A component never renders its own `<button>`
element; a bespoke control such as a sidebar row, a choice, a palette item, or a status item uses
that primitive's `bare` form and keeps its own class and geometry. `IconButton` is the square icon
form built from the same variant table, and `CommandButton` composes the primitive for a control
that dispatches a WebSocket command; it renders no button of its own.

- An activation paints a pressed fill immediately, from pointer-down until pointer-up and while
  `Enter` or `Space` activates the control, in both the dark and the light theme. The pressed rule
  reuses existing role tokens and adds no color token.
- A control whose activation dispatches a WebSocket command replaces its visible label with the
  present participle of its own verb followed by `…` — `Start` → `Starting…`, `Save` → `Saving…`,
  `Check` → `Checking…`, `Discover project` → `Discovering…` — carries `aria-busy="true"`, and
  takes no second frame from a pointer or the keyboard while it waits.
- Busy ends when the confirming server state arrives, and the control then renders the resting
  label from that state. No control flips a domain flag to fake immediacy.
- A control that only changes client state — a mode switch, a tab, an accordion, the palette, a
  notification dismiss, a dialog cancel — never enters busy and shows the pressed fill only. A
  disabled control never enters busy and keeps its 45% opacity.
- A 28px icon control that dispatches a command sets `aria-busy="true"` and changes its accessible
  name and `title` to the busy phrase (`Reloading…`, `Filing issue…`), keeping its square and
  adding no inline text.
- If no confirming state arrives within 10 seconds, the control returns to its resting label and a
  `role="status"` notice beside it states that the action received no answer and names the action
  in words. The notice is dismissed by its own control or by the next activation of that control.

A control added later follows the same rule: use `Button`, or `CommandButton` when it dispatches,
pass its resting label, and let the primitive paint the pressed fill and own the busy word. A raw
`<button>` in a component is a defect.

### Mode rail

The 72px rail presents exactly five modes in this order as `role="tab"` controls:
`data-testid="mode-goal"`, `data-testid="mode-issues"`, `data-testid="mode-flow"`,
`data-testid="mode-discover"`, and `data-testid="mode-devboard"`. Each is a 64×52px control with a
Lucide icon above a visible 10px uppercase label (`Goal`, `Issues`, `Flow`, `Discover`,
`Devboard`), an accessible name that also names the shortcut, `aria-selected`, and `aria-controls`
naming its workspace panel. The labels never collapse to icon-only and never overflow the tab at
the 1024×720 boundary. A fresh profile starts on Goal. Clicking a tab or pressing Alt+1, Alt+2,
Alt+3, Alt+4, or Alt+5 changes only which mounted view is shown; it never sends a WebSocket frame.

The sidebar has no header: it starts with the active mode's navigation, because the rail already
names the mode and the status bar names the project.

### Sidebar

The sidebar is always visible and has no hide control or collapse shortcut. It is initially 300
CSS px wide, constrained to 200–600 CSS px, and resized by dragging its separator or pressing the
arrow keys with that separator focused. Double-clicking the separator restores the default width.
The width survives a reload.

- **Goal** lists the goal workspace surfaces, one **Skills** entry carrying the prepared-skill
  count that opens the prepared-skills table, the pending ADR records (title, status, next marker,
  file), and the lifecycle lanes. The entry never nests a per-skill menu, and the ADR records
  group is absent while no record is pending.
- **Flow** lists the workspace surfaces — overview, decision board, steering, and history — the
  session and PR state, widgets, changed files, checkpoints, and blockers. Blockers open the
  overview at the blocker they name.
- **Devboard** carries the **Background agents** group — Auto Scout, Watchdog, Design System,
  MCP optimizer, and Release Train — then exactly three `data-testid="devboard-tab"` entries: `MCP
  tools` (`data-command="devboard.tab.tools"`), `Skills` (`data-command="devboard.tab.skills"`),
  and `Complexity` (`data-command="devboard.tab.complexity"`), directly after `Skills`.
  Each agent entry opens its page; the last three open the read-only MCP tool list, the Skills
  table, and the complexity dashboard.
  No entry is repeated per tool, per skill, or per recorded date, so adding or removing one
  never changes the menu. No tool, skill, or file name appears in the sidebar.
- **Discover** lists the overview, glossary, and contribution sections, the six skills under their
  own group, and warnings only while at least one exists. The glossary entry carries the published
  term count. A skill carries a `generated` state silently and shows `edited` or `missing` as trailing
  meta, so an exception is visible before the page opens. The Glossary entry is a plain section
  link: it has no disclosure control and no nested per-term menu. Switching to another retained
  project shows that project's own read-only skill text.

Selecting an entry opens or focuses its workspace surface. Informational entries open the
surface that holds the same facts. The Flow overview opens with the read-only flow goal, which
takes the full page height; while a goal interview is running the panel collapses to its header.
The `flow-goal-active` interview block follows it only while the interview holds a pending
question, so an answered interview leaves no empty panel behind. The implementation activity
moves to the pinned activity bar, so the overview keeps the read-only goal, the pending
implementation question, widgets, files, blockers, and verification.

### Workspace page

Each mode shows exactly one page at a time and renders no tab strip. Opening an ADR, a Flow
widget, changed file, or checkpoint, or a Discover skill replaces the visible page; the previous
selection is reachable again from the sidebar or the palette. Close controls inside a page return
to an empty page; no document page carries unsaved state, so closing one never asks to discard
anything.

The Devboard page is `data-testid="devboard-workspace"` and holds
`data-testid="mcp-tools-list"`: one compact `data-testid="mcp-tool"` row per tool the Devboard MCP
server answers `tools/list` with, carrying `data-tool="<tool name>"` and rendering the tool's name,
its title, its description verbatim in catalog order, and a `data-testid="mcp-tool-invocations"`
count with `data-invocations="<count>"` and an `N invocation` or `N invocations` label. The page
reads server-provided data only: it renders no button, input, copy control, or link, issues no
`tools/call`, writes no clipboard, and adds no roster of its own, so adding or reordering a
catalog entry changes the page on the next server start with no client-source edit. The catalog
and its counts arrive through the dashboard's existing read-only `getMcpTools` command; no HTTP
route or second socket is involved. While the socket is open the page asks for that frame every
five seconds, so counts follow calls a peer makes without a reload.

### Skills page

The `Skills` sidebar entry opens the Devboard mode's other page. It renders one
`data-testid="skills-table"` table with three columns: skill, enabled, and actions. Each row
carries `data-testid="skill-row"` and `data-skill="<name>"`; its first cell holds one
`data-testid="skill-disclosure"` button naming the skill installed under the repository's
`.omp/skills` root verbatim, its second cell holds exactly one `data-testid="skill-enabled"`
checkbox, and its third holds at most one delete control. A built-in row carries a
visible `Managed` label, and a prepare-family row carries one
`data-testid="delete-skill"` control with accessible name `Delete <skill>`. Built-in,
Discover-generated, hand-authored, and symlinked rows carry no delete control, and no row carries
a description or family text. Managed rows lead the table: every built-in row renders above every
other row, and each of the two groups follows the skill name, so the package's own skills stay at
the top however the server orders its frame. The rows come from that directory and nothing else: a
skill directory holding a `SKILL.md` appears whether hand-authored, prepared, Discover-generated,
or reached through a symlink, while a name only a Discover manifest carries and no directory backs
produces no row.

One click on a prepare-family row's delete control removes the whole `.omp/skills/<name>/`
directory with no confirmation dialog. The row leaves without a reload, and a reload keeps it
gone. Deleting removes exactly that skill's name from `skills.ignoredSkills` when it is there and
writes no other settings key or exclusion entry; deleting an enabled skill writes no settings
entry at all. The server refuses the command for a built-in, Discover, hand-authored, symlinked,
or non-installed name, and for every name while Goal or Flow work is active; a refusal leaves the
directory, the settings file, and the row unchanged. Creating a directory still adds its row
after the next page load, and the sidebar entry count never changes.

Rows are collapsible. Clicking a row anywhere outside the checkbox, clicking its disclosure
button, or focusing the row and pressing Enter or Space expands it: one
`data-testid="skill-content-row"` follows, carrying one `data-testid="skill-content"` region with
the row's `data-skill` whose content is that skill's `SKILL.md` body rendered as sanitized
Markdown, with the YAML frontmatter omitted. The whole `SKILL.md` arrives on the row itself with
the `installedSkills` frame, beside the name and enabled state, so expanding one asks for no
second read, route, or file. Only an expanded row renders a content row; the same click, button,
or key collapses it and removes that row. A checkbox click toggles the exclusion and never
expands the row. The table's collapsed text carries no skill body.

A fresh skill starts checked. Unchecking one adds exactly its name to `skills.ignoredSkills` in the
project-level OMP settings at `.omp/settings.json`, the file a plain `omp` session at the
repository root reads, so every OMP session, Task subagent, and dashboard-launched agent started
there omits that skill; checking it removes exactly that name and leaves every other entry as it
was. The skill stays installed with its bytes, row, and `SKILL.md`, and the exclusion survives a
page reload, a dashboard restart, a harness update, and a rerun of `.devboard/install.sh`, which
never copies that file. A toggle applies to sessions and runs started afterwards; opening the page
starts no agent, and a toggle never stops, restarts, or edits a skill or a live run.

### Complexity page

The `Complexity` sidebar entry follows `Skills` and opens the Devboard mode's complexity page,
`data-testid="complexity-page"`. Every figure on it comes from a recorded daily snapshot of this
harness's own application source: `.devboard/crates/**/*.rs` and
`.devboard/client/**/*.{ts,svelte}`. Test files (`*.test.*` and every `tests/` directory), `target`,
`node_modules`, `dist`, `.tmp`, and `public` are never read. The analyzer is a deterministic token
scanner inside the dashboard process: it needs no parser, external binary, network call, or
runtime dependency, and two analyses of the same unchanged tree produce the same values.

One snapshot records three levels. Per function it records cyclomatic complexity (1 plus the
language's decision points in its own body: `if`, `for`, `while`, `loop`, `match` arms, `&&`, and
`||` in Rust; `if`, `for`, `while`, `do`, `catch`, `case`, `&&`, `||`, `??`, and a ternary `?` in
TypeScript and Svelte), source length in lines, maximum brace-block nesting, and parameter count.
Per file it records non-blank, non-comment lines of code, function count, duplicated-line ratio,
and a maintainability index clamped to 0-100 and derived from Halstead volume, mean cyclomatic
complexity, and lines of code. Per project it records file count, function count, total lines of
code, mean and maximum cyclomatic complexity, the number of functions above cyclomatic complexity
10, the duplicated-line ratio, and the mean maintainability index. A line counts as duplicated when
its normalized tokens (comments removed, at least four tokens) appear more than once across the
analyzed set.

The page renders `data-testid="complexity-summary"` with the latest snapshot's date, its recording
timestamp, and the recorded-date count; one `data-testid="complexity-card"` per project metric with
`data-metric` and the latest `data-value`; one `data-testid="complexity-series"` per project metric
with `data-points`, one `data-testid="complexity-series-point"` per recorded date carrying
`data-date` and `data-value`, and a `data-testid="complexity-series-latest"` marker on the newest
point; and one `data-testid="complexity-file-table"` whose `data-testid="complexity-file-row"` rows
carry `data-path` and one `data-testid="complexity-cell"` per per-file metric. Each series is
scaled to its own range, so a changed value between two dates moves its point and its line
direction. Clicking any `data-testid="complexity-sort"` header orders the table by that column, and
a second click reverses it; the default order is the file path.

Snapshots live in `<stateDir>/complexity/<24-hex project key>/<YYYY-MM-DD>.json`, the same project
key the journal and dashboard state use, and nowhere else. The server records exactly one snapshot
per UTC calendar day: at server start and whenever the UTC date changes while it runs, it records
that day when and only when no file for it exists. A restart, a page open, a reload, a reconnect,
or a later check on the same day writes no second file, which needs no background worker,
detached process, or service. `DEVBOARD_COMPLEXITY_NOW` pins the analyzed instant for a fixture
host or a verification run; the real clock is used when it is unset or unparseable.

A reload restores the active mode, each mode's open page, sidebar and split sizes, and theme. All
of that state lives in `localStorage`; none of it is sent to the server. A layout snapshot written
before Devboard existed still restores every stored mode and page; Devboard starts on its default
`MCP tools` page.

### Single-agent activity bar

Every page whose work is exactly one agent leads its workspace with the same pinned bar. It is
the first element of the page, outside every scrolling region, spans the workspace width with the
standard 8px horizontal padding, and stays fully visible while the page content scrolls. Switching
tabs or modes replaces its content with the new page's agent and collapses it.

The surfaces are the four background-agent pages (`agent-page` for `scout`, `watchdog`, `design`,
and `mcp-optimizer`), the Discover agent pages (`discover-agent`), the Discover run pages
(`discover-panel` for overview, glossary, skill, and warnings), the Goal lane page
(`lane-header`), the Goal single-record page (`record-header`), the Issues focus tab
(`issues-agent-focus`), the Flow overview (`flow-view` overview), and a Flow conversation
(`flow-conversation`). Pages that can host several agents at once — the Goal implementation
overview, the Issues overview, the Issues Agents grid, Drafts, the Queue, and Runs — keep their
current fleet controls and render no bar. The Goal decision-records, document, and skills pages,
the MCP tools page, and the Flow decision board, checkpoint, and file pages also render none, and
a page with no attached agent renders none.

Collapsed, the bar is one row. `data-testid="agent-activity-dot"` carries no visible text and
`data-state` `running`, `idle`, `succeeded`, `failed`, or `stopped`;
`data-testid="agent-activity-last"` shows the newest non-empty activity line on one line with an
ellipsis and the complete line in its `title`, or the muted `No activity yet.`;
`data-testid="agent-activity-toggle"` carries `aria-expanded`; `data-testid="agent-activity-control"`
holds at most one existing start/stop control; and `data-testid="agent-activity-question"` appears
only while the page's agent waits for an answer. The collapsed row never shows a run identifier,
`Run in progress`, `Running`, `started …`, or a lifecycle badge.

While running, the dot uses the accent token and a continuous 1.8-second pulse, and hovering or
focusing it reveals the current run's ISO 8601 start time in the `title` and the accessible name.
Any other state uses the muted-foreground token and does not animate; no start time is claimed
while idle. Under `prefers-reduced-motion: reduce` the pulse is removed while the running color and
`data-state` remain.

Activating `data-testid="agent-activity-toggle"` expands an inline
`data-testid="agent-activity-log"` below the row, inside the same docked region and above the page
content. It holds every retained activity line, newest last, in a scrollable region that follows
the newest line only while the operator is at the bottom. Activating the toggle again collapses it;
another tab, mode, or a reload starts collapsed. The expanded panel never contains a run identifier.

Each existing control moved into `data-testid="agent-activity-control"` keeps its test id, command,
label, disabled conditions, title, and effect, and the page no longer renders a second copy:
`agent-start`/`agent-stop` for background agents, `discover-start` and `discover-stop` on the
Discover Overview, `discover-agent-start`/`discover-agent-stop` for a Discover agent card and for
the Glossary and skill pages, which start and stop the agent that owns them, the Goal record
`start`, and `start-flow-implementation`/`stop-flow-implementation` for the Flow overview. The
Discover warnings page follows the seven-agent suite and carries no control. The Goal lane, the
Issues focus tab, and a Flow conversation show no bar control. `create-flow-goal` remains a page
action. Moving a control never adds a backend command or a per-agent Stop.

The removed page content is `discover-run-tag`, `discover-agent-run-tag`, `discover-agent-status`,
`agent-lifecycle`, `agent-detail`, `issues-agent-focus-run`, `issues-agent-focus-run-id`,
`issues-agent-focus-run-started`, `issues-agent-focus-activity`, `lane-status`, `lane-activity`,
`flow-status`, `flow-activity-section`, `flow-goal-activity`, and `flow-conversation-activity`.
Titles, identity, questions and answer forms, errors, notices, interrupted banners, agent settings,
filed issues, record facts, Flow messages and conclusions, and Discover artifact warnings stay in
the page. The left mode rail and the footer status bar are unchanged.

### Split panes

PaneForge groups provide the sidebar/workspace split and the workspace/detail split used by Flow
widgets and diffs and by the Discover skill detail. Separators are focusable, carry
`role="separator"` with `aria-orientation`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`,
resize by drag and arrow keys, reset to their defaults on double-click, keep both panes at least
160 CSS px wide, persist their sizes, and never cover the status bar.

### Command palette

Ctrl/Cmd+K opens `data-testid="command-palette"`. It has a search input
(`command-palette-input`) and command items (`command-item`), filters as you type, moves with
ArrowUp/ArrowDown/Home/End, runs with Enter, closes with Escape, and restores focus to the
previously focused element. Every actionable control carries a stable `data-command`, and the
palette exposes the same command ids; disabled commands show the same reason as their control.
Commands that need text focus the relevant input rather than inventing a value.

The palette covers navigation, opening every record, lane, widget, file, checkpoint, term, and
skill, lifecycle start/pause/resume/stop, Goal commands, Flow goal and decision editing, Flow
start/stop and PR actions, Discover start/stop and skill editing, the theme toggle, reset layout,
reload when stale, and the `Report UI issue`, `Remove element`, and `Redesign element` actions
(`app.report`, `app.remove`, `app.redesign`, and `app.report.cancel`).

### Keyboard shortcuts

|Shortcut|Action|
|---|---|
|Ctrl/Cmd+K|Open the command palette|
|Alt+1 / Alt+2 / Alt+3 / Alt+4|Switch to Goal / Issues / Flow / Discover|
|Escape|Close the palette, dialogs, and overlays|

Shortcuts are inert while text is being typed, except palette and Escape. Every shortcut
is listed in the palette or in the control's tooltip. Focus rings are always visible; dialogs
trap focus and restore it on close.

### Theme

A fresh profile starts dark with `data-theme="dark"` on the root element, regardless of the OS
preference. The status-bar control and the palette toggle between dark and light; the choice
persists and an inline head script applies it before the first paint, so there is no wrong-theme
flash. Both themes define every token used by the shell, tables, document views, terminals, diffs,
status indicators, and overlays. Body text and muted text meet 4.5:1 contrast; interactive
borders and focus rings meet 3:1; no state is conveyed by color alone. `prefers-reduced-motion:
reduce` disables nonessential transitions.

### Dense data views

TanStack Table renders the ADR record list and the Discover command, testing, architecture,
dependency, unknown-field, and glossary tables. The ADR table keeps title, status,
pending or resolved state, next marker, file, and decision summary; selecting a row opens its
detail page without navigating away. Body and table text is 12–14 CSS px, paths, code, diffs,
terminal output, and IDs are monospace, one-line data rows are at most 32 CSS px tall, and wrapped
data rows stay within 120 CSS px. The shell uses
the full viewport with no application max-width.

### Source-only marker

A control that exists only while Devboard serves its own harness source checkout carries one
shared marker: `data-testid="source-only-badge"`, the word `devboard`, the tooltip
`Only available when Devboard serves a harness source checkout`, the `.badge` primitive with no
tone, and `SourceOnlyBadge.svelte` as its only implementation. It is a child of its region header
immediately after the title, and a trailing count or subtitle stays on the header's trailing edge.
Discover's manual-testing target panel header carries it; an installed host renders no marker
anywhere. Agent prompt sections never carry it: they are read-only in every host.

### Read-only documents and terminals

Every instruction document is displayed as the exact bytes on disk, never as an editor. The
Goal document renders `GOAL.md` in `data-testid="goal-text"`; the Flow goal renders the session
goal in `data-testid="flow-goal-text"`; the Flow decision board renders `decisions.md` in
`data-testid="flow-decisions"`; and a Discover skill renders its live `SKILL.md`, or the
generated baseline while that file is missing, in `data-testid="discover-skill-text"`. Each is a
scrollable monospace `<pre>` region with an accessible label. None contains a `textarea`, an
`input`, a `[contenteditable]` node, or an editor widget, and none exposes a Save, discard, or
restore control, a dirty marker, or Ctrl/Cmd+S.

Documents change only through agents: `create-goal` and `revise-goal` run the goal agents,
`create-flow-goal` runs the Flow goal interview, the server appends a Flow widget conclusion to
the decision board, and the Discover agents publish their skills. The Goal document page fills
the workspace with the read-only text, and its footer keeps the Revise goal action without any
guidance field. Flow diffs remain rendered by `diff2html`; the client never parses unified diff
hunks.

Save controls remain for the settings that are not documents: an agent's cadence and limits and
a provider subscription. Each reports its confirmed write with the shared transient
`data-testid="save-feedback"` status beside that control. Only the confirmation mounted beside
the Save control that sent the write renders; it replaces the previous confirmation and clears
itself after three seconds. It appears only after the server confirms the exact value it
persisted; a refused or invalid save keeps its existing inline error or alert and shows no
confirmation.

xterm.js renders read-only Goal current activity and history. Every single-agent page instead
shows its activity through the shared activity bar. Terminals preserve ANSI output, are
selectable and copyable, auto-scroll unless the developer scrolls away, keep a bounded
scrollback, and expose their full buffer to assistive technology.

### Notifications and status bar

Server errors and notices appear in the notification region (`data-testid="notifications"`) with
severity, the subsystem or the exact agent label that raised them, text, and dismissal. Each card
closes itself after five seconds; every entry stays in the history opened from the status bar.
Every error and warning card also carries `File issue`: it files that notification's text and card
context as a UI issue through `/feedback` at once, then replaces itself with the issue URL.
Notifications never replace mode content or steal focus, and several arrivals are all retained.
Flow blockers and verification results also remain in their mode context. A Discover failure stays
on the Discover surface and is not repeated as a notification card: a run failure on its agent's
card, every other failure in the notice stack above the page.

The status bar's OS notifications control (`os-notifications`) is a separate channel, off by
default. Its first click asks the browser for notification permission; after a grant it reads
`OS notifications on`, after a denial or a blocked site it reads `OS notifications blocked`, and
a dismissed prompt leaves it off. While it is on, the open dashboard raises one desktop
notification per pending agent question in Goal, Discover, Flow, and Issues — a lifecycle lane,
a manual run, goal creation, revision, skills preparation, a Discover agent, a Flow session,
Flow goal creation, a Flow conversation, or an issues draft elaboration — carrying the dashboard's
name, the asking surface's label, and the question itself. Repeated snapshots, polls, and
reconnects never repeat a question, a question already pending at load raises one after the first
state arrives, and answering one raises nothing. The notification is informational: clicking it
navigates nowhere. The on choice is stored in the browser profile; permission is always read from
the browser, and a denied or blocked site leaves the dashboard usable with its own question UI
unchanged. No service worker, push subscription, server endpoint, or external notifier is
involved, so with no page open nothing is raised.

The 26px status bar is two groups. The left group states the WebSocket connection, the
project's own name (the last path segment, with a folder mark and the full path in its tooltip),
and the Providers control: the selected provider with its lowest remaining percentage, or
`No provider`, whose tooltip names the provider's model and which opens the Providers dialog.
The right group states the running lane count, the issues worker state with a state dot, the
watchdog's last action and age, the OS notifications control, and the running and second
version; each metric carries a 10px uppercase label so its meaning never rests on color. On a
source checkout the second value is labeled `source` and names the source version a restart
would load; on an installed host it is labeled `installed` and names the binary and manifest
beside the running one. `running` is always the version the process actually loaded, so the two differ, and
`stale` is true, only while a restart would load different code. The reload control
(`reload-devboard`) appears only when a replacement could not start; its accessible name and
title name both versions, and clicking it retries the same launcher. A successful replacement
needs no click and reloads every connected page once.
A mode states its status in its sidebar and workspace, never a second time in the status bar,
except the issues worker, which is detached from every dashboard and reports through
`issues-indicator`. The theme toggle and the notification indicator live in the activity bar's
action group, not the status bar.

### Verifying the interface

The client is built with `bun run build`, embedded into the binary by
`bun scripts/embed-client.mjs`, and served from memory. Start a private dashboard with
`cargo run -p devboard -- serve --port <free> --state-dir <dir> --repo-dir <dir>` and open it in
a browser; the corpus tests cover the protocol and HTTP behavior the page depends on.

### Developing the client

The dashboard binary serves the embedded client and owns the WebSocket, so no dev server runs
during normal use. For client work with Vite HMR, start the server first, then Vite in another
shell:

```bash
cd .devboard
cargo run -p devboard -- serve   # backend, http://127.0.0.1:8080 by default
bun run dev                      # client with HMR, http://127.0.0.1:5173 by default
```

Vite proxies `/ws`, `/api`, `/feedback`, and `/goal-proposals` to `DEVBOARD_BACKEND` (default
`http://127.0.0.1:8080`). Set it to the server's address when the backend runs elsewhere, for
example `DEVBOARD_BACKEND=http://127.0.0.1:9000 bun run dev`. Without the `/ws` proxy the
interface loads but its status bar stays on `Connecting`: Vite answers the `/ws` upgrade itself
and the backend never sees the socket. Without the `/feedback` and `/goal-proposals` entries the
dev page answers its own 404, so `File issue` reports `The server refused the report (404)` and
goal drafting fails the same way. Both entries come from `lib/endpoints.ts`, which the client and
the server read too, so the three cannot disagree about a path.

The backend requires its dashboard token on the `/ws` upgrade, and the page carries that token in
an `HttpOnly` cookie the backend sets on its own `index.html`. Open `http://127.0.0.1:8080/` once
in the same browser profile before loading the dev page, so the profile holds the cookie the proxy
forwards; otherwise the dev page's socket stays on `Connecting`.

The dev server ignores the generated trees (`.tmp`, `.test-tmp`, `dist`, `coverage`). A busy
checkout writes hundreds of thousands of files under `.tmp`; watching them reloads the page for
every agent write and eventually exhausts the dev server's heap.

## Stack

- Backend: one Rust binary (Tokio and Axum) serving the embedded client and one WebSocket at
  `/ws`. Each run spawns one `omp acp` subprocess over stdio; no Node, Bun, or npm is needed at
  runtime.
- Client: Svelte 5 built with Vite, with shadcn-svelte components and its Tailwind CSS 4 setup,
  Bits UI dialogs, tooltips, and popovers, PaneForge split panes, TanStack Table data grids,
  xterm.js, and Lucide icons. All workers and assets are bundled locally; the
  page makes no network request beyond its WebSocket.
- Density: 13 px body text with 12 px tables and monospace paths, code, diffs, terminals, and IDs.
- Records: read from `adrs/` through adrkit on every `listRecords` command and after every run, so
  files added, removed, or resolved while the server runs appear without a restart. Only records
  adrkit accepts are listed. Each record carries the first paragraph of its `Decision` section as
  a short summary.
- State: the dashboard's server-owned state is written atomically to
  `<stateDir>/state/<24-hex hash of REPO_DIR>.json` (default `stateDir` is
  `<REPO_DIR>/.devboard/.tmp`, the host prefix rather than the replaceable package tree), so it
  survives a backend restart without leaking between repositories that share one harness install.
  See [Durable state](#durable-state).

> The TypeScript runtime and its `verify:*` scripts no longer exist. Where this document
> describes one of those scripts, it describes the behavior that the Rust test suite and the
> contract corpus under `contract/` now prove; run `cargo test --workspace` and
> `cargo test -p devboard-contract`.

## Install

The harness ships as native binaries built by cargo-dist. GitHub Releases carries the platform
archives publicly: Linux x64 and arm64 for both gnu and musl, macOS x64 and arm64, plus the shell
and PowerShell installers. Gitea is the forge where version control happens and the authority for
release metadata: every published tag carries one Gitea release whose `devboard-manifest.json`
asset names the version and every platform artifact with its SHA-256. Nothing publishes or reads
an npm package.

A clean machine installs the harness with the released one-command installer:

```bash
curl -LsSf https://github.com/dsdenes/devboard/releases/latest/download/devboard-installer.sh | sh
devboard --version
devboard install <host>    # write the managed wrappers, skills, AGENTS.md, and .gitignore lines
devboard doctor <host>     # exit 0 when every managed file matches the released artifact
```

`devboard install` writes real files — `<host>/.omp/commands`, `<host>/.omp/extensions`,
`<host>/.omp/skills/devboard-*`, `<host>/AGENTS.md`, and one `/.omp/skills/devboard-<name>` line
per shipped skill — never symlinks, and a rerun adds nothing. A differing unmarked file stops the
run unless `--force` is given; an unmarked host skill is never read, rewritten, or deleted.
`devboard doctor` compares every managed skill byte-for-byte and exits nonzero on one differing
byte; an `AGENTS.md` differing from the template is reported without failing the check.

### Updates

Every installed dashboard reads the Gitea release manifest at startup and every 60 seconds,
downloads the artifact for its platform, verifies the manifest's SHA-256, installs it beside the
running binary, and replaces the process without an operator click. Every connected page receives
the replacement event, waits for the new process, and reloads once. An unreachable, invalid, or
mismatched manifest leaves the running process serving and is journaled once per attempt. The
`DEVBOARD_UPDATE_INTERVAL_MS` and `DEVBOARD_UPDATE_BACKOFF_MAX_MS` variables tune the cadence and
the backoff ceiling; `DEVBOARD_GITEA_URL` names the Gitea instance and `GITEA_TOKEN` its token.

`versionState` reports `running`, `installed`, `latest`, `stale`, and `source`. `installed` is the
version a restart would load — the manifest beside the running binary on an installed host, the
checkout's released source version on a source checkout. The status bar labels that value
`installed` or `source` accordingly; the reload control appears only when a replacement could not
start.

### Publish-only source refresh

A canonical source checkout never installs a released binary and never replaces itself on an
update check. One successful `cargo run -p devboard -- publish` from `.devboard` is the only
authorization for that dashboard to replace itself with the published revision. `publish` writes
the request only after its fast-forward, client build, cargo-dist workflow wait, GitHub-asset
check, and Gitea-manifest check have all passed; a failed or partial publish writes no request.

A request is one JSON file, `<STATE_DIR>/source-refresh/request.json`, written atomically for each
live dashboard whose `REPO_DIR` is the checkout and whose serving harness is that checkout's
`.devboard`. It carries the published commit, the released version, and a deterministic SHA-256 of
the built `.devboard/dist` tree. The dashboard re-reads it on a fixed interval and verifies that
the running binary's embedded client digests identically; it never runs a second build. A matching
request replaces the process through the ordinary replacement handoff: the replacement writes a
readiness marker, the old process stops only once that marker exists, every connected page receives
`serverRestarting` and reloads once, and the applied commit is recorded in
`<STATE_DIR>/source-refresh/applied.json` so re-delivering the same publish never restarts again.

The interval is 60,000 ms and is configurable with `DEVBOARD_SOURCE_REFRESH_INTERVAL_MS`; values
below 1,000 ms are raised to 1,000 ms. An invalid or unreadable request, a digest mismatch, a
failed replacement spawn, or a replacement that never becomes ready leaves the old process serving
on the original port and journals the failure once per attempt. A new commit, a new release tag, a
rebuilt `dist`, an edited source file, a page reload, and an update check never restart a source
dashboard; only a valid publish request or the retry of one does. Installed hosts never receive or
act on a source-refresh request.

`devboard install --host <path>` targets another repository. `DEVBOARD_RELEASE_URL` points the
updater at a local manifest and artifact directory for offline verification and CI fixtures.

`install.sh` copies the agent wrappers under `omp/` into an existing host:

```bash
./install.sh /path/to/host
./install.sh --force /path/to/host
```

The host must already contain a `.devboard/` directory. Every file under `omp/` is copied to the
same relative path under `<host>/.omp/`; matching files are left alone, unrelated host files are
never removed, and a differing file stops the run unless `--force` is given. Skills under
`omp/skills/devboard-*` are the exception described under [Skills](#skills), and the script adds
their `/.omp/skills/devboard-<name>` lines to the host `.gitignore`, adding nothing on a rerun.

## Skills

The package ships four project-scoped skills, canonical under `.devboard/omp/skills/` and
installed on every install and update into `<host>/.omp/skills/<name>/` as real files:

|Skill|Carries|
|---|---|
|`devboard-ui-ux`|The gate-first UI/UX workflow: preflight, user journeys, significance, A2UI wireframes, OpenUI and Storybook, DESIGN.md/DTCG, and browser validation, with its four references and `scripts/preflight.mjs`.|
|`devboard-restful-api-implementation`|Zalando's RESTful API Guidelines as directives plus `references/zalando-rest-rules.md`; the API Standards worker's normative source.|
|`devboard-single-responsibility-principle`|The single-responsibility policy for deciding where behavior belongs, with the five violation categories; the Single Responsibility worker's normative source.|
|`devboard-consistent-naming`|The consistent-naming policy: one concept, one name, one meaning within a bounded context, naming as a property of the conceptual model, and a published UbiLang glossary as the authoritative vocabulary whose conflicts are reported rather than renamed into a synonym.|

Each shipped `SKILL.md` carries `metadata.devboard-builtin: "true"` in its frontmatter. The
Devboard mode's Skills page renders that marker as a visible `Managed` label and never renders a
delete control for the row. Only a prepare-family skill directory — one the `/prepare-skills`
command created with `metadata.devboard-managed: "true"` — is deletable, so a built-in skill can
never be removed from the table.

A plain `omp` session started at the host root discovers them at project scope; `omp skill list`
prints one line per skill. `.devboard/install.sh`, `install`, `update`, and the automatic
replacement path all write the same bytes, marker included.

The name prefix is the ownership marker, and the marked namespace is reserved for the package:

- The package wins a `devboard-*` name. A differing file is restored to package bytes without
  `--force`, an extra file inside a shipped marked directory is removed, a marked directory the
  package no longer ships is deleted, and a marked symlink or file is replaced with a real
  directory without writing its target.
- Every unmarked skill belongs to the host. A hand-authored `house-style`, a prepare-family
  skill, or a Discover-family skill keeps its exact bytes and is never deleted by install, update,
  or prune; a host that wants a skill of its own uses an unmarked name.

`install` adds exactly one `/.omp/skills/devboard-<name>` line per shipped skill to the host
`.gitignore` and adds nothing on a rerun. The four entries are `/.omp/skills/devboard-ui-ux`,
`/.omp/skills/devboard-restful-api-implementation`,
`/.omp/skills/devboard-single-responsibility-principle`, and
`/.omp/skills/devboard-consistent-naming`. `doctor` and the update verification
compare each shipped skill directory with the installed package and exit nonzero when one byte
differs; an unmarked host skill is never inspected and never fails the check.

The global `/setup-devboard` command runs the launcher against the invoking session's working
directory. It lives here as `omp/commands/setup-devboard.md` and is linked into the user-level
command directory (`$HOME/.omp/agent/commands/setup-devboard.md`) so every session sees it.

### Providers and model selection

Provider authentication is a harness capability, not host settings. Exactly two providers exist:

|Provider|Environment variable|Model|
|---|---|---|
|OpenCode Go|`OPENCODE_API_KEY`|`opencode-go/deepseek-v4.1-flash`|
|OpenRouter|`OPENROUTER_API_KEY`|`openrouter/deepseek/deepseek-v4.1-flash-1017`|

The operator registers keys in the **Providers** dialog, reachable from the status bar's
`providers-indicator` control and the `settings.providers` palette command. The dialog supports
add, edit, enable/disable, delete with confirmation, refresh, and save. The provider control names
the model that provider pins, every saved subscription row names its model, and choosing a
provider therefore chooses its model. It shows each key's masked value, status (`ok`, `near
limit`, `exhausted`, `invalid`, `unknown`), every quota window's remaining fraction, and the last
check time. A running peer keeps the key it started with; the next peer resolves the selection
again.

Credentials live in `<stateDir>/providers/credentials.json` (directory `0700`, file `0600`,
atomic replacement). A file whose envelope is unusable is moved aside, and a file with only some
unusable entries is copied to `credentials.json.damaged-<timestamp>-<random>` before the loadable
entries are rewritten, so the original bytes stay recoverable. The file survives a dashboard
restart and is never removed by `bun run cleanup` or the watchdog sweep, however old it is.
Generated per-peer agent directories live beside it under
`<stateDir>/providers/agents/<selection-id>/`. No key is ever returned by a
command or event, written to the journal or activity log, or placed in a process's argv; the
only value the interface receives is a mask ending in at most the last four characters. The
durable state file under `<stateDir>/state/` carries no key material.

Usage is read from `https://opencode.ai/zen/go/v1/usage` (`rolling`, `weekly`, and `monthly`
percent used) and `https://openrouter.ai/api/v1/key` (`limit_remaining` and `limit`).
`DEVBOARD_OPENCODE_GO_USAGE_BASE_URL` and `DEVBOARD_OPENROUTER_USAGE_BASE_URL` override the base
URLs for tests and offline verification. On-demand reads fetch a key's usage at most once per
60 seconds unless the operator forces a refresh; while at least one dashboard is connected, the
server forces one refresh and pushes a fresh `providersState` every 60 seconds, so the dialog's
usage never stays stale. With no client connected the periodic refresh makes no provider call, and
the next client's `getProviders` refreshes first.

A detached worker outlives the credential list it was started with, so every agent it starts
resolves the provider again instead of inheriting the worker's original key. The issue worker
resolves once per issue run, Auto Scout once per scan, and Design once per cycle; a run that
started before a key was added keeps its key, and the next run uses the current selection. Every
refresh also writes `<stateDir>/providers/selection.json` with the selected provider, subscription
id, label, model, and headroom; the file carries no key material. The MCP optimizer finalizer
cannot probe usage, so it reads that snapshot and leads with the dashboard's selected
subscription, then falls back to the operator's list order when no snapshot exists.

Remaining is `1 - percent/100` for each Go window and `limit_remaining / limit` for OpenRouter,
or unlimited when the account has no limit. A subscription is eligible only when every gating
window is strictly above **1% remaining**; that is the rule the dialog states. Eligible
OpenCode Go subscriptions rank by their lowest remaining window, and ties keep the operator's
list order. A key whose usage check failed or timed out stays eligible with unknown headroom and
ranks below every key with known headroom. When no Go subscription is eligible, the peer starts
on the OpenRouter fallback model; when neither provider has an eligible subscription, no process
starts and the UI and event stream report the reason. With no subscription configured at all,
every peer start is refused with an error pointing at the Providers dialog, so a peer never
silently inherits the operator's OMP login.

Every agent process — goal work, lifecycle lanes, Flow, issues, Auto Scout, Design, Ask, Discover,
goal drafts, skills preparation, and the MCP optimizer finalizer — starts with
`PI_CODING_AGENT_DIR` pointing at a generated directory under `<stateDir>/providers/agents/`. Its
`config.yml` pins `default`, `plan`, `smol`, `slow`, and `task` to the selected model. A Go
selection also sets
`retry.modelFallback: true`, `retry.fallbackOn: any`, and a chain from `opencode-go/*` to the
OpenRouter fallback; an OpenRouter selection sets no chain. Every selection also names `ollama`,
`lm-studio`, `llama.cpp`, and `apple` in `disabledProviders`: OMP discovers those implicit local
model servers on every start, a peer can only run the two catalog providers, and the failed probes
would otherwise log warnings the watchdog files as evidence. The peer environment removes the
operator's inherited `OPENCODE_API_KEY` and `OPENROUTER_API_KEY` first, then adds only the
selected keys (a Go peer also receives an OpenRouter key when one exists, for its fallback
chain).

`omp/config.yml` is still installed as `<host>/.omp/config.yml`, but it no longer pins
`modelRoles`: a project-level pin would override the per-peer selection. The interactive agent
started in the repository keeps OMP's configured default. Editing `omp/config.yml` here and
rerunning `install.sh` changes the installed copy.

`bun run verify:providers` proves the selection matrix, the 1% boundary, unknown-usage ranking,
OpenRouter fallback, refusal, masking, environment and argv hygiene, generated roles,
persistence, and cleanup protection against a local provider stub and a deterministic ACP peer.

## Build and run

Run the interface from this directory:

```bash
cd .devboard
bun install
bun run build
bun run check
bunx tsc --noEmit
ADRS_DIR="<host>/adrs" cargo run -p devboard -- serve
```

`bun run check` type-checks every `.svelte` and `.ts` file under `client/` and `server/`;
`bunx tsc --noEmit` type-checks the TypeScript sources.

Open `http://127.0.0.1:8080/`. The server binds to `127.0.0.1` by default.

## Decision records

`adrs/` is an adrkit corpus. Every record opens with YAML frontmatter — `schemaVersion: 0.2.0`,
`id`, `title`, `status`, `date`, `deciders`, and `affects` — and keeps its markdown body below the
closing fence. The server reads the corpus through `@adrkit/core`'s `lintCorpus`, so a `.md` file
whose frontmatter adrkit rejects never appears in the listing, in `pending`, or in `next`.

A record is pending when its frontmatter `status` is `draft` or `proposed`; every other status is
resolved. Records are ordered by file name, `next` is the first pending file in that order, and the
interface renders the status with a capital first letter.

Run the corpus tooling from `.devboard`:

```bash
bun run adr:lint     # adr lint --dir ../adrs
bun run adr:graph    # adr graph --dir ../adrs
bun run adr:queue    # adr queue --dir ../adrs
```

`.github/workflows/adr.yml` installs the harness dependencies and runs `bun run adr:lint` on every
push to `main` and every pull request. On a pull request it also runs the `mbeacom/adrkit` action
with `dir: adrs`, which comments the pull request's governing decisions.

`.devboard/omp/mcp.json` declares two stdio MCP servers. `adrkit` runs
`bunx @adrkit/mcp --cwd . --dir adrs` and answers `tools/list` with `search_decisions`,
`get_decision`, `get_decision_context`, and `list_superseded`. `devboard` runs the harness's own
server; see [Devboard MCP server](#devboard-mcp-server) for its tools, bounds, and confinement.

## Durable state

The dashboard keeps the state that drives the page in one file per host repository and restores
it from a new process after a graceful stop, a launcher restart, or a `SIGKILL`. The file is
`<stateDir>/state/<key>.json`, where `key` is the 24-hex SHA-256 prefix of the resolved
`REPO_DIR` (the same key the journal uses) and `stateDir` is the harness state directory,
`<REPO_DIR>/.devboard/.tmp` by default and overridable with `STATE_DIR`. A `STATE_DIR` inside
the repository survives an implementation reset unchanged, and the reset records its path in the
checkout's
`.git/info/exclude` so it is never staged or reported as untracked; a `STATE_DIR` equal to the
repository root is refused because preserving the state would preserve the whole checkout. Two
repositories that share one harness therefore never read or overwrite each other's lifecycle,
lane, pass, or foreground state, and a repository with no stored state starts at pass 1 with no
lanes and no
`lifecycleState` until a run starts. The file is never committed, never copied between
repositories, and never written outside the repository root.

Every change a client can observe is written before the event that announces it is broadcast.
Writes replace the file atomically (temporary file plus rename), so the last complete state stays
readable at every instant, a kill during a write leaves the previous state, and a client never
sees an event that the replacement process cannot replay. The stored state covers the lifecycle
stage, pass, work, and paused flag; every lane with its id, kind, epic or record, attempt, status,
activity, question, blocked/failure bookkeeping, and remaining retention; epic attempts,
`mainAtFailure`, status, and the parked and retrying sets; the last reported lifecycle state
including `finished`; the manual ADR sequence; goal creation; goal revision with its guidance;
skills preparation with the pre-run rollback snapshot; an interrupted implementation reset; and an
accepted `whenIdle` restart. Browser-only state (open page per mode, drafts, layout, theme,
notifications, connection status) and full ACP transcripts, raw stderr, and secrets stay out of the file.

Restored activity is bounded per foreground run and per lane at the first of 1,000 entries or
1 MiB of UTF-8 text. Within that bound no line is lost across a kill; beyond it the newest
entries are kept and one marker entry stating that earlier activity was trimmed precedes them.
The total serialized state for one repository stays under 32 MiB with 20 concurrent lanes at
full bounds.

A restored lifecycle that was advancing re-spawns every incomplete lane with the same id, kind,
epic or record, attempt, recorded activity (as an exact prefix), and lifecycle position:
implementation lanes receive `/implement-next-epic <epic>`, a generation lane receives
`/epic-next`, and an ADR lane receives the same `agentPrompt(adrDir, file)`. The replacement
never creates a second lane for an epic that still owns one, `laneSequence` continues above the
highest restored id, a retrying epic retries after the configured backoff, and a parked epic
starts no peer until `main` advances past its recorded revision. A queued generation pass runs
exactly once after the restored in-flight pass. A run that was paused stays paused: its lanes
replay status `paused`, no stage transition, tracker read, retry, generation pass, or new peer
happens until `resumeLifecycle`, and the resume then re-spawns each interrupted lane.

Foreground work that was live at death resumes with its original input. A manual ADR sequence
continues from its persisted record, re-spawning that record only while it is still pending
and otherwise advancing to the next pending record; goal creation re-spawns `/goal-outcome`; a
revision re-spawns the same prompt including its original guidance; skills preparation re-spawns
`/prepare-skills` after restoring the same pre-run snapshot, so a resumed preparation that ends in
failure restores the exact bytes captured before the original run. An interrupted discovery agent
re-spawns its own command against the same host, or re-clones the stored remote project first, with
its recorded activity kept as a prefix; the remaining agents of an interrupted Run all stay idle
until the operator starts that command again. Restored activity is kept and new lines append. A pending lane or foreground question is replayed to every connecting client
after the restored activity; answering a restored question that the replacement peer has not
re-issued is refused with `The question is no longer pending.` and the page updates without a
reload. Before re-spawning a unit, the replacement ends any recorded ACP child of the killed
process whose process table entry proves it is that peer; it never signals a process it cannot
prove.

A reset that was active at death is never re-run. The replacement performs no git commit, push,
deletion, or staging, emits `implementationResetStopped` with `completed: false` and one `error`
naming the interruption, and leaves the working tree and refs as the killed process left them.
After a successful reset the stored state holds pass 1 and the idle `goal` stage, so a restart
restores neither the old lanes nor the old pass. An accepted `restartServer` with
`whenIdle: true` survives the process death and is honored exactly once after the restored work
becomes idle; the pending flag is cleared before the launcher is invoked, so the replacement
never restarts itself again for the same request. With no launcher configured, the existing
unavailable-restart error is reported and the flag is cleared.

### Detached runs and parallel workers

Every agentic run the dashboard starts owns a detached process, not a peer inside the server: the
lifecycle lanes, a manual ADR run, goal creation, goal revision, skills preparation, goal-draft
elaboration, Discover, Flow, and Ask. Each owner spawns the ACP peer, appends activity to a
run-keyed file, publishes its question, and consumes answer, stop, pause, and resume commands.
When a newer harness replaces the dashboard, the owners stay alive; the replacement leases and
re-attaches to the same runs, so state and activity replay after reconnect, an answer reaches the
same run, Stop ends it, and no replacement records the run as stopped or interrupted. A non-
replacement server exit ends its runs and records the interruption, because no replacement owns
them.

Each background worker family also accepts a live worker of more than one harness version. The
running version starts its own worker as soon as an older-version worker is live, sends the older
worker a `drain`, and claims every unit that arises afterwards; the older worker starts no new
unit, finishes its in-flight unit, exits when that unit ends, releases its lock, and leaves its
state, run directories, and activity readable. The mode lists every live worker with its version
and merges every running unit into one view, so no surface reports a worker/dashboard or
front-end/backend version divergence. While a newer worker takes over, the issues status bar
reports the family's running work, `issues working (N)` with N summed across every attached
worker, instead of the older member's `pausing`; the drained worker still records its own truthful
state, and the Overview's poll line keeps reporting whichever attached worker polls, so an
automatic drain is never shown as an operator Pause. Every running Overview row, Agents card, and run detail names the harness version of the worker
that owns that run: the label comes from the run record, backed by the owning worker's live lock while it is
live, never from the dashboard's own version, and the older version stays named in history after
its worker retires. Start launches the newest installed version when no worker is live; every
control a family's own page offers applies to every live worker of that family. With no worker
live, installing a newer version starts none. A worker or run started by a version that predates
this mechanism has no drain command; it is never killed mid-unit, and the dashboard's own drain
marker still distinguishes its automatic drain from a manual Pause.

A closed or failed lane whose retention window expired while the server was down is not
replayed; the remaining window is honored after a restart. An unreadable, truncated, or
unsupported-version state file never prevents startup: the server renames it aside inside
`stateDir` (`.damaged-<timestamp>`), starts from the initial state, and reports exactly one
`error` to the first connecting client and on stderr, leaving the preserved bytes in place. A
read-only state directory never stops the server: it keeps serving from memory and reports one
`error` on stderr and in the journal.

### Process supervision

Every long-lived process the harness starts — a dashboard under verification, an ACP peer, a
detached run owner, a goal-draft owner, a background worker entry point, and a fixture peer —
starts through one helper. The child leads its own process group and is recorded before the
caller uses it, as `{pid, argv, cwd, ownerPid, startedAt, startTicks, pgid}` under
`<STATE_DIR>/supervision/<pid>.json`. `argv` and `startTicks` are read from `/proc` right after
the spawn, so a recycled pid is never mistaken for the recorded child. The record leaves when the
child exits, or with the reaping pass that ends it.

One reaper ends a child only under one of two proofs:

- The record exists, its recorded `argv` and start ticks still match the live process, and the
  recorded owner pid is dead (a zombie counts as dead). The child's whole process group is
  signalled: SIGTERM, then SIGKILL after a two-second grace, and then the record is removed.
- No record exists, the process is a fixture peer, a run owner, a goal-draft owner, or a worker
  entry point of any family or harness version, its cwd or `REPO_DIR` sits in a
  `.devboard/.tmp` scratch directory, and its ancestor chain reaches PID 1 again with no live
  harness supervisor left in it: whatever started it is gone. A live test runner, verification
  script, dashboard, or watchdog in the chain still owns the process and it is never a
  candidate; the job runner's own subreaper is not a harness supervisor, so a job's orphaned
  grandchildren stay candidates. It must also have lived five seconds, so a child whose record
  is still being written is never a candidate. A dashboard is never a candidate for this proof:
  a replacement and a verification dashboard are reparented by design, so only their own record
  can end them.

A doubt never signals. A recorded child whose owner is alive is left alone, and its record is
touched so the age-based sweep never deletes the proof. A pid that a live detached-run or
goal-draft lease or handoff names, and a pid a live worker lock of any version holds, is never
signalled. Every candidate the reaper leaves, and every kill, is appended to
`<STATE_DIR>/supervision/reaped.jsonl`.

The reaper is one implementation with two activations: the running watchdog worker reaps on its
own 30-second interval, independent of the cycle cadence, and every dashboard start reaps once
before it serves. On a platform without `/proc` the reaper reports itself unavailable and signals
nothing. Run one pass by hand from `.devboard`:

```bash
bun run cleanup -- --processes --dry-run   # print candidates; change nothing
bun run cleanup -- --processes --once      # kill under the two proofs
```

## Flow Mode

The activity bar carries five client-only modes, `Goal`, `Issues`, `Flow`, `Discover`, and
`Devboard` (`data-testid="mode-goal"`, `data-testid="mode-flow"`,
`data-testid="mode-discover"`, and `data-testid="mode-devboard"`). Switching is a view change
only: it sends no WebSocket frame and starts, stops, pauses, or resumes no work in any mode. The
palette lists `view.mode.devboard` with `Alt+5`, and `devboard.tab.tools` opens the mode's one
page. Goal Mode is the goal, ADR, epic,
lifecycle, and skills interface described above. Flow Mode is one implementation session that the
developer steers while it works: the developer interviews for a goal, starts an implementation
agent in an isolated worktree, reviews the changes as color-coded widgets, discusses a widget with
a read-only agent, and writes steering notes the agent consumes between checkpoints; the decision
board is a read-only view of the sections the server and the implementation append.

### One mode at a time

Both modes may be viewed at any time, but only one may hold the checkout. Starting Flow work —
creating its goal, starting its implementation — is refused with one `error` while any Goal Mode
work is live; starting a Goal Mode run, lifecycle, goal creation or revision, or skills
preparation is refused with one `error` while any Flow work is live. Merging a Flow pull request
is likewise refused while Goal Mode work is live. Flow work means a goal interview, an
implementation turn, a change analysis, a widget conversation, or pull-request work. View
switching and read-only commands stay available in both cases. Goal Mode's implementation reset is
refused while a Flow session exists whose worktree or pull request is not merged.

### Commands and events

Flow Mode uses one WebSocket at `/ws`. The client sends `createFlowGoal`,
`cancelFlowGoal`, `startFlowImplementation`, `stopFlowImplementation`, `retryFlowPr`,
`markFlowPrReady`, `mergeFlowPr`, `sendFlowSteering`, `acceptFlowWidget`,
`refuseFlowWidget`, `openFlowWidget`, `closeFlowWidget`, `sendFlowConversation`,
`sendFlowConclusion`, `dismissFlowBlocker`, and `flowAnswer` (with `target` naming the goal,
implementation, or conversation question). The server broadcasts `flowSnapshot`,
`flowGoalStarted`, `flowGoalStopped`, `flowImplementationStarted`, `flowStopped`, `flowActivity`,
`flowQuestion`, `flowFiles`, `flowWidgets`, `flowSteering`, `flowDecisions`, `flowCheckpoints`,
`flowVerification`, `flowBlockers`, `flowPr`, `flowNotice`, `flowError`,
`flowConversationStarted`, `flowConversationActivity`, `flowConversationQuestion`,
`flowConversationMessage`, and `flowConversationStopped`. A connecting client with a Flow session
receives one `flowSnapshot` holding the whole state followed by every section event, so a reload
never loses a widget, checkpoint, verification result, blocker, steering note, decision board, or
pull-request state; a server with no Flow work sends nothing and the view starts empty.

Flow's four agent commands are `/flow-goal <session-dir>`, `/flow-implement <session-dir>`,
`/flow-change <session-dir>`, and `/flow-widget <session-dir> <widget-id>`. The server spawns each
as its own ACP peer; the goal interview runs in the repository root, the implementation runs with
the isolated worktree as its working directory, and the change analyst and widget conversation are
read-only.

### Goal and implementation

`createFlowGoal` creates a session when none is unmerged and starts `/flow-goal <session-dir>` in
one ACP peer. The prompt interviews the developer one question at a time until the desired end
result and every load-bearing boundary are settled, then writes only `<session-dir>/goal.md`; its
questions arrive as `flowQuestion` with `target: "goal"` and are answered with `flowAnswer`. The
goal text is end-result only: no implementation, technology, path, step, or internal criterion.
An interview has no wall-clock bound: it runs until the agent finishes, the agent fails, or the
operator cancels it. `<session-dir>/goal.md` is removed before each interview, so only a file that
interview writes can be accepted. Any interview is cancellable while its agent works or a question
waits: the Goal interview panel carries one `Cancel goal interview` control that sends
`cancelFlowGoal`; the control is absent when no interview is active. Cancel closes the interview
peer and reports `flowGoalStopped` with `completed: false`, never a `flowError`: the accepted
`goal.md`, the session goal, and the read-only goal return byte for byte, and a session or scratch
directory opened only for that Create is removed. A failed turn reports one `flowError` and
`flowGoalStopped` with `completed: false`, and leaves the previous accepted goal unchanged.
`startFlowImplementation` requires a non-empty goal and starts `/flow-implement`; `stopFlowImplementation` ends that peer and
reports the session `stopped`. A session whose pull request has merged cannot be restarted: create
a new goal.

The implementation commits each coherent unit itself, records the unit's verification through
`flow_verification_record`, and appends one checkpoint through `flow_checkpoint_record`; it never
pushes. The server reads its commits, reconciles the recorded checkpoints, follows the diff, and
runs the change analyst whenever the diff changes. A recorded checkpoint is authoritative for its
commit: when the watcher projected that commit before the record arrived, the next pass replaces
the projected summary, file count, and verdict with the recorded values. The developer watches
activity, answers implementation questions, accepts or refuses widgets, and writes steering notes
and decisions while it works. A refused widget becomes a steering note telling the agent to
abandon that change and implement another solution.

### Session state

A session lives at `<stateDir>/flow/<24-hex journalKey(REPO_DIR)>/<session-id>/`, keyed exactly
like the dashboard state, so repositories sharing one harness never see each other's sessions.
`stateDir` is the harness state directory (`<REPO_DIR>/.devboard/.tmp` by default, overridable with
`STATE_DIR`); `<session-id>` is an 8-hex id chosen when the session is created. The directory is
never committed and never written into the host.

|File|Contents|
|---|---|
|`goal.md`|The goal text `/flow-goal` wrote.|
|`decisions.md`|The decision board: appended timestamped sections.|
|`steering.jsonl`|Append-only developer steering notes.|
|`steering-ack.jsonl`|The ids of steering notes the implementation acknowledged through `flow_steering_ack`.|
|`checkpoints.jsonl`|One JSON line per commit recorded through `flow_checkpoint_record`: id, time, summary, files, sha, verification.|
|`verification.json`|Latest result recorded through `flow_verification_record`: command, status, timestamp, output.|
|`changes.json`|The current changed files with status, insertion and deletion counts, and diffs.|
|`accepted.json`|The widget signatures the developer accepted.|
|`blockers.jsonl`|One JSON line per distinct `DEVBOARD-BLOCKED:` marker text an implementation printed.|
|`session.json`|Machine state: ids, status, worktree, branch, base, widgets, checkpoints, PR.|
|`request.json`|Analyst input: goal, decisions, changed files and diffs, previous widgets.|
|`widgets.json`|The complete widget list the change analyst registered through `flow_widgets_register`.|

`goal.md`, `decisions.md`, `verification.json`, and `checkpoints.jsonl` are re-read on restore,
so text a developer or agent changed while the server was down is the text the replacement uses.
`session.json` is the source of truth for status, worktree, branch, widgets, accepted signatures,
changed files, blockers, and the pull request.

### Change widgets

The change analyst groups every changed file into one or more widgets and registers the complete
list through the Devboard MCP `flow_widgets_register` tool, which writes `widgets.json`. The prompt
describes the complete classification and the tool returns the recorded path and count; no answer
file is requested or parsed. Each widget has a fixed category, a concept, a summary, a rationale,
and the files it covers. The seven categories are:

- `contract` — an interface another part of the system or an external caller depends on.
- `entity` — the identity, lifecycle, or ownership of a domain object.
- `naming` — a rename or terminology change with behavior otherwise unchanged.
- `data` — a migration, schema, persistence, or stored-data shape change.
- `dependency` — an added, removed, or changed external package, service, or tool.
- `irreversible` — a change that is costly or impossible to undo after shipping.
- `structure` — file layout, module boundaries, or code organization, and the fallback for a
  file no clearer category explains.

Every category has its own color token, each with a light and a dark variant:
`--flow-contract` and `--flow-contract-surface` through
`--flow-structure` and `--flow-structure-surface`, defined for the day theme in `:root` and
overridden in the dark theme. A widget carries `data-category="<category>"` and always renders its
category label as text, so the color is never the only signal.

A widget's id is a signature: the first 16 hex characters of a SHA-256 over its category, its
sorted file paths, and those files' normalized diffs. The concept, summary, and rationale are
display metadata and never part of it. Acceptance is keyed by that signature and persisted in
`accepted.json`; a re-analysis that finds the same category, files, and diff keeps the same
signature and therefore stays accepted, while any edit to those files yields a new signature and
an unaccepted widget. A widget whose files leave the diff disappears, and its stale signature is
dropped from `accepted.json`. Every file left unnamed by the analyst is still shown, as a
`structure` widget, so no changed file is ever hidden.

### Steering and the decision board

`sendFlowSteering` appends a timestamped note to `steering.jsonl`; the feed is append-only and
never rewritten. Notes carry `new` until the implementation calls the Devboard MCP
`flow_steering_ack` tool with the consumed ids, after which the server reports them `read`. The
implementation reads only the lines it has not consumed, acknowledges the ids it acted on, and
applies every direction before its next checkpoint; the tool appends each id once and returns the
ids it wrote and skipped. Refusing a widget records the refusal as a steering note, and concluding
a widget conversation appends its conclusion to the decision board and adds one steering note.

The decision board is `<session-dir>/decisions.md`, rendered read-only in the UI. Sections the
server appends — a widget conclusion, for example — are timestamped and source-named, and only
ever append: they never edit, reflow, or remove an earlier section. An appended section is a
record, not a vote, and the implementation must not rewrite the board.

### Worktree, pull request, and merge

Starting an implementation creates the worktree `<repo>/.worktree/flow-<session-id>` on branch
`flow/<session-id>`, based on `origin/main` when it exists and on `main` otherwise, and runs
`/flow-implement <session-dir>` with that worktree as its working directory. The agent works and
commits only there; the server watches the branch and records every checkpoint it finds.

The first checkpoint beyond the base revision makes the server push the branch and open one draft
pull request or merge request against `main`, using the forge named by `origin`; later checkpoints
update its title and body with the goal and the decision board. The developer marks it ready
manually, only after the implementation is stopped and the worktree is clean. The developer then
merges it manually through the forge, and only as a merge commit — never squash, never rebase, and
only after both modes' work has stopped and the worktree is clean. Flow never merges on a
schedule, never force-pushes, and never rewrites the branch.

Every `git`, `gh`, and `glab` child Flow starts carries the `commandTimeoutMs` bound (60 s by
default), and the forge's credential probe is bounded by the same value. A command that outlives
it is killed and reported as a failed push or forge call: the failure is persisted in `prError`,
the pull-request busy flag is cleared, and a later checkpoint or `retryFlowPr` can sync again
without restarting the server.

After a successful merge the server fast-forwards the host's `main` checkout when it is on `main`
and clean, removes the worktree, and deletes the local and remote branch once the branch tip is an
ancestor of `origin/main`. Whatever it could not remove is reported as a leftover and as one
`error`; the session still records the merge, and the leftover names each path or ref so nothing is
silently abandoned. A cleanup that leaves anything keeps the retry armed: the next server start
runs it again until the worktree and both branches are gone. A failed `git fetch origin` is its own
leftover, so the ancestry check is skipped rather than judging the branch against a stale
`origin/main`.

### Restart and resume

A graceful stop, launcher restart, or `SIGKILL` leaves the session on disk. The replacement reads
the session directory and re-emits its complete state. A session that was running is reported
`stopped`, its pending question is cleared, and the server sends one `flowNotice` saying the Flow
implementation stopped and that starting it again resumes it. The durable child ledger includes
Flow's own peers: a live implementation (recorded with its worktree as the working directory), goal
interview, change analyst, and widget conversation are written to the state file, so the
replacement proves and ends each one before anything can start another implementation in the same
worktree. It never re-spawns a Flow agent on its own: no goal interview, implementation turn,
change analysis, or widget conversation resumes automatically. Selecting `Start implementation`
re-spawns `/flow-implement` with the same session
directory, and the agent reads the persisted goal, decisions, steering acks, checkpoints, and
verification before continuing. A session that was idle stays idle. The replacement recomputes the
diff and widgets from the worktree without spawning an analyst, so a restart can never lose review
state or overwrite a newer widget list.

### What Flow never does

Flow never creates an issue or an epic, never queries the tracker, and never labels, closes, or
comments on one. Its forge use is limited to the session's draft pull request or merge request and
that request's branch: create, update, mark ready, view, merge, and delete the remote branch. Flow
never writes `GOAL.md` and never writes `adrs/`; the flow goal belongs only to its session
directory, and the decision board is never an ADR record.

## Discover Mode

The Discover mode is the fourth client-only view, opened from the activity bar. It exists for an
existing host project and is produced by seven independently triggerable discovery agents:
**Data Sheet**, **Contribution Agent**, **Testing Strategy**, **Naming Conventions**, **Coding
Conventions**, **Architecture & Boundaries**, and **Glossary Agent**. Each agent is one ACP turn
with its own prompt file, its own slash command, its own staging directory, and its own slice of
the published artifacts. Switching
to Discover, opening a card, and switching its pages send no WebSocket frame and start, stop,
reset, or clear nothing; all four views stay mounted, so native details, scroll state, and focus
survive. Discover events render only in this view and never touch Goal Mode's activity, question,
or error state.

The Discover sidebar opens a **Discovery** group with exactly seven entries
(`data-testid="discover-agent-tab"` with `data-agent` values `sheet`,
`discover-contribution`, `discover-testing-strategy`, `discover-naming-conventions`,
`discover-coding-conventions`, `discover-architecture-boundaries`, and `discover-glossary`),
labelled `Data Sheet`, `Contribution Agent`, `Testing Strategy`, `Naming Conventions`, `Coding
Conventions`, `Architecture & Boundaries`, and `Glossary Agent`. Selecting one opens its card
(`data-testid="discover-agent"` with the same `data-agent`). Each entry shows its own `running`
badge or `failed` badge. The Discovery group carries no run control: the Overview page owns Run
all, and no other page or sidebar entry starts it.
The same sidebar opens the established pages for `Overview`, `Glossary`, and `Contribution`
without a group heading, in that order. Once Discover artifacts are published it also lists the
six skills `Testing Strategy`, `Naming Conventions`, `Coding Conventions`, `Architecture &
Boundaries`, `Glossary`, and `Contribution` under **Skills** (`data-testid="discover-tab"` with
`data-tab` values `overview`, `glossary`, `contribution`, `testing-strategy`,
`naming-conventions`, `coding-conventions`, `architecture-boundaries`, `glossary-skill`, and
`contribution-skill`); with no published artifact the **Skills** group and its header do not
render. The `contribution` entry carries `data-testid="discover-tab"`, `data-tab="contribution"`,
and the label `Contribution`; the `contribution-skill` entry carries
`data-skill="discover-contribution"` and follows `glossary-skill` directly.
The sidebar has no header, so its first entry is its mode's navigation. The active panel carries
`data-testid="discover-panel"` and the same `data-tab`.
Warnings appears as its own group with a count only while at least one warning exists; the sidebar
keeps no freshness group and no recent-notice list.

### Sidebar run state

Every sidebar entry whose page can start, or is produced by, an agent carries `data-run-state` with
exactly one of `idle`, `running`, `failed`, or `answer`, and renders a visible badge with the text
of the three non-idle values. `idle` renders no run badge. Existing counts, artifact-state meta
(including the Contribution skill's `missing`), and lifecycle badges stay exactly as they were.
Entries outside this contract carry no `data-run-state`.

The Discover Overview entry is marked only by the full seven-agent Run all suite; starting a single
agent never marks it. Every other Discover entry reads only its own agent:

| Sidebar entry | Test hook | State source |
|---|---|---|
| Overview | `discover-tab` `data-tab="overview"` | the seven-agent Run all suite |
| Data Sheet | `discover-agent-tab` `data-agent="sheet"` | the `sheet` agent |
| Contribution Agent | `discover-agent-tab` `data-agent="discover-contribution"` | that agent |
| Contribution page | `discover-tab` `data-tab="contribution"` | that agent |
| Contribution skill | `discover-tab` `data-tab="contribution-skill"` | that agent |
| Testing Strategy Agent | `discover-agent-tab` `data-agent="discover-testing-strategy"` | that agent |
| Testing Strategy skill | `discover-tab` `data-tab="testing-strategy"` | that agent |
| Naming Conventions Agent | `discover-agent-tab` `data-agent="discover-naming-conventions"` | that agent |
| Naming Conventions skill | `discover-tab` `data-tab="naming-conventions"` | that agent |
| Coding Conventions Agent | `discover-agent-tab` `data-agent="discover-coding-conventions"` | that agent |
| Coding Conventions skill | `discover-tab` `data-tab="coding-conventions"` | that agent |
| Architecture & Boundaries Agent | `discover-agent-tab` `data-agent="discover-architecture-boundaries"` | that agent |
| Architecture & Boundaries skill | `discover-tab` `data-tab="architecture-boundaries"` | that agent |
| Glossary Agent | `discover-agent-tab` `data-agent="discover-glossary"` | that agent |
| Glossary page | `discover-tab` `data-tab="glossary"` | that agent |
| Glossary skill | `discover-tab` `data-tab="glossary-skill"` | that agent |

The Overview entry keeps `data-testid="discover-running"` for its suite run badge. During Run all
the Overview is `running` and the current step's entries are `running`; a question on the step makes
both `answer`, and a step failure ends the step's entries and the Overview `failed` while later
agents stay `idle`. A successful suite returns every Discover entry to `idle`.

The same vocabulary covers the other modes:

- **Goal**: the Implementation entry (`data-testid="open-implementation"`) is `running` while a
  manual implementation run or the lifecycle's current step executes and `answer` while that run
  waits for an operator question; its stage, `manual`, or `idle` meta never moves into the badge.
  The Skills entry (`data-testid="goal-skills-open"`) is `running` while skills preparation
  executes. Goal records no failed terminal state, so neither entry shows `failed`, and an
  operator stop is never relabelled a failure.
- **Issues**: the Overview entry (`data-testid="open-issues-overview"`) is `running` while the
  issues lifecycle runs, `failed` while it is failed, and `answer` while a running issue agent has a
  pending question, alongside its lifecycle badge and queue summary. The Draft goals entry
  (`data-testid="open-issues-drafts"`) is `running` while any draft elaboration runs, `failed` when
  the most recent elaboration failed, and `answer` while one waits for an operator question.
- **Flow**: the Overview entry (`data-command="open.flow.overview"`) and the Session `Status` entry
  are `running` while `flow.status` is `running` and `answer` while a Flow question is pending; the
  `stopped` and `merged` badges stay as they are.
- **Devboard**: each background-agent entry (`data-testid="open-devboard-<id>"`, with its
  `data-testid="agent-state-<id>"` lifecycle badge) carries `data-run-state` matching that
  lifecycle: `running` for `running` and `starting`, `failed` for `failed`, and `idle` for `stopped`
  and `stopping`. Its badge text, tone, and issue count do not change, and a future pending question
  makes the entry `answer`.

No menu interaction sends a frame or starts an agent: every value is derived from the snapshot the
dashboard already delivers, so a reload during a live run restores the same entries, and a finished,
stopped, or failed run clears `running` everywhere it was marked.

## Discovery agent cards

One card per agent carries its run state (`data-testid="discover-agent-status"` with
`data-state` `idle`, `running`, `succeeded`, or `failed`), its run tag
(`data-testid="discover-agent-run-tag"`) and Stop control (`data-testid="discover-agent-stop"`)
while it runs, a Start control (`data-testid="discover-agent-start"`), and its own pending
question. A card carries no activity log: the run tag shows the latest line for the agent that is
running. An error the agent reported stays on its card (`data-testid="discover-agent-error"`), so
it raises no notification-region entry and no other Discover page shows it; the agent's sidebar
entry carries the `failed` badge.
`discoverQuestion`, `discoverStarted`, and `discoverStopped` carry `agent`, so no card shows
another agent's question.

| Agent | `data-agent` | Command | Prompt file |
|---|---|---|---|
| Data Sheet | `sheet` | `/discover-sheet` | `.devboard/prompts/discover-sheet.md` |
| Contribution Agent | `discover-contribution` | `/discover-contribution` | `.devboard/prompts/discover-contribution.md` |
| Testing Strategy | `discover-testing-strategy` | `/discover-testing-strategy` | `.devboard/prompts/discover-testing-strategy.md` |
| Naming Conventions | `discover-naming-conventions` | `/discover-naming-conventions` | `.devboard/prompts/discover-naming-conventions.md` |
| Coding Conventions | `discover-coding-conventions` | `/discover-coding-conventions` | `.devboard/prompts/discover-coding-conventions.md` |
| Architecture & Boundaries | `discover-architecture-boundaries` | `/discover-architecture-boundaries` | `.devboard/prompts/discover-architecture-boundaries.md` |
| Glossary Agent | `discover-glossary` | `/discover-glossary` | `.devboard/prompts/discover-glossary.md` |

Seven command wrappers under `.devboard/omp/commands/` carry the same seven names. No two agents
share a prompt file, and each turn stages only its own slice through the Devboard MCP staging
tools: `discover_sheet_stage`, `discover_contribution_stage`, `discover_glossary_stage`,
`discover_significance_stage`, and `discover_skill_stage`. Each tool writes the same staged path
the server publishes and returns the path and identity it wrote; no prompt asks for a staged file
written by hand. A prompt may name `.omp/discover/sheet.json` and `.omp/discover/glossary/` as
optional reference it reads, but no agent needs another agent's artifact to succeed.

Every card renders its own prompt file's complete bytes in the read-only region
`data-testid="discover-agent-prompt-text"`, a scrollable monospace `<pre>` inside
`data-testid="discover-agent-prompt"`. The bytes are the same in a harness source checkout and an
installed host, and the header keeps the `Read-only here` subtitle with no source-only marker. No
card renders `discover-agent-prompt-editor`, `discover-agent-prompt-save`,
`discover-agent-prompt-chat-log`, `discover-agent-prompt-message`, or
`discover-agent-prompt-send`, and no `editable` field rides in the prompt payload. A read failure
shows `discover-agent-prompt-error`; opening a card writes no file and starts no peer.

Every Discover page shares one frame: an optional uppercase eyebrow, one `h1`, a subtitle, an
optional meta row, and a right-aligned action group. The Overview frame holds the repository as
`owner/name` from its GitHub remote (falling back to the directory name when no remote names one;
the full path stays in the tooltip), the discovery date, and the single
filled run action, which runs all seven agents. Staleness is not repeated on the sheet: the activity
bar and the status bar report it. While a run exists, the active agent's card carries a run tag
in its header: a status dot, the agent label and `run in progress`, the age, the latest
activity line, and Stop. A queued question region follows on that card while a question waits.
The sheet follows: Platform, Delivery, Stack, External boundaries, and Shared kernels in the facts
column on the left, and Commands, Testing, Quality gates, and Bounded contexts in the main column
on the right.
The manual-testing strip is the last region of the page, so a source checkout never pushes it above
the project identity. One notice stack renders above the page: an error that names no agent (a
clone refusal, a read failure) and an interrupted-run notice. A run failure names its agent, so it
stays on that agent's card and no other Discover page carries it.

The Glossary row is a plain section link: it has no disclosure control and no nested submenu, so
individual terms are never repeated as sidebar menu items. A term opens from its row on the
Glossary page.

With no published artifacts the Overview page shows the header's first-run explanation and a
`Discover project` button (`data-testid="discover-start"`); with artifacts it shows `Re-discover`.
The button is the only Run all control in the interface and runs all seven agents. It is disabled
when the socket is not open, while any discovery agent or Run all is active, or while Goal or Flow
work is active, and the title names the reason. A start never happens on page load, reconnect, mode
switch, or page switch. A start requires no `GOAL.md`, no prepared skill, a clean tree, or a forge
account; it is accepted on a host with a dirty tree and no goal document.

The Glossary page and every skill page carry the same bar for the one agent that produced them:
the Glossary Agent on the Glossary page, and the agent that owns the skill on its skill page. Their
bar shows only that agent's run state, activity, and pending question, and its control starts or
stops that one agent — never the seven-agent Run all. The warnings page follows the seven-agent
suite and carries no start or stop control.

**One at a time.** A card's Start, the Glossary page's control, and a skill page's control each
send `discoverAgent { agent }`. The server starts exactly one ACP peer whose working directory is
the active target root, whose prompt is exactly `<that agent's command> <staging-dir>`, and whose
staging directory is `<target>/.omp/discover/staging/<run-id>/`. No other agent starts. While any
discovery agent or Run all is active, every other Start control is disabled with a title naming the
reason, and a programmatic `discoverAgent` for another agent is refused with one `discoverError`
and spawns no peer. **Run all** runs the seven in this fixed order: `sheet`, `discover-glossary`,
`discover-testing-strategy`, `discover-naming-conventions`, `discover-coding-conventions`,
`discover-architecture-boundaries`, `discover-contribution`. The agents run one at a time, and
each successful agent publishes its slice before the next starts. The first failure or stop halts the sequence: the
failing agent reports one error, every slice already published stays published, no later agent
starts, and later cards stay idle. Run all is disabled while an individual agent runs, and
individual starts are refused while Run all runs.

The run is server-owned: closing the browser or switching views does not stop it. A reconnect
receives `discoverState`, the active agent's `discoverStarted`, every recorded activity line, and
any pending question before its own command replies, plus each card's prompt state. The agents are
not an interview: an ambiguity is recorded as `unknown` with a reason, never a blocking question.
`answerDiscover` with the pending id and a non-empty value answers it once; a second answer, a stale
id, or an empty value is refused with one `discoverError`. `stopDiscover` closes the active peer,
clears the pending question, removes its staging, marks that agent failed, broadcasts
`discoverStopped { completed: false, agent, mode }`, and leaves every published artifact
byte-identical; it spawns no replacement peer.

Discover uses the same WebSocket at `/ws`. The client sends `discoverAgent` (with `agent`),
`discoverProject` (Run all), `stopDiscover`, `answerDiscover` (with `id` and `value`), and
`getDiscover`. The protocol also accepts `confirmGlossaryTerm` (with `context` and `id`) and
`rejectGlossaryTerm` (with `context`, `id`, and a non-empty `reason`) for tooling, but the
Glossary page does not use them. An unknown agent value, a non-string agent, or a
start while another discovery run is active is refused with one `discoverError`, changes no
artifact, and spawns no peer. `getDiscover` asks for the current snapshot and is answered with
`discoverState`. The server broadcasts `discoverState`, `discoverStarted`, `discoverActivity`,
`discoverQuestion`, `discoverStopped`, `discoverError`, and the prompt frame
`discoverPromptState`; it never sends `activity`, `question`,
`error`, `runStarted`, or `runStopped` for Discover. `discoverState` keeps the active and interrupt
flags, staleness, warnings, the busy reason, the last read error, the manifest, freshness, sheet,
repository links for installed packages, the VS Code handoff for each Overview path reference
(`overviewLinks`, keyed by the displayed text), `contribution` (the published contribution
document or `null`), glossaries, per-concept usage and examples measured from the host's
documentation and source, `glossarySignificance` keyed by bounded context and then concept id with
`{ score, reason }` values, decisions, and every published skill with baseline text, live text,
hashes, and state. It adds `activeAgent`, `runningAll`, and `agents`: the seven cards in sidebar
order with `id`, `label`, `command`, `state`, `startedAt`, `endedAt`, `error`, and `prompt`
(`{ agent, text, error }`).
`discoverQuestion`, `discoverActivity`, and `discoverStopped` carry `agent`; a question also
carries `id`, `message`, and `options` of `{ label, description?, recommended }`.

When the peer exits, the server publishes only the triggered agent's slice. Publication parses the
staged documents itself and publishes only the artifacts that agent owns; there is no separate
post-write validation phase and no re-ask. A failure, stop, invalid, unreadable, or incomplete slice
publishes nothing: its staging is removed, one `discoverError` names the reason, and the agent's
previous artifacts and every other artifact stay byte-identical. Parsing reads only the staged
slice, the human decisions the glossary merge requires, and the live-skill state that agent owns;
it never requires another agent's sheet, glossary, or skill to exist, so a host with no published
artifacts can publish any one slice and the Overview, Glossary, and skill pages render their absent
or empty states without a `discoverError`.
Published artifacts are read from disk when a client connects, so no prior run in the process is
required; an unreadable or invalid published artifact is reported with one `discoverError` and the
files are never overwritten.

| Agent | Owned artifacts |
|---|---|
| `sheet` | `.omp/discover/sheet.json` |
| `discover-contribution` | `.omp/discover/contribution.json`, `.omp/discover/skills/discover-contribution/SKILL.md`, `.omp/skills/discover-contribution/SKILL.md` |
| `discover-testing-strategy` | `.omp/discover/skills/discover-testing-strategy/SKILL.md`, `.omp/skills/discover-testing-strategy/SKILL.md` |
| `discover-naming-conventions` | `.omp/discover/skills/discover-naming-conventions/SKILL.md`, `.omp/skills/discover-naming-conventions/SKILL.md` |
| `discover-coding-conventions` | `.omp/discover/skills/discover-coding-conventions/SKILL.md`, `.omp/skills/discover-coding-conventions/SKILL.md` |
| `discover-architecture-boundaries` | `.omp/discover/skills/discover-architecture-boundaries/SKILL.md`, `.omp/skills/discover-architecture-boundaries/SKILL.md` |
| `discover-glossary` | `.omp/discover/glossary/<context>.glossary.yaml`, `.omp/discover/significance.json`, `.omp/discover/skills/discover-glossary/SKILL.md`, `.omp/skills/discover-glossary/SKILL.md` |

Artifacts live only under the host: `.omp/discover/manifest.json`, `.omp/discover/sheet.json`,
`.omp/discover/contribution.json`, `.omp/discover/decisions.json`,
`.omp/discover/significance.json`,
`.omp/discover/glossary/<bounded-context>.glossary.yaml`,
`.omp/discover/skills/<skill>/SKILL.md` for the generated baselines, and the live
`.omp/skills/<skill>/SKILL.md`. Staging mirrors only the triggered agent's relative layout without
`manifest.json` or `decisions.json`, and the staged sheet omits freshness. The manifest carries a
schema version, the discovery fingerprint, the publication time, the run id, the sheet's structural
digest or `null` before the sheet agent has published, one structural digest per published
glossary, the published skill names, each live skill's baseline and current hash, each skill's
edited or missing state, and artifact paths relative to the host; it contains no secrets and no
absolute path. `.omp/discover/manifest.json` and `.omp/discover/decisions.json` are rewritten as
bookkeeping and always name every artifact that is present. A manifest written by this code carries
`paths.significance: ".omp/discover/significance.json"` once the glossary agent has published; a
manifest without that path predates the significance sidecar and is read as legacy, with no error.
`paths.contribution: ".omp/discover/contribution.json"` appears once the Contribution Agent has
published; a manifest without it predates the contribution sheet, and an unreadable contribution
file leaves every other published artifact readable and reports no error.

`sheet.json` is the canonical data sheet, with top-level keys in the fixed order `schemaVersion`,
`definition`, `stack`, `deployment`, `environments`, `commands`, `branching`, `testing`,
`architecture`, `ci`, `runtime`, `dependencyMap`, and `delivery`. It has a freshness header naming
the project, the short commit, the dirty flag, the discovery time, and the stored fingerprint. The
Overview page is a project sheet, not a card grid. A masthead
(`data-testid="discover-freshness"`) carries the project name, the project definition below it when
the crawl recorded one, and the discovery date. The commit, the dirty flag, and the staleness flag
stay in the sheet and the state payload but render no header badge. Below the masthead the sheet is
one bounded two-column spine:
`Platform`, `Delivery`, `Stack`, `External boundaries`, and `Shared kernels` in the facts column,
and Commands, Testing, Quality gates, and Bounded contexts in the main column on the right. Every
section is one panel widget carrying `data-testid="discover-card"` and `data-field`, with the same
header, body, and chip, fact, or table content. Below 1240px viewport
the columns collapse into one in reading order.
Tables grow with the page; neither a panel nor a card shrinks below its rows, and none scrolls
inside the page. Every non-`unknown` leaf
carries at least one sorted, unique repository-relative evidence path, symbol anchor, or safe git
fact and a confidence of `observed`, `declared`, `inferred`, or `unknown`; `unknown` carries empty
evidence and a short reason. Confidence labels, evidence paths, the `Not observed` ledger, the
repeated dependency map, and the static lead and note prose are not rendered; the stored facts and
the sheet's confidence and evidence stay unchanged. The definition is exactly one sentence of at
most 240 characters; every value and list entry is a single line of at most 160 characters. A
`dependencyMap.routes` entry keeps its leading `/` as part of the HTTP path; that slash is not an
absolute host path. The
sheet covers the short platform stack (languages, runtimes, package managers, frameworks, and
major tools by name, not individual dependencies or version numbers), customer-facing deployment
(artifact class, artifact, target, and pipeline sources), every environment (at least `production`,
whose purpose states how changes reach it), exact main commands (with `unknown` for an unobserved
command), branching strategy and model, test levels and pyramid, architecture contexts and their
directed dependencies plus boundaries, CI provider, triggers, jobs, and quality gates, and the
three mandatory sections: runtime inventory, entry-point and dependency map, and delivery and
versioning. It never guesses, invents an additional environment, copies README prose, or records a
configuration value; a claim it cannot ground is `unknown`.

Main commands render as a two-column `Task`/`Command` table of the observed commands, `$`-prefixed,
with no header row, under an `N of 8 commands found` count. That count is a disclosure
(`data-testid="discover-command-coverage"`): activating it lists every one of the eight command
slots, and a slot the crawl did not find renders a muted `not found` placeholder whose title
carries the unknown reason. A `tryOut` command is listed only when it is a hands-on entry point
that no other recorded command aliases. A command the host manifest declares as a script is shown
as its invocation — `npm test` for `scripts.test`, `npm run <name>` for any other script — instead
of the program the script expands to; the recorded program is the chip's tooltip. Every command,
path, package, and boundary value uses the same inline code chip (`.code-chip`); no surface has a
second inline-code presentation. Testing shows the test total, then a
`Level`/`Tests`/`Command` table (`data-testid="discover-pyramid"`).
`Command` is the narrowest declared invocation for that level. Only a level that carries a test is
listed and counted; a recorded level with no test case is omitted, so a sheet cannot claim a
second level while its table holds none. Every listed level states an exact test count, never
`count unknown`. No pyramid graphic is drawn. Quality gates render as a headerless single-column
table (`data-testid="discover-quality-gates"`): each row names a required CI gate, and the gates
are not repeated among the Delivery facts. Runtime, deployment, CI, and branching use compact
`dt`/`dd` facts whose list values are comma-separated.
Every section of the data sheet is one panel widget with the same header, body, and chip, fact,
or table content. The facts column holds `Platform`, `Delivery` (deployment, CI, and branching
facts), `Stack`, `External boundaries`, and `Shared kernels`; the main column holds `Commands`,
`Testing`, `Quality gates`, and `Bounded contexts`.
`Bounded contexts` shows context rows with the name, responsibility, and entry points, then the
dependency direction as a fact. No dependency graph is drawn.
`External boundaries` (`data-field="external-boundaries"`) and `Shared kernels`
(`data-field="shared-kernels"`) are compact chip widgets: one chip per external system
(`data-testid="discover-external-boundaries"`) and one per kernel.
An external boundary leaf recorded `unknown` states its reason there, a missing leaf says no
external boundary was recorded, and the observed empty list renders `None detected.` as the
widget's only line. The repository path of a bounded context is not rendered.
External boundaries name only external systems — a remote API or service, a message broker, a
database, or an identity provider the host integrates with across its own process and artifact.
Language and runtime built-ins describe internal architecture, so `node:child_process`,
`node:worker_threads`, and other concurrency primitives are never boundaries; a host that integrates
with no external system shows `None detected.` in that widget instead of an invented entry or
`unknown`.
`Stack` is a chip widget in the facts column; a chip whose package is installed
under `node_modules/` becomes a link to the repository its manifest declares, and every other chip
stays plain text. Stack chips and the Platform `languages` and `runtimes` facts name the
technology without a version number, so a recorded `PostgreSQL 15` renders as `PostgreSQL` and a
duplicate name collapses to one chip; the sheet's stored values stay unchanged. Environments is
`unknown` here and is not listed. The delivery section, the deployment pipeline sources, and the
runtime `versions` fact stay hidden. A sheet with no observed test level and a glossary with no
matching term keep an explicit empty state.

Every Overview reference that resolves to an existing file or directory in the host checkout is a
link: its text is the displayed repository-relative path and its `href` is a `vscode://file/` URL
carrying that path's absolute location, so activating it — by click or by Tab and Enter — opens
the file or folder in the developer's local VS Code while the dashboard page stays on Discover →
Overview. The rule covers the bounded-context entry points, the `manifests` fact, and the shared
kernels. A reference that names no existing path stays its plain `.code-chip` text with no anchor
and no `href`, and a value that is absolute, carries a `..` segment, or resolves outside the
checkout — including through a symlink — never becomes a link. The sheet's own string rule already
refuses an absolute value, so one never reaches the page at all. A retained remote project publishes
bytes for no live tree, so its Overview renders no path links. Stack, command, external-boundary,
test-level, and dependency-direction values never link; a stack chip keeps its `https://` package
repository link.

### Contribution sheet and contribution skill

The Contribution page is the third ungrouped Discover section, directly below Glossary. Its
sidebar entry carries `data-testid="discover-tab"`, `data-tab="contribution"`, and the label
`Contribution`; selecting it opens `data-testid="discover-panel"` with `data-tab="contribution"`,
whose body carries `data-testid="discover-contribution"`. With nothing published the body states
that no contribution sheet is published. Once published it renders nine
`data-testid="discover-contribution-section"` elements, in this fixed order and with these
`data-section` values: `workflow`, `testing`, `pull-request-style`, `pull-request-size`,
`conventions`, `review`, `documentation`, `hotspots`, and `evidence`. Each fact renders its value,
or an explicit `Not recorded.` empty state when its confidence is `unknown`; the page renders no
evidence chip, no confidence label, and no separate unknowns ledger, matching the Data Sheet page.
The evidence section itself carries the merged sample size, the merge window, the forge and host,
the count of closed-unmerged pull requests, and one line per unknown fact with its reason. The
freshness header renders the publication time, and staleness is reported by the activity bar and
the status bar exactly as it is for the Data Sheet.

The Contribution Agent card is the second entry in the **Discovery** group, directly after Data
Sheet: `data-testid="discover-agent-tab"` with `data-agent="discover-contribution"` and the label
`Contribution Agent`, its command `/discover-contribution <staging-dir>`
(`data-testid="discover-agent-prompt-command"`), and its prompt file
`.devboard/prompts/discover-contribution.md` (`data-testid="discover-agent-prompt-text"`). The
command wrapper is `.devboard/omp/commands/discover-contribution.md`; no other agent uses either
file. A trigger stages exactly `contribution.json` and
`skills/discover-contribution/SKILL.md` under `<target>/.omp/discover/staging/<run-id>/`. The
server reads only that slice: it validates the document and the skill and publishes exactly
`.omp/discover/contribution.json`, the baseline
`.omp/discover/skills/discover-contribution/SKILL.md`, and the live
`.omp/skills/discover-contribution/SKILL.md`. `.omp/discover/manifest.json` and
`.omp/discover/decisions.json` remain the only bookkeeping files it rewrites; every artifact owned
by another agent stays byte-identical. A failed, stopped, invalid, unreadable, or incomplete slice
publishes nothing, reports one `discoverError`, and removes staging. This agent never requires the
sheet, a glossary, or another skill to exist; on a host with no published artifacts it publishes
its own slice while every other page keeps its existing absent or empty state.

`contribution.json` stages `schemaVersion: 1`, a `source` object, and the `workflow` and `testing`
facts. `source` names the forge and host, the merged sample, the sorted closed-unmerged numbers,
the merge window, or a one-line `unavailable` reason. Each merged record carries its number, title,
body, merge time, additions, deletions, changed-file count and paths, test-file and
documentation-file counts, labels, draft flag, approval count, check names, commit subjects and
bodies, head branch, forge merge method, and referenced issue numbers. Each workflow or testing
fact carries its key, a value when known, at least one repository- or forge-relative evidence
entry, and a confidence of `observed`, `declared`, or `inferred`; an unknown fact carries no value,
empty evidence, a one-line reason, and `unknown`. The server derives `pull-request-style`,
`pull-request-size`, `conventions`, `review`, `documentation`, `hotspots`, `evidence`, and the
three-exemplar sample from `source`, so every statistic is computed from the same merged records
the page reports.

Only pull requests the forge records as merged feed a style, size, convention, review,
documentation, hotspot, or sample field. Closed pull requests that were never merged are counted
in `evidence` and never become an exemplar or a size statistic; `source` records only their
numbers, so no closed-unmerged description can reach the artifact or the skill. The merged sample
is read through the repository's one forge-auth resolution for GitHub, GitLab, and Gitea, read-only;
the run never writes to the forge and never copies a token, credential, or URL with user info into
an artifact. With no credential or no network the forge-derived facts are `unknown` with that
reason, the git-derived `workflow` and `testing` facts still publish, the page shows the unknown
empty state, and the skill still publishes from the git-derived evidence. The existing crawl
exclusions apply: `.devboard/`, `.worktree/`, `.git/` internals, every path under `.omp/`, caches,
build outputs, and ignored paths are never read or cited.

The published contribution skill carries `name: discover-contribution`, a one-sentence
`description`, `metadata.devboard-managed: "true"`, `metadata.devboard-family: "discover"`, and
`metadata.devboard-skill: "contribution"`. Its body opens with one `#` heading, then imperative
bullets, then a `## Exemplars` heading and the quoted complete descriptions of the three most
recently merged pull requests (fewer when the sample is smaller), each introduced by
`> PR #<number> — <title>` and quoted verbatim. The bullets state the target size range derived
from the merged statistics, the required description structure and section order, the tone,
length, and vocabulary targets, the exact commands and test evidence, issue linking, commit and
branch conventions, the review and CI gates, and the documentation or changelog expectation, and
name `.omp/discover/contribution.json`. With no merged evidence the body states that the
pull-request-derived rules and exemplars are unknown and why, and carries only the git-derived
rules. The skill is read-only on its page exactly like the other Discover skills:
`contribution-skill` in the **Skills** group renders the same `discover-skill-text` region and
status, an edited live skill survives a re-crawl, an unedited one is replaced by the new
baseline, and a deleted one shows `Live file missing` with its generated baseline. Two runs against
the same commit and merge set publish structurally identical contribution artifacts apart from the
publication time, the freshness header, and bounded prose.

The Glossary page and `.omp/discover/glossary/` implement the UbiLang glossary format: one YAML
document per bounded context named `<bounded-context>.glossary.yaml`, top-level `boundedContext`,
`titles`, and `concepts`, and concepts carrying `id`, `prefLabels`, `altLabels`, `hiddenLabels`,
`definitions`, `scopeNote`, `example`, `historyNote`, `status`, `origin`, `standardRef`, `kind`,
`grounding`, `broader`, and `related` in that order. Fields are camelCase, enum values use the
standard's snake_case spellings, ids are unique kebab case, every concept has an English preferred
label and at least one `en` definition, and every label language is `en` or `de`. No undeclared
field is written. Every concept has at least one grounding of the form
`code:<repository-relative path that exists>` or `model:<name that appears in the host>`; an
ungrounded candidate is omitted. The crawl stages
`status: unconfirmed` with `origin: owner` or `standard` for a term found in code or documentation,
and `status: proposed` with `origin: llm` for a name it proposes for an existing unnamed concept;
it never writes `confirmed`, `deprecated`, or `invalidated`. On publication the server confirms
every newly crawled term, so the published glossary contains only confirmed terms unless an
earlier operator decision invalidated one. The page groups terms by context and offers search; it
shows no status filter, status badge, or per-term control, and it hides invalidated terms. Each
context card holds a table with `Kind`, `Term`, `Significance`, `Definition`, and an unnamed
examples column; the Kind, Term, Significance, and examples columns have the same fixed widths in
every context card, the term reads in bold, and the examples cell lists the identifiers that name
the concept in the host's code. The table grows with the page, neither the card nor the table
scrolls inside a panel, and long definitions wrap; each term carries `data-testid="discover-term"`,
`data-context`, `data-id`, `data-status`, `data-kind`, `data-significance`, and `data-examples`, and
each context carries `data-testid="discover-context"`. The context heading shows its title, falling
back to the context id only when no title exists. Every Kind value carries a Lucide icon colored by
kind: entity, event, field, role, actor, value, and rule each use a stable token. The search field
centers its placeholder vertically.

The crawl authors each concept's significance; the server never derives a score from occurrence
counts. The crawl includes only project-significant entities in a glossary, omits generic framework,
library, language, and UI vocabulary such as `option`, `hook`, or `command` unless the host defines
that exact term as a project concept grounded in at least two distinct host files, and stages a
score from `0` to `100` with a one-line reason for every included concept, where 50 is the
significance floor and a lower score means an incidental term. `glossary/significance.json` is the
staged sidecar; the server validates it, then publishes it atomically as
`.omp/discover/significance.json` beside the glossary artifacts. Its shape is
`{"schemaVersion": 1, "contexts": {"<boundedContext>": {"<concept-id>": {"score": 0, "reason":
"One line of evidence."}}}}`. The run fails with one `discoverError` and publishes nothing when the
sidecar is absent, is not valid JSON or not an object, carries a top-level key other than
`schemaVersion` and `contexts`, carries a `schemaVersion` other than `1`, names a context or concept
the staged glossaries do not stage, omits a staged context or concept, carries an entry key other
than `score` and `reason`, carries a score that is not an integer from `0` through `100`, or carries
a reason that is empty, multi-line, longer than 160 characters, an absolute path, or a secret. A
rejected sidecar leaves the previously published sheet, glossaries, manifest, decisions, sidecar,
baselines, and live skills byte-identical. A concept preserved from an earlier human decision but
absent from the staged sidecar is published unscored rather than rejected. Scores are excluded from
the glossary digest and the sheet digest, so changing only a score moves no digest.

The Glossary page orders each context's rows by significance descending, with unscored concepts last
and ties broken by the displayed term label, and it renders the score in the `Significance` column;
an unscored concept reads `—`. When at least one published concept is scored, a `Significant only`
control (`data-testid="discover-glossary-significant"`) is present and checked by default, and the
floor slider (`data-testid="discover-glossary-threshold"`) spans `min="0"` to `max="100"` with
`value="50"`. With the control checked, a concept is listed only when it matches the search and
either has no score or scores at or above the slider value; clearing it lists every term matching
the search and disables the slider. The subtitle reports the visible terms, the total terms, and the
active floor, the sidebar glossary count stays the published term count, and the search, filter, and
slider compose. The search field, the `Significant only` switch, and the valued floor sit in one
bounded toolbar row. A glossary published before the sidecar existed keeps its concepts and stays
unfiltered: every term is visible, each Significance cell reads `—`, and the switch and slider are
disabled. An invalidated term never appears. A glossary row is read-only: it carries no activation
command, no focus target, and no single-term page. The server still measures per-concept usage and
examples for the row's examples cell, but `glossaryUsage` never decides which term is listed or in
which order.

Confirmation is automatic, so the Glossary page offers no `Confirm` or `Reject` control.
`confirmGlossaryTerm` still succeeds only for a term that is proposed or unconfirmed, and
`rejectGlossaryTerm` requires a non-empty reason and changes a proposed, unconfirmed, or confirmed
term to `invalidated`; neither is reachable from the page. Both append a dated decision to
`decisions.json` with the context, id, action, reason when rejecting, and date, never adding a
field to the YAML, and the change survives reload, reconnect, and restart. A later crawl preserves
every confirmed or invalidated concept's labels, definitions, notes, status, origin, standard
reference, kind, and related ids; it may refresh grounding and add confirmed concepts, but it never
resurrects an invalidated id, never overwrites a human decision, and removes an undecided concept
only when the new crawl no longer grounds it. A malformed or structurally invalid glossary fails
the run atomically with one `discoverError` naming the file and rule.

A published glossary is crawl evidence: its grounding is proved against the host when the crawl
publishes it, never again on read. A deleted or renamed source file leaves the published set
readable and stale instead of hiding every artifact and failing the next crawl on the previous
glossary; only a staged glossary is checked against the live host.

A successful run publishes exactly six skills under `.omp/skills/`: `discover-testing-strategy`,
`discover-naming-conventions`, `discover-coding-conventions`,
`discover-architecture-boundaries`, `discover-glossary`, and `discover-contribution`. Each is a
directory containing `SKILL.md` whose frontmatter has `name` equal to the directory, a non-empty
`description` of at most 1024 characters, `metadata.devboard-managed: "true"`,
`metadata.devboard-family: "discover"`, and `metadata.devboard-skill` naming its role. The bodies
are project-specific and directive: one imperative bullet per rule, and no bullet names a source,
test, manifest, or CI path — an exact command may still contain one. The contribution skill is the
one exception to the no-prose rule: after its bullets it carries the verbatim quoted exemplar
blocks described above. A bullet never says where a rule was observed: no evidence clause,
file name, directory name, or path outside an exact command, so the skill carries policy and the
sheet carries provenance. Testing strategy states levels, pyramid, commands, fixture roles,
coverage expectations, and how to add a test; naming conventions state canonical terms, casing, and
rejected aliases; coding conventions state patterns, error handling, typing, async, logging,
dependencies, formatting, and prohibited constructs; architecture and boundaries state contexts,
entry points, dependency direction, persistence, integrations, and prohibited cross-boundary
imports; the glossary skill names the canonical glossary directory, the confirmed and rejected
rules, and the proposal process. From the host
root, a new `omp` session lists the six (`omp skill list`) and loads their bodies as skills, so
every implementation agent in that host discovers the set with no extra configuration.

Each skill has a page that shows the whole `SKILL.md` as read-only text
(`data-testid="discover-skill-text"`), with no rendered preview, no split pane, and no editor. The
page header holds only the skill's page title. The panel header is one 44px row: the skill's
relative path, `<skill>/SKILL.md`, with the skill name emphasized and the file name muted, sits on
the leading edge. The page renders no `discover-skill-save`, `discover-skill-restore`, or
`discover-skill-dirty`, and no state badge, status pill, or purpose line, because the sidebar
already flags `edited` or `missing` on the skill entry. The text is the live file when it exists
and the generated baseline while it is missing, including the contribution skill.

A later run compares each live hash with its last baseline: an unedited skill is replaced, an
edited skill is preserved byte for byte with its new baseline published beside it, and a skill
the developer deleted is not recreated but keeps rendering its generated baseline with the
sidebar flagging it `missing`. A generated name colliding with a prepare-family, unmanaged, or
different Discover skill fails the run and publishes nothing.

The goal lifecycle's skill prerequisite accepts a managed skill from either family: at least one
prepare-family or Discover skill is enough for `Start implementation`. `getSkills` and `skillsState`
carry `name`, `description`, `family` (`prepare` or `discover`), and `state` (`generated`, `edited`,
or `missing`), and a managed skill with no `devboard-family` field belongs to `prepare`. The Skills
page is one `data-testid="skills-table"` with a `data-testid="skill"` row per skill: a row shows the
skill name and its description and is a link, not a disclosure — a click or Enter opens that skill's
own page (`data-testid="skill-page"`) with its rendered document and file path, and Back to skills
returns to the table. The sidebar's one Skills entry keeps the skill count and never lists a skill
name, so the table is the only place the prepared skills are enumerated. Both families appear, and
every prepare-family row carries a Delete control that confirms before removing that one skill.
Prepare Skills replaces only its
own family, and its contradiction review covers its family plus hand-authored unmanaged skills, so
a project-specific Discover directive cannot fail a project-agnostic preparation. Discover's
generated baselines must agree with each other and with the glossary; a contradiction there fails
the run, while a contradiction introduced by a developer's skill edit is a non-blocking warning in
the read-only skill view and never changes the file.

The sheet and every glossary are canonicalized before publication: fixed schema key order, arrays
sorted by stable identity, evidence sorted and de-duplicated, and enums in fixed spelling. The
structural digest excludes volatile fields (`discoveredAt`, fingerprint timestamps, run id, and
publication time) and bounded prose (the definition, glossary titles, definitions, scope notes,
history notes, and unknown reasons); skill bodies and descriptions are not part of it. Two runs
against the same unchanged host fingerprint produce the same sheet digest and the same digest for
every unchanged glossary, while bounded prose may differ. The fingerprint covers the host `HEAD`
and the content of tracked and untracked non-ignored files, excluding `.devboard/`, `.worktree/`,
`.omp/discover/`, `.omp/skills/`, VCS internals, and ignored files. Only regular files are read:
a symlink contributes its target string and a FIFO, device, socket, or other special entry a type
marker, so the fingerprint never opens one; a regular file's content streams through the hash in
fixed-size chunks, so a large file cannot exhaust memory. Each digest and the aggregate are cached
by the file listing plus size, timestamps, and inode, so an unchanged host is not re-read and a
reconnect or refresh costs no file reads. The manifest stores the fingerprint, and `stale` is true
only when the current fingerprint is readable and differs. The cache holds digests only; every
accepted start reads the host again.

Every discovery agent's turn is read-only with respect to the host. It reads files and safe read-only git facts
(`git rev-parse`, `git log`, `git branch`, `git status`, `git ls-files`) only; they never run a
project command, test, build, package manager, install, web fetch, or forge query, and the only
network traffic is the model endpoint that serves the peer. Each turn excludes `.devboard/`,
`.worktree/`, `.git/` internals, `.omp/`, dependency caches, build outputs, and ignored files, but
reads `README`, `AGENTS.md`, `GOAL.md`, `adrs/`, manifests, configuration, source, tests, and CI
files that remain. It never modifies `GOAL.md`, `adrs/`, or host source and never writes
`.omp/discover` or `.omp/skills` directly; its only write is the staging directory. Environment
and configuration names may be recorded, but their values, tokens, credentials, private URLs, and
URLs with user info are never copied into an artifact.

A discovery run is active work. While one agent or Run all runs, `startRun`, `startLifecycle`,
`resumeLifecycle`, `reviseGoal`, `createGoal`, `prepareSkills`, every Flow start, and a
second `discoverAgent` or `discoverProject` are refused with one error naming the active run and
spawn no peer; view and tab switching, read-only commands, and `resetImplementation` stay
available. While any Goal or Flow work is active, a discovery start is refused with one
`discoverError` naming the active work.
`restartServer` with `whenIdle: true` treats a discovery run as active and answers
`upgradePending`, and an immediate restart ends the recorded child before it can publish. The
replacement re-spawns that agent against the same target with a fresh staging directory, so nothing
from the killed turn is published but the run itself survives the restart.
`resetImplementation` cancels a run the same way and leaves `.omp/discover` and the Discover skills
untouched because reset preserves `.omp`. Only one run exists at a time; a stopped or interrupted
run leaves the previous artifacts readable, and a later start uses a fresh staging directory.

### Remote targets for manual testing

When the dashboard serves a harness source checkout — `<REPO_DIR>/.devboard/package.json` names
`@dsdenes/devboard` and `<REPO_DIR>/.devboard/node_modules/@dsdenes/devboard` does not exist —
Discover's Overview offers one extra target: a public GitHub repository supplied as a
URL. An installed host renders no such control and both new commands are refused. The predicate
reads no repository name, remote, or other host fact.

The field accepts exactly `https://github.com/<owner>/<repo>`, with an optional trailing `/` and an
optional `.git` suffix. Owner and repository are 1–100 letters, digits, dots, underscores, or
hyphens, and the whole URL is at most 2048 bytes. `http://`, `git@github.com:`, `ssh://`, another
host, a port, user information, a query, a fragment, an empty or whitespace-only value, an empty
owner or repository, `.`, `..`, more than two path segments, and absolute or Windows path shapes are
refused with one `discoverError` naming the reason; nothing is spawned and no directory is created.
Branch or ref selection, private repositories, and credentials are out of scope; any number of
public repositories may be retained.

The retained root is `<STATE_DIR>/discover-remote/` and must resolve inside `<REPO_DIR>`. It holds
one directory per discovered repository, named `<owner>~<repo>` in lowercase, and nothing else once
a run ends. The `~` cannot occur in either URL segment, so distinct `owner/repo` pairs — including
`a/b-c` and `a-b/c` — always get different directories. Each directory keeps the bytes the agents
published — `.omp/discover/` and, once a skill agent published, `.omp/skills/` — beside
`project.json`, which records `url`,
`owner`, `repo`, and the ISO `completedAt` time. A run's checkout is a transient
`.staging-<run-id>` directory beside those projects; it never survives the run. The checkout starts
with the retained `.omp` trees copied into it, so one agent's publication merges over the snapshot
instead of replacing every other slice. While a run is live it owns a claim at
`.runs/<checkout-name>.json` naming its process, and the claim and the `.runs/` directory leave with
the checkout.

A submit broadcasts `discoverState` with `cloning = { url }` before spawning anything, then runs
exactly one child: `git clone --depth 1 --single-branch --no-tags -- <url> .staging-<run-id>` with
the retained root as its working directory, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`,
`NO_COLOR=1`, and a 300-second timeout. The timeout ends the clone even when a helper inherits
and holds the stderr pipe: the child's process group is killed, the staging checkout is removed,
and the next Discover command is accepted. On success the checkout becomes the run root and the
seven agents run against it in the fixed order. Every peer starts with `--no-skills`, so neither a
clone's nor a host's `.omp/skills` are discovered or loaded; each agent contract excludes every
`.omp` path, and OMP's background description compression of a foreign skill would otherwise log a
warning the watchdog files. Publication writes into the checkout's `.omp`; when the sequence
succeeds, the published tree is copied into `<owner>~<repo>/`, `project.json` is rewritten with the
submitted URL and the completion time, and the checkout is removed. The active target moves to the
new project only after its bytes are retained, so a failed clone or a failed agent leaves the
previous target, its bytes, its entry, and its completion time untouched and reports exactly one
`discoverError`. A second `discoverAgent`, `discoverRemote`, `discoverProject`,
`switchDiscoverRemote`, `removeDiscoverRemote`, or `clearDiscoverRemote` while `cloning` is non-null
is refused with one `discoverError`, as it is while a discovery run or other Goal/Flow work is
active. A clone is never resumed.

With a remote target every Discover read and write uses the retained directory: the Overview,
staleness, warnings, skill saves and restores, glossary decisions, and the manifest all come from
`<owner>~<repo>/.omp`. A run is the only path that needs a checkout; starting a discovery agent on
a retained target — `discoverAgent`, `discoverProject`, or `discoverRemote` with its URL — first
clones the project again, runs its slice or the sequence, replaces the snapshot on success, and
removes the checkout. Remote
grounding evidence is stored in the glossary, so the retained snapshot renders without the source
tree. This checkout's `.omp/discover` and `.omp/skills` stay byte-identical, and a remote operation
writes nothing outside `<STATE_DIR>/discover-remote/` apart from the dashboard's own state file.

Every discovery is retained, so the list holds exactly one entry per lowercased `owner/repo`:
discovering the same repository again in any letter case, with a trailing slash, or with a `.git`
suffix updates that entry's bytes, URL, and completion time and moves it to the top. Entries are
listed newest completed discovery first. `discoverState` carries this list as `retained`
(`{url, owner, repo, completedAt}[]`) and `target.checkout`, which is true only while the active
project's transient clone exists.

Durable state stores the active target as URL, owner, and repository only. A replacement restores
it only while `<owner>~<repo>` holds a readable `project.json` and a readable
`.omp/discover/manifest.json`, without a clone or a new run; otherwise it starts on the host target,
drops that one stored target, keeps
every other retained entry, and sends one `discoverError` naming the missing project to the next
client. Startup removes every `.staging-*` directory and any leftover directory containing `.git`
before a recorded run resumes, so the resumed agent starts from a fresh checkout. The one exception
is a transient another live dashboard still claims: two dashboards may serve the same repository
with one `STATE_DIR`, and a starting dashboard never deletes a checkout a running one owns. A
restart during a remote run ends the recorded child and keeps its retained snapshot; the
replacement re-clones the project the stored run named — not whichever target is displayed — runs
the interrupted agent, and replaces the snapshot only on success. A stopped dashboard removes its own checkout
and claim.

The protocol adds `{ "type": "discoverRemote", "url": string }`,
`{ "type": "switchDiscoverRemote", "url": string }`,
`{ "type": "removeDiscoverRemote", "url": string }`, and `{ "type": "clearDiscoverRemote" }`. A
malformed payload, a missing or non-string `url`, and an unknown command receive the existing
unknown-command treatment and change nothing; an unknown or malformed URL in a switch or removal
receives one `discoverError` naming it. `switchDiscoverRemote` changes the active target to a
retained project and renders its retained bytes without cloning, crawling, or network access;
`removeDiscoverRemote` deletes exactly that project's directory and list entry, returning to the
host target when it was the active one; `clearDiscoverRemote` returns to the host target and keeps
every project and its bytes. All three are refused with one `discoverError`, changing nothing,
while a clone or a Discover run is active or while the existing busy rules refuse
`clearDiscoverRemote`.

`discoverState` keeps every existing field and adds `remoteAvailable`, `retained`, `target`
(`{ "kind": "host" }` or `{ "kind": "remote", "url", "owner", "repo", "checkout" }`), and
`cloning` (`{ "url" }` or `null`). `getDiscover` answers with the same snapshot, and a connecting
client still receives it before its own command replies.

While `remoteAvailable` is true the Overview renders a manual-testing target panel as its first
region, above the project header and the sheet or the empty state. The panel header states the
title, carries the source-only marker, and, with retained projects, their count on the trailing
edge. Its body separates the two scopes: a `Retained project` toolbar pairs its label with a
dropdown (`data-testid="discover-remote-select"`) whose options are the retained URLs, newest
first, with the active project selected and no host option;
a bordered list carries one 28px row per retained project with the URL and a remove control
(`data-testid="discover-remote-remove"`, carrying the URL in `data-url`), the active row taking the
accent surface, a 2px accent edge, and an `Active` badge; a surface-raised block labelled
`Discover another repository` holds an input (`data-testid="discover-remote-url"`) labelled for a
GitHub repository URL with the placeholder `https://github.com/owner/repo` and a submit control
(`data-testid="discover-remote-start"`) labelled `Discover from URL`; the panel footer carries a
clear control (`data-testid="discover-remote-clear"`) only while the target is remote. The panel is
secondary in weight yet first in reading order, so an operator sees the active target before
anything it affects. A source checkout with nothing published still learns the gate: the server
replays one `discoverState` on connect when `remoteAvailable` is true, even with no artifacts and
no run. The submit control is disabled while the socket is closed, `cloning` is non-null, a run is
active, or `discoverState.busy` is set, and its `title` names the reason; it is also disabled for
empty or whitespace-only input. Submitting sends exactly one frame with the trimmed URL and starts
nothing else; selecting an option sends exactly one `switchDiscoverRemote`
and starts nothing else; removing sends exactly one `removeDiscoverRemote`; clearing sends exactly
one `clearDiscoverRemote`. Rendering the panel on load, reconnect, mode switch, or page switch sends
no frame. While cloning, the panel shows the cloning URL and the activity area shows no run; errors
reach the Discover error and notification surfaces only.

`server/discover.test.ts` proves with the stub ACP peer and a fixture host under `.devboard/.tmp`
that each of the seven triggers sends exactly its own command and staging path, that a successful
single trigger publishes only its owned files and leaves every other byte identical, that a failed
or stopped trigger publishes nothing, that a host with no prior artifacts can publish any one
slice, that a contribution trigger without a forge corpus still publishes its git-derived facts,
that an invalid contribution slice publishes nothing, that Run all starts the seven in the stated
order and halts at the first failure without starting later agents, that a second start while one
runs is refused, and that neither stop nor a failure rewrites a published artifact.
`server/discover-contribution.test.ts` proves the contribution document validator accepts the
documented shape and refuses a missing owned file, a known fact without value or evidence, an
unknown fact with a value, an unmerged exemplar, a secret, an absolute path, and a malformed skill.
`server/agents/prompt.test.ts` proves the seven prompt snapshots carry bytes and no `editable`
field in both a source fixture and an installed fixture. `verify:discover` builds the client,
seeds source and installed fixture hosts, and drives headless Chrome through the Discovery group,
each card's read-only prompt bytes, all seven independent triggers with a byte-level check of the
fixture `.omp` tree, the contribution page's nine sections and merged-only evidence, the
contribution skill page, the forge-less unknown state, the one-at-a-time refusal, Run all order
and stop at the first seeded failure, the read-only skill page, and the installed host's refusal
of the removed save. `DISCOVER_VERIFY_ONLY=<scenario>` narrows a pass to the named scenarios and
`DISCOVER_VERIFY_KEEP=1` keeps its fixtures under `.devboard/.tmp`.

`server/discover-remote.test.ts` proves retention after a successful sequence with the checkout
removed, restore and rendering without a clone, newest-first ordering and one entry per lowercased
`owner/repo`, switching with zero clone invocations across a restart, one clone and the seven agents on
re-discovery, unchanged bytes after a failed clone or agent, clear keeping every project, removal
of exactly one directory with a restart, busy refusals, the missing-retained-directory fallback, the
gate refusing every remote command without touching the retained root, a byte-identical host
`.omp`, and startup hygiene that keeps a live run's checkout when a second dashboard starts on the
same state directory. `verify:interface` drives the built UI through a retained render after
restart, the dropdown's two entries and selection, removal of one entry, and the gate-off host with
no remote control.

Operator smoke procedure, which needs network and a model endpoint and is therefore not a pass gate:

```bash
cd .devboard
ADRS_DIR=../adrs REPO_DIR=.. cargo run -p devboard -- serve
```

Open Discover, enter `https://github.com/octocat/Hello-World`, and confirm the cloning state, a
completed sequence, the checkout gone from `.devboard/.tmp/discover-remote/`, the retained project at
`.devboard/.tmp/discover-remote/octocat~hello-world/` with its `.omp/discover`, `.omp/skills`, and
`project.json`, its sheet and glossaries, and a skill save landing under the retained
`.omp/skills/`.
Restart the server, reload, and confirm the same project is active with its artifacts and no
missing-clone error. Discover a second repository, switch between the two from the dropdown, and
confirm no clone appears. Remove one entry and confirm only its directory disappears. Hash `.omp`
from the repository root before and after; the two hashes match.

## The Release Train releases

One scheduled background family publishes every version: the Release Train (`release-train`).
A push to `main` releases nothing, and neither does an implementation or design agent.
`.gitea/workflows/devboard-release.yml` runs only on `workflow_dispatch`; the train is the only
component that dispatches it.

- The Release Train's worker runs on a 10-minute default cadence (1 through 1440 minutes).
- On each tick it fetches `origin/main` and its tags and runs one deterministic gate. Unreleased
  means at least one non-merge commit after the newest `v<version>` tag reachable from that tip;
  with no release tag, every non-merge commit is unreleased. Only merge commits release nothing.
  An unreadable remote, tag, or commit read records a failure and starts no agent.
- The gate starts exactly one `omp acp` release agent only for a non-empty range and hands it the
  whole range. At most one run exists per repository: a second worker of the same harness version
  refuses to start, and a cadence tick during an active run starts nothing.
- A worker writes the shared state as a merge with a fresh read taken under the family's run
  lease, never as a whole-object overwrite of the snapshot it read at start. A takeover starts the
  newer version's worker while the drained one is still settling, so the two writers overlap by
  design: runs union by id, newest first and bounded, activity keeps every line both workers
  wrote, and the release, failure, and gate records come from whichever side is newer by their own
  timestamp. A release the draining worker just verified therefore survives the new worker's first
  tick.
- One run batches every non-merge commit since the newest tag into one release. `devboard
  publish` bumps the workspace version, commits and tags the released commit, and dispatches
  `.github/workflows/release.yml` for that tag. cargo-dist builds the six platform archives and the
  shell and PowerShell installers and publishes them to GitHub Releases; the same tag then carries
  a Gitea release holding `devboard-manifest.json` and the checksums. A rerun on the same commit
  leaves the existing GitHub assets and Gitea release untouched.
- A failing workflow conclusion, a missing GitHub asset, a missing Gitea manifest, or a rejected
  derived version records the failure with its detail — a failing workflow names the job and the
  step that failed, so a cancelled run never hides its cause — ships nothing, and leaves the range
  unreleased. The next due tick starts a new run without operator action; a failed run is never
  recorded as released.
- A tick that throws — an unreadable gate, a run-directory or request write that the state
  directory refuses, a lease that cannot be taken — settles like a failed run: the thrown detail
  reaches the shared failure and the worker's last error, the run it opened is closed, and the
  cadence moves a full interval ahead. A failed tick is never re-gated every second, and the page
  reports the error instead of the previous verdict.
- The worker verifies a run in three phases and names the one that failed with the version it
  applies to: `tag binding:` when no release tag names or contains the released commit, `GitHub
  assets:` when a platform archive or installer is missing, and `Gitea manifest:` when the release,
  its manifest, or a checksum is missing. A phase never reports another phase's wording.
- A publish that failed withdrew the tag it created, so the tag phase cannot judge that run: its
  failure detail names the publish error alone and never a `tag binding:` line the withdrawal
  itself produced. A GitHub or Gitea phase failure is still appended, because it names something
  the publish error did not.
- A retry of a recorded failure runs `devboard publish` again. When `main` has moved past the
  failed version's tag, publish releases the range at the current tip; the worker then verifies
  the release publish actually proved and records that version, so a superseded version is never
  re-reported as a failure after a successful release.

The release version is semver derived from Conventional Commits. The first release of this line
is `1.0.0` while the highest published release is still below it. Every later release takes the
newest release tag reachable from `HEAD` and advances it by the highest level in the non-merge
commits after that tag: a `!` before the colon or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer
raises the major, otherwise a `feat` raises the minor, otherwise the patch is raised. A range with
no non-merge commit releases nothing.

Two rules keep the reported release honest. The step refreshes its release tags from `origin`
before it derives anything, and when the derived version is not newer than the forge's newest
published release — the checkout predates that tag — it re-derives the range from the release's
own commit, read from the local tag or from the forge's tag ref, so one run publishes the next
version instead of re-deriving the version already out. And a tag the step would report must name
`HEAD` or contain it: a tag at a commit that is neither is a refusal before the archive is built,
before the GitHub release is dispatched, and before a release record is reused, so a stale
checkout cannot report `release: v<version> is published` for a release that does not carry its
commit.

The release step refuses a range that contains a commit
whose subject is not `<type>[(<scope>)][!]: <description>`, with `<type>` one of
`feat fix docs style refactor perf test build ci chore revert` in lowercase, so a push made with
`--no-verify` cannot release.

The same grammar gates every push. `bun .devboard/hooks/install.ts` writes an executable
`pre-push` into the repository's shared hooks directory, so every worktree is gated without a
per-worktree step; the installer is idempotent, needs `--force` to replace a differing hook, and
refuses anything that is not the source harness at `<checkout>/.devboard`. A rejected push names
each offending `<sha> <subject>` and the rule it broke. Reword the commits with
`git commit --amend` or an interactive rebase and push again; never pass `--no-verify`.

A release is always the newest version: the Release Train derives it from the newest reachable
tag, so an out-of-order release publishes nothing. A runner that executes release jobs concurrently
must point `DEVBOARD_RELEASE_LOCK` at a path its jobs share; the release step serialises the
version bump, the tag push, and the Gitea manifest write through that lock, so the next job sees
the previous version before it chooses its tag. Without the variable the step assumes one release
at a time.

The Release Train's release agent fetches canonical `main` and runs `cargo run -p devboard --
publish` from the integration checkout. That path refuses a worktree, a branch other than `main`,
or a checkout ahead of or diverged from its canonical remote; fetches and fast-forwards `main`
without discarding uncommitted work; rebuilds the client and refreshes the embedded asset copy;
derives the version from the commits after the newest reachable `v<version>` tag; bumps the
workspace version, commits it, and pushes the commit and tag to Gitea; dispatches
`.github/workflows/release.yml` for that tag when it has no usable run and waits for the run;
verifies every platform archive and installer on the GitHub release and the checksums on the Gitea
release; publishes `devboard-manifest.json` to that Gitea release; pushes the `github` mirror
remote's `main` and the release tags, then proves `main` is the published commit or a descendant
that still contains it; and reports every running dashboard's running and installed version. It
never restarts a dashboard and never writes into a host. `--wait-timeout N` bounds the workflow and
propagation wait (default 1800 seconds). A release that fails before its GitHub release exists
withdraws the tag the step created, in the checkout, on the origin, and on the `github` mirror, so
the failed range stays unreleased and the next tick releases the same version; a tag whose release
does exist is kept. That retry finds the version bump already committed on `main` and tags the
head it derived instead of committing an unchanged manifest. Its GitHub reads and its dispatch use
`GH_TOKEN` or `GITHUB_TOKEN` when either is set and otherwise the token `gh auth token` reports,
the same credential the mirror push uses. No other prompt, worker, or operator invokes it; the
implementing agent closes its issue after the push proof, and the Design System pushes its
documentation commit and reports.

Installed dashboards update themselves: each reads the Gitea release manifest at startup and every
60,000 ms (`DEVBOARD_UPDATE_INTERVAL_MS` overrides it), selects the artifact for its platform,
verifies the manifest's SHA-256, installs it beside the running binary, and replaces itself
without an operator click. Every connected page receives `serverRestarting`, waits for the
replacement, and reloads once. The running process never restarts itself on a canonical source
checkout, where the harness is a source tree rather than an installed artifact. After the binary
is in place it syncs `.omp/commands`, `.omp/extensions`, `.omp/skills/devboard-*`, and
`AGENTS.md` from the released artifact before the check reports the install, leaving every
unmarked host file untouched. The client is embedded in the binary, so a replacement changes both
the served client and the server at once; an open page keeps the bytes it started with until it
reloads. A failed download, checksum, authentication, or install leaves the previous binary and
the running server intact. A Gitea instance that is unreachable or serves an unreadable release
description is journaled once per attempt and retried with exponential backoff
(`DEVBOARD_UPDATE_BACKOFF_MAX_MS` caps it); it never records the range as released.

`versionState` reports `running`, `installed`, `latest`, and `stale`. A newer installed version
replaces the running server without a click and reloads every connected page. When a replacement
cannot start, the running version keeps serving, `versionState.replacement` carries both versions
and the failure, the journal records it, and the reload control retries the launcher; the control
is absent on the normal path. A dashboard serving the canonical source checkout reads neither side
from the installed manifest: it reports the newest release tag reachable from its `HEAD` on both
sides, so an unreleased commit on top never changes the number and an unpacked checkout never
claims `0.1.0`. After `cargo run -p devboard -- publish` the source checkout's `running` is the
version that tag just published.

|Variable|Default|Purpose|
|---|---|---|
|`HOST`|`127.0.0.1`|Listen address.|
|`PORT`|`8080`|Listen port.|
|`DEVBOARD_ALLOWED_HOSTS`|unset|Comma-separated extra hostnames the dashboard serves in a Host header. A wildcard bind (`0.0.0.0` or `::`) serves only loopback aliases unless names are listed; a reverse proxy's public name belongs here.|
|`DEVBOARD_DASHBOARD_TOKEN`|generated at startup|Bearer credential for `POST /feedback`, `POST /goal-proposals`, and the `/ws` upgrade; the page receives it as an `HttpOnly`, `SameSite=Strict` cookie and a programmatic client sends `Authorization: Bearer <token>`. The same value stays in the process environment so a replacement keeps authenticating an open page.|
|`ADRS_DIR`|`/repo/adrs`|Directory holding the ADR files.|
|`REPO_DIR`|parent of `ADRS_DIR`|Agent working directory and default goal location.|
|`GOAL_FILE`|`<REPO_DIR>/GOAL.md`|Goal document read on load and replaced on save.|
|`STATIC_DIR`|unset|Client directory to serve; unset serves the client embedded in the binary.|
|`AGENT_COMMAND`|`omp acp`|ACP peer command, split on whitespace. `server/fixtures/stub-agent.ts` is a deterministic substitute for tests and local verification.|
|`STATE_DIR`|`<REPO_DIR>/.devboard/.tmp`|State and journal directory, the host prefix in both the launcher and the MCP server and never the replaceable package tree. An in-repo path survives a reset and is excluded from its commit; the repository root is refused.|
|`DEVBOARD_OPENCODE_GO_USAGE_BASE_URL`|`https://opencode.ai/zen/go`|OpenCode Go usage base; overridden by tests and offline verification.|
|`DEVBOARD_OPENROUTER_USAGE_BASE_URL`|`https://openrouter.ai/api`|OpenRouter usage base; overridden by tests and offline verification.|
|`DEVBOARD_MCP_OPTIMIZER_SYNTHESIS_STUB`|unset|JSON file answering every MCP optimizer synthesis call; verification only, never a peer.|
|`DEVBOARD_UPDATE_INTERVAL_MS`|`60000`|Automatic update check interval.|
|`DEVBOARD_ISSUES_SYNC_INTERVAL_MS`|`30000`|How often a connected dashboard re-reads the origin's open issues for the Open issues list; at least 1000. Independent of the Issues worker.|
|`DEVBOARD_UPDATE_BACKOFF_MAX_MS`|`3600000`|Ceiling for the exponential retry delay after a failed check or install.|
|`DEVBOARD_RELEASE_DIR`|unset|Local release directory for offline verification; unset reads the newest Gitea release over the public HTTP API.|
|`DEVBOARD_RELEASE_LOCK`|unset|Lock path shared by a runner's jobs; the release step serialises its version bump, tag push, and Gitea manifest write through it. Set it when one runner executes releases concurrently.|
|`DEVBOARD_GITEA_URL` / `GITEA_URL`|unset|Gitea HTTP origin; an HTTP(S) `origin` remote supplies it when unset, and a source-checkout dashboard discovers a local SSH Gitea listener. Installed hosts never probe.|
|`GITEA_TOKEN`|unset|Gitea credential for issue, PR, scout, and watchdog writes; public reads need none.|

## Self-hosted runner

The release workflow's only job runs on an `act_runner` registered to one machine and selected by
the `host` label the runner advertises. A machine that lacks the label never picks up the job, and
the job never falls back to a hosted runner. The registration is a one-time operator procedure
against the canonical Gitea instance at `http://localhost:3001`; substitute the repository
(`<owner>/<repo>`), the dedicated account (`<user>`), its home directory (`<home>`), and the
runner name (`<runner-name>`) everywhere they appear.

The account is separate from every human account and holds no group that grants privilege — not
`sudo`, `docker`, or `adm` — because the runner executes repository code and every secret the
workflow is given.

```bash
sudo useradd --create-home --shell /bin/bash --user-group <user>
sudo passwd --lock <user>
sudo install -d -m 700 -o <user> -g <user> <home>
sudo install -d -m 755 -o <user> -g <user> <home>/actions-runner
```

Download the official runner release and unpack it into that directory as `<user>`. The machine
needs `git`, `curl`, and `tar`; everything else the workflow uses is installed by its `uses:`
steps into the runner's own tool cache.

```bash
VERSION=$(gh api repos/actions/runner/releases/latest --jq '.tag_name | ltrimstr("v")')
sudo -u <user> curl -fsSL -o <home>/actions-runner/runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz"
sudo -u <user> tar -xzf <home>/actions-runner/runner.tar.gz -C <home>/actions-runner
sudo -u <user> rm <home>/actions-runner/runner.tar.gz
```

Register with a registration token minted for the repository. The token is valid for one hour;
never write it into a file, a commit, or a log.

```bash
TOKEN=$(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token)
sudo -u <user> -- bash -c "cd <home>/actions-runner && ./config.sh \
  --url https://github.com/<owner>/<repo> --token $TOKEN \
  --name <runner-name> --labels devboard --work _work --unattended"
```

`--labels devboard` adds to the automatic labels rather than replacing them, `--work _work` keeps
checkouts under `<home>/actions-runner/_work`, and `--unattended` keeps the setup non-interactive.
Install the runner as a system service owned by `<user>`, so it starts at boot and restarts after
a failure without an operator session:

```bash
sudo bash -c "cd <home>/actions-runner && ./svc.sh install <user>"
sudo systemctl enable --now actions.runner.<owner>-<repo>.<runner-name>.service
systemctl status actions.runner.<owner>-<repo>.<runner-name>.service
```

Verify the registration from any machine whose `gh` is authenticated against the repository; the
runner must be `online`, idle, and carry exactly the four labels the job asks for:

```bash
gh api repos/<owner>/<repo>/actions/runners \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'
```

Because the service restarts on failure and at boot, `systemctl is-active` and `systemctl
is-enabled` are the ongoing health check; a restart of the unit must return `status` to `online`
within two minutes. The job's own checkouts stay in `<home>/actions-runner/_work/<repo>/<repo>`
and are readable evidence that a run executed here.

To remove the runner, stop the service before deregistering, then delete the account:

```bash
sudo bash -c "cd <home>/actions-runner && ./svc.sh uninstall"
TOKEN=$(gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token --jq .token)
sudo -u <user> -- bash -c "cd <home>/actions-runner && ./config.sh remove --token $TOKEN"
sudo userdel --remove <user>
```

## Background agents

Auto Scout, Watchdog, Design System, Dead Code, MCP optimizer, API Standards, and Single
Responsibility are the seven continuous instances of one background-agent contract; the Release
Train is an eighth descriptor of the same shape. A typed registry in `server/agents/registry.ts`
declares each descriptor's id, label, description, scope, lifecycle vocabulary, cadence field and
defaults, nullable limits schema, start/stop commands, issue projection, detail panel, and prompt
source. The shared page, the shared filed-issues table, and the Devboard sidebar are built from
that registry; adding a further continuous agent means writing its engine, its adapter, and one
registry entry. The shared page, sidebar, and issue table have no agent-id branch: a synthetic
further descriptor projects and validates unchanged.

All seven continuous agents publish the same lifecycle: `stopped`, `starting`, `running`, `stopping`, `failed`.
`starting` appears before a spawned worker exists, `running` once its state is readable, and
`stopping` from the moment Stop is accepted until the worker exits. A stopped agent is never
restarted by a dashboard restart, a page open, or a tab restore. A live worker owned by another
dashboard's `STATE_DIR` reads `running` with `owned: false`; that dashboard cannot Stop it, and
Start is a no-op with a notice.

All background-agent pages share `data-testid="agent-page"` and `data-agent`, the header
`agent-header`, the lifecycle badge `agent-lifecycle`, `agent-sync-at`, exactly one of
`agent-start`/`agent-stop`,
`agent-cadence`, `agent-last-run`, `agent-next-run`, `agent-save-cadence`, `agent-limit-hour`,
`agent-limit-pending`, `agent-save-limits`, `agent-issues-count`, `agent-issues`, and the pinned
`agent-activity-bar`. No shared page renders a separate detail panel. Alerts use one position:
`agent-error`, `agent-sync-error`, and `agent-settings-error`, each with `role="alert"`.
Start/Stop is the only filled primary control.
The header row carries the page identity, the lifecycle badge, the last-read clock, and
Start/Stop. Its settings footer is one band `role="group"` named `Cadence and filing limits` with
two visible `overline` groups 24px apart, each with 10px column and 6px row gaps: `Cadence` holds
the Every field, the last-run and next-run clocks, and the secondary `Save cadence`; `Filing
limits` holds Per hour, Open issues, and the secondary `Save limits`. Each group wraps as a unit,
so a field never separates from its save control. Either save validates all three fields and
sends one settings command. The Devboard sidebar has two groups in order: `Background agents`
(`data-testid="sidebar-background-agents"`, heading `Background agents`, entries
`open-devboard-scout`, `open-devboard-watchdog`, `open-devboard-design`,
`open-devboard-dead-code`, `open-devboard-mcp-optimizer`, `open-devboard-api-standards`,
`open-devboard-single-responsibility`, then
`open-devboard-release-train`, badges `agent-state-<id>`, counts `agent-count-<id>`), and
`Devboard sections` (the `devboard-tab` MCP tools, Skills, and Complexity entries). The Issues sidebar carries no
Background agents group. `agent-count-<id>` is the number of rows in that agent's filed-issues
table, equal to `agent-issues-count`; it never counts findings still waiting in the pending-filing
queue.

### Periodic forge reads

All seven filed-issues tables — Auto Scout, Watchdog, Design System, Dead Code, MCP optimizer,
API Standards, and Single Responsibility — obtain, age, and fail their issue state through one
shared read
(`server/agents/forge-state.ts`) that names, for
each row it lists, the issue's current forge state and its shipping release. The read runs in
the dashboard and never depends on the agent's worker: a stopped agent's table reflects a
closure in the origin forge within one interval, with no Start, no worker restart, no browser
reload, and no reconnect. An open issue reads `pending` and a closed one reads `implemented`.
A row filed through another forge is answered as `unreadable`: the Gitea reader cannot read it,
so the row stays listed with `unknown` in the State cell, claims no version, and a successful
read never removes it. Only a row the reader actually asked its own forge about is dropped when
the answer omits it. A closed issue whose shipping release cannot be resolved still reads
`implemented` with `—` in the Shipped cell and stays listed. A successful read is authoritative
for its rows: a filed issue the answer no longer names leaves the table on the next publish, and
`agent-issues-count` and the sidebar `agent-count-<id>` count exactly the rendered rows.

While at least one dashboard client is connected, each table is read at most once every 60
seconds, and one read per table is in flight at a time. Opening a page whose last read is older
than 60 seconds starts exactly one read immediately; repeated opens inside the interval start
none. With no client connected the dashboard makes no read for these tables. The read only
reads: it starts no worker, writes no worker state, and runs no agent turn. The Issues Open
list keeps its own reader and its own 30-second cadence.

All four periodic reads share one failure policy. A transport failure — a timeout, a refused or
reset connection, a 5xx answer, or an unclassified error — keeps the last known filed rows, the
last successful read time in `agent-sync-at`, and the lifecycle. The page reads `stale` with no
`agent-sync-error`, and the read is retried automatically after 1, 2, 4, and 8 seconds, measured
from the end of the previous attempt, with at most one read in flight per agent. The initial
attempt plus those four retries is five attempts; the fifth consecutive transport failure moves
the page to `error` with that attempt's reason in `agent-sync-error`, and later attempts follow
the normal 60-second cadence rather than another immediate retry. A successful read at any point
in the schedule clears the failures and advances the last-read time.

A permanent failure — unusable credentials, a missing repository, an answer that is not the
expected JSON, or missing forge configuration — and a rate-limited answer (a primary or secondary
limit, abuse detection, or HTTP 429) surface on the first attempt without a retry. A rate limit
still never raises `agent-error`. Forge writes, Start and Stop preflights, agent turns, and user
commands are never retried.

### Transport

Browser-to-backend state and controls use the WebSocket from
`adrs/0003-browser-server-transport-and-api.md`. Commands are `getAgents`, `getAgent`,
`refreshAgent`, `startAgent`, `stopAgent`, `setAgentSettings`, and the timer gate's
`disableAgentTimer`; each carries `id`. The prompt surface adds `getAgentPrompt`, carrying `id`.
The server answers `agentsState` (all agents), `agentState` (one), and `agentPromptState` (one
agent's prompt section), streams each activity-panel agent's activity as `agentActivity` with its
agent id, and refuses an unknown id with an error naming it before spawning anything.
`scoutState`, `scoutActivity`, `startScout`, `stopScout`, `setScoutLimits`, and
`GET /api/watchdog` are gone. The footer indicator still reads
the same Watchdog snapshot through the agent store.

### Prompt

Directly below `agent-header`, before the alert region and `agent-main`, every background-agent
page renders one prompt section `data-testid="agent-prompt"`. It is a `<details>` disclosure:
closed on every page load, its summary (`agent-prompt-summary`) carrying `Prompt`, the prompt
file path as a mono code chip when the descriptor names one, and a chevron, with all of its
content (`agent-prompt-body`) hidden until the operator opens it. A reload, tab restore, or
reconnect renders it closed again; opening it changes no file and no agent state.

Auto Scout, Design System, and Dead Code read the effective prompt file their worker command
opens: `.devboard/prompts/scout-recommendations.md`, `.devboard/prompts/design-system.md`, and
`.devboard/prompts/dead-code-removal.md`. The bytes
are shown complete in the scrollable monospace region `data-testid="agent-prompt-text"`, and are
identical in a harness source checkout and an installed host. The Watchdog section contains
`agent-prompt-absent`, naming that Watchdog runs no editable prompt; its deduplication turn is
assembled from `prompts/watchdog-dedup.md` at run time. MCP optimizer renders its generated
synthesis template instead, described below. Neither renders `agent-prompt-text`.

Every prompt file and every prompt assembled in code begins its body with a `## Manifesto` section
whose first sentence names the agent's goal and the observable result it produces, and no prompt
body opens with a backticked or bare slash-command invocation of itself. The flow prompts describe
the complete flow and act through the Devboard MCP tools; no prompt asks for a JSON, JSON-lines, or
staged answer document for deterministic code to parse or correct.

The MCP optimizer section contains the one synthesis prompt template: exactly one
`agent-prompt-template` element whose `agent-prompt-template-text` is the complete template in a
scrollable monospace region. It is the same text every MCP optimizer synthesis call sends,
rendered from one shared source: the manifesto, every section heading, every `Rules:` bullet, and
the limits are character-for-character the synthesis prompt's fixed lines. The `Family:`,
`Fragments:`, and `Excerpts:` sections hold the literal placeholders `<family>`, `<fragments>`,
and `<excerpts>`, so no family key, session, excerpt, or command occurrence is named and there is
no per-family or per-kind copy. The live sections carry no snapshot: `MCP catalog:` is the
`MCP_TOOLS` name/title pairs in catalog order plus every `MCP_COVERS` entry, `Command allowlist:`
is `JSON.stringify(allowlist, null, 2)` for the allowlist in `<STATE_DIR>/coach/settings.json`
read on every connect, and `Open MCP optimizer issues:` is the dashboard's own open-issue read
filtered to issues whose title starts with `[mcp-optimizer]` or whose body contains `family:`, as
`{number, title, url}` objects sorted by number. A successful read with no such issue shows `[]`;
before any successful read the section states that the open MCP optimizer issues could not be
read. The template is read-only in an installed host and in a harness source checkout: it renders
no editor, Save, Reset, or chat control, opening, closing, restoring, or reloading it writes no
file and starts or stops no agent.

No page renders `agent-prompt-editor`, `agent-prompt-save`, `agent-prompt-chat`,
`agent-prompt-chat-log`, `agent-prompt-message`, `agent-prompt-send`, `agent-prompt-chat-error`,
`agent-prompt-notice`, or a reset control, and no prompt payload carries an `editable` field. A
prompt read failure shows `agent-prompt-error` and leaves the bytes empty. Prompts change only
through an agent or a direct file edit, never through the dashboard.

### Cadence and limits

`agent-cadence` accepts an integer from 1 through 1440 minutes. `agent-limit-hour` and
`agent-limit-pending` are empty (unlimited) or an integer from 1 through 100; an empty field never
renders as `0`. One `agent-save-cadence` or `agent-save-limits` click validates all three fields
and persists them in one atomic settings write; a running worker applies the whole change without
restart. The worker merges a cadence command into the settings it reads at apply time and writes
only `intervalMinutes`, `maxPerHour`, and `maxPending`, so a save made after its last read keeps
the allowlist and the per-cycle cap. Auto Scout defaults to 1 minute and never starts a scan
sooner than the interval after the previous scan start; Watchdog defaults to 10 minutes, starts
its first cycle immediately on Start, and uses the interval as its evidence window; Design
System and Dead Code default to 60 minutes and never start a cycle sooner than that interval
after the previous cycle start. `agent-last-run` and `agent-next-run` show both.

Auto Scout, Design System, and Dead Code default to 10 per rolling hour and 5 open; Watchdog
defaults to both empty. The persisted values survive reload and restart and apply to a running worker. Auto Scout
keeps its rolling-hour and open-issue enforcement. Watchdog files at most the hourly cap of new
issues and at most the pending cap of its own open issues, counts open
state from the last successful projection (`projection.json`) — a `pending` row and an
`unreadable` one, which another forge serves and this dashboard cannot prove closed, both count
as open — keeps excess fingerprints in
`pendingFiling` instead of dropping them, files nothing new while a cap is set and the projection
is not `ok`, and never caps comments. With both caps empty its cycle behaves exactly as before.

### Filed issues

All five pages render one `agent-issues` table with columns Title, Category, Filed, State, Shipped.
Rows are `agent-issue` with `data-url`, `data-state`, and `data-version`, sorted by `filedAt`
descending and then URL ascending. Cells are `agent-issue-title` (an anchor),
`agent-issue-category`, `agent-issue-filed` (a `<time>`), `agent-issue-state`
(`pending`/`implemented`/`unknown`), and `agent-issue-version` (`—` when absent). With no rows,
`agent-issues-empty` renders the same inbox composition on every page, naming the agent.
`agent-issues-count` counts the rows. Auto Scout maps its GitHub title and creation time;
Watchdog keeps `[watchdog] <category>: <line>`; Design System and Dead Code keep their finding
title with its category.

### Detail panels

`agent-detail` is declared by the descriptor. Auto Scout renders `scout-activity` and Design
System renders `design-activity`, both streamed as `agentActivity`. Watchdog renders its retained
cycle history (`watchdog-cycles`, `watchdog-cycle`,
`watchdog-cycle-at/-window/-action/-findings/-reason`, `watchdog-cycles-empty`), capped at the
newest 100 run directories.

### API Standards

API Standards is the `api-standards` descriptor. Its sidebar entry
`open-devboard-api-standards` opens the shared `agent-page` with
`data-agent="api-standards"`: the same core id sequence every background-agent page renders,
exactly one of `agent-start`/`agent-stop`, `agent-cadence`, `agent-last-run`,
`agent-next-run`, `agent-limit-hour`, `agent-limit-pending`, `agent-issues`,
`agent-issues-count`, `agent-sync-at`, and the pinned `agent-activity-bar`. It renders no
`agent-detail` and no `agent-documentation` panel, and `agent-count-api-standards` equals the
rendered row count. Its prompt section shows `.devboard/prompts/api-standards.md`, the file the
`/api-standards-audit` command reads, as read-only bytes exactly like the Auto Scout prompt.

The normative source is the project OMP skill
`<REPO_DIR>/.omp/skills/devboard-restful-api-implementation/` — `SKILL.md` and its
`references/zalando-rest-rules.md`, whose rows read `| <rule id> | <MUST|SHOULD|MAY> |
<directive> |` grouped under the guideline's 15 REST chapter headings. Every cycle reads both
files; the skill is the sole normative text, the cycle makes no network request to the guideline
site, and it never invents a rule id, level, chapter, or directive. A finding cites the numeric
rule id, its level, its chapter, the skill's directive verbatim, and both skill paths. The
chapter heading is the finding's category in the filed-issues table.

A cycle audits the HTTP surface the dashboard server exposes: every route the server answers,
currently `POST /feedback`, `/ready` for `GET` and `HEAD` with a `405` and `Allow: GET,
HEAD` for every other method, `POST /goal-proposals`, the `/ws` upgrade
with its refusal and method handling, and the static-file fallback, together with any route added
later. The audit input carries every TypeScript file under `<REPO_DIR>/.devboard/server` that
defines routing, request parsing, or responses (tests and fixtures excluded), so a route added to
that directory appears in the next cycle with no engine change. The WebSocket messages carried
after an upgrade, the MCP tool contract, and the static asset contents are not audited.

A finding is filed only when the HTTP surface violates a MUST- or SHOULD-level rule. MAY-level
rules, stylistic preferences, and deviations outside the HTTP surface are recorded in activity
and never filed. Each filed issue is created in the origin with the exact `api-standards` label,
no title prefix, a non-empty title of at most 200 characters, and a body carrying the chapter,
the rule id, the level, the skill directive quoted verbatim, both skill paths, every evidence
path with a line range and a source quote copied verbatim, every affected endpoint with method
and path, the proposed change, and binary acceptance criteria. The worker proves each decision
before recording it: a citation that does not match the skill, evidence that is not in the named
file and span, a missing endpoint, or a claim of a filing the tool never recorded is dropped and
recorded, never reported as filed.

A finding is a duplicate when its normalized title — lowercased, whitespace runs collapsed,
trimmed — equals that of any existing `api-standards` issue in any state or any open issue in the
repository. A duplicate is skipped silently and counted in activity; the prompt forbids
restating, paraphrasing, or splitting a known finding to reach a count.

The page has the shared `agent-limit-hour` and `agent-limit-pending` fields, each empty
(unlimited) or an integer 1 through 100, defaulting to 10 per rolling hour and 5 open. The hourly
cap counts every `api-standards` issue created in the last rolling 60 minutes in any state; the
pending cap counts every open `api-standards` issue; one cycle files at most the smaller room and
100. A zero room files nothing and records each skipped finding in activity, and clearing a cap
resumes filing on the next cycle. A failed forge read files nothing and keeps the last known
rows. Caps never block the audit. `agent-cadence` defaults to 60 minutes, accepts 1 through 1440,
persists across reload and restart, applies without a worker restart, and starts no cycle sooner
than that interval after the previous cycle start; `agent-last-run` and `agent-next-run` show
both.

The turn is read-only: it never edits the checkout, creates a branch, commits, stashes, pushes,
builds, tests, installs, or starts another agent, and it writes nothing outside its cycle
directory and its worker state directory. Its only forge write is `issue_create`; it never
comments on, closes, relabels, or edits an issue. The worker writes only under
`<REPO_DIR>/.devboard/.tmp/api-standards/` and `<STATE_DIR>/api-standards/`, both inside the
repository root, and deletes nothing there.

Start preflight refuses before spawning a worker or writing state, naming the missing fact, when
the canonical source checkout carries no Rust source tree (an installed binary is refused), the
REST skill's `SKILL.md` or reference is unreadable, the reference carries no rule table, the
origin is not a supported forge, or its account cannot write. When the repository lacks the exact
`api-standards` label, preflight creates it with its documented color and description before
Start proceeds; a failed creation refuses Start naming the forge error. A failed audit, ACP turn,
forge read, or issue write records the failing step and its reason in activity and in
`agent-error`, files no issue for that finding, and never claims a filing that did not happen; a
failed forge read keeps the last known rows and follows the shared retry and `agent-sync-error`
policy. At most one audit cycle runs at a time: Start while a cycle runs, a cadence change, a page
open, a tab restore, or a reload never starts a second cycle. `bun run verify:api-standards` proves
the entry, the shared page, the MUST/SHOULD filings with provenance, the MAY-only and duplicate
skips, the caps, the added route, the unchanged checkout and git state, the named preflight
refusals, and activity freshness.

### Design System

Design System is the `design` descriptor. Its sidebar entry `open-devboard-design` opens the shared
`agent-page` with `data-agent="design"` and `design-activity`. Its prompt section shows
`.devboard/prompts/design-system.md`, the file the `/design-system-audit` command reads, as
read-only bytes exactly like the Auto Scout prompt. While
started, it audits the interface source `<REPO_DIR>/.devboard/client` (`.svelte`, `.css`, `.ts`,
and the harness `index.html` entry) against the repository-relative documents `DESIGN.md` and
`design/tokens.json` (overridable with `DESIGN_SOURCE_DIR`, `DESIGN_DOCUMENT`, and
`DESIGN_TOKEN_DOCUMENT`). The documents are normative: a client value, state treatment, wording,
spacing, or placement they do not cover is a divergence.

Each cycle writes its input and request under `<REPO_DIR>/.devboard/.tmp/design/cycles/<id>/` and
runs one ACP turn. The prompt describes the complete audit and the agent files each admissible
divergence itself through the Devboard MCP `issue_create` tool with the exact `design` label. A
finding is admissible only in one of `color`, `typography`, `spacing`, `wording`, `state`, or
`placement`, with a documented principle or token and its quoted passage, exact evidence paths
with line ranges and quotes, every affected file, a proposed change, and binary acceptance
criteria. The worker reads the tool's records and re-reads the forge; it never reads, parses, or
corrects an `audit.json` answer, and a tool error is recorded in activity. Filed issues carry the
exact `design` label and no title prefix, and the prompt forbids repeating the normalized title of
an existing open issue or any existing `design` issue in any state.

The prompt receives the shared `agent-limit-hour` and `agent-limit-pending` values as `issueRoom`:
the hourly cap counts every `design` issue created in the last rolling 60 minutes in any state, the
pending cap counts every open `design` issue, and one cycle files no more than the smaller room or
100. The agent enforces the room by reading the issue list through the MCP read tools and files
nothing when it is zero, recording the skip in activity; clearing a cap resumes filing on the next
cycle. A transient forge read failure keeps the last known rows and retries on the shared schedule;
a permanent failure or a rate limit shows its reason at once. Age alone never blocks filing: a read
that succeeded before the cycle keeps filing even when the audit outlasts the sync interval. Caps
never block an audit, a documentation change, or its release.

A documentation edit is admitted only when it establishes or corrects a standard evidenced by two
distinct interface surfaces or by an internal contradiction inside the documents. It may change
only `DESIGN.md` and `design/tokens.json`, must contain `## Design principles` and
`## UX principles` (adding either section when the current document lacks it), and must name
every added token in both the prose table and the token document. The agent never edits a
document to record a single literal and never legalizes a drift it reported. A draft that breaks
this contract is refused and recorded in activity without pushing and without an operator-facing
error; only a failed integration or push is reported as a cycle failure.

An admitted edit is pushed autonomously after the agent records the decision through the
Devboard MCP `design_release_request` tool with the summary and rationale: the worker creates one
worktree under `<REPO_DIR>/.worktree/`, commits only the two documents, fetches and integrates
`main` with every conflict resolved and every check rerun, pushes to `main` without force,
fast-forwards the integration checkout without discarding uncommitted work, removes the worktree
and branch, and reports the pushed commit. It never waits for a release workflow and never runs
the publish entry point: the Release Train releases the pushed commit later. A cycle with no
request makes no commit, push, or checkout update. A failed integration or push leaves the
pushed commit intact, never force-pushes, never reverts, and reports the failing step in
`agent-error` and activity.

The `/design-system-audit` prompt states this contract in its `Documentation push` section: the
agent edits only its cycle draft, the worker pushes an admitted edit from one isolated worktree
under `<REPO_DIR>/.worktree/`, commits only the two documents, integrates `origin/main`, pushes
without force, and reports; the agent never edits the main checkout, never runs git, and never
releases.

Every successful documentation push appends one entry to the bounded `documentation` list in the
design state file, newest first and at most 20: the cycle's one-sentence summary, the push time,
the version the Release Train will derive, the commit URL, the changed document paths, and the
unified diff of the removed and added lines. A rejected document edit, a cycle with no admissible
decision, and a failed push add no entry. A state file written before the list existed loads with
an empty list rather than being quarantined. On the Design System page the `Documentation changes`
panel (`data-testid="agent-documentation"`) renders immediately above the Filed issues panel
(`agent-issues`); `agent-documentation-empty` states that no change has been pushed yet. Each
entry (`agent-documentation-entry`) shows `agent-documentation-summary`,
`agent-documentation-files`, `agent-documentation-at`, and the version link
`agent-documentation-version`; opening its `agent-documentation-summary` reveals the exact
`agent-documentation-diff` and closing it hides the diff again. The Filed issues table and its empty
state remain below the panel on every page.

Start preflight refuses before spawning a worker or writing state, naming the missing fact, when
the canonical source checkout lacks `.devboard/client`, either document is absent, the origin is
not a supported forge, the account cannot write, or `git`, `gh`, or the release credential
is missing. When the repository lacks the exact `design` label, preflight creates it with its
documented color and description before Start proceeds; a failed creation refuses Start naming the
forge error. Start publishes `starting` before the spawn and `running` once the state is readable.
At most one audit and release cycle runs at a time; Start, a cadence change, a page open, a tab
restore, or a reload never starts a second cycle.
State lives at `<STATE_DIR>/design/<journalKey(REPO_DIR)>/`; the lock, cycles, and worktrees stay
inside the checkout, and the worker's audit input never leaves the repository root.

### Entry points for background-agent crawls

Auto Scout, Design System, Dead Code, and Single Responsibility each begin a cycle from one
seeded entry point instead of a fixed survey. The Devboard MCP tool `entry_point` accepts a
`surface` of `scout`, `design`, `dead-code`, or `single-responsibility` and an optional `seed`,
and returns the chosen repository-relative `path`, a 1-based `line` inside that file, the
`surface`, and the `seed` used. It is read-only, absent from the mutating-tool set, creates no
file, and refuses an unknown surface, an empty eligible set, or a path that resolves outside the
repository.

The `scout` pool is every regular text file the repository actually keeps: in a git work tree
the tracked, untracked, and non-ignored files git reports, and in a root git does not own the
walk through that root's own `.gitignore` files. A path the repository's ignore rules exclude —
a secrets file such as `.env`, a generated tree, a scratch directory — never enters a pool, so
a seeded crawl cannot quote it into a filed issue. Either way the fixed trees `.git`,
`node_modules`, `dist`, `.worktree`, `.tmp`, and `.devboard/.tmp` are skipped. The `design` pool
is the configured Design System source set that `DESIGN_SOURCE_DIR` names, read through the same
audit input the Design System cycle uses. The `dead-code` pool is the repository's source-code
files: the picker discovers the extensions the host actually uses from files whose content is
shaped like code or a style rule, so a Ruby or Go host is not limited to this project's
TypeScript layout. The `single-responsibility` pool is that same source set narrowed to
components: a `*.test.*` or `*.spec.*` file is excluded, and so is any file under a
`fixtures/`, `tests/`, or `stubs/` directory, because a test, a fixture, and a stub describe
another unit's contract. No pool follows a symbolic link, and every entry is proven inside the
real repository root. A directory the walk cannot read is refused, never skipped: the picker
throws one `EntryPointError` naming every such directory by its repository-relative path and the
reason, so a pool that omits a subtree is never reported as a repository that lacks those files.
The scout pool's exclusions are also what its scan request publishes as `excludedRoots`, so the
prompt and the pool cannot disagree.

One surface and one seed over an unchanged eligible set always return the same path and line. An
omitted seed produces a fresh pseudo-random seed and returns it; replaying that seed with
`entry_point` reproduces the same pick, which is how a finished cycle's request can be re-read
and its crawl reproduced. Ten consecutive fresh seeds over a corpus of at least two eligible
files reach at least two distinct entry points.

Each scan and cycle calls the tool exactly once with its own surface and a fresh seed, writes the
returned `surface`, `seed`, and `entryPoint` into `<cycle>/request.json`, and names the path,
line, and seed in its activity. The prompt requires the crawl to start at that line and follow
imports, exports, references, callers, and callees outward until no new reachable file appears,
to record the reachable region in activity, and to admit only findings whose evidence lies inside
that region. Auto Scout keeps its 4-or-5 significance gate, Design System keeps its documented
standard, and Dead Code keeps the five dead-code categories below.

### Dead Code

Dead Code is the `dead-code` descriptor. Its sidebar entry `open-devboard-dead-code` opens the
shared `agent-page` with `data-agent="dead-code"` and `dead-code-activity`. Its prompt section
shows `.devboard/prompts/dead-code-removal.md`, the file the `/dead-code-removal` command reads,
as read-only bytes exactly like the Auto Scout and Design System prompts. It defaults to a
60-minute cadence and 10 issues per rolling hour with 5 open, its limits are editable and
persisted, and a running worker applies a save without a restart.

Each cycle writes one request under `<REPO_DIR>/.devboard/.tmp/dead-code/cycles/<id>/`, runs one
ACP turn with that directory as its working directory, and never writes the checkout: no git
command, commit, push, or install runs in a cycle. The prompt names the seeded entry point and
the crawl rules above, then restricts every finding to exactly one detection category:

- `unreferenced-file` — a file never imported or referenced by any other file;
- `unreferenced-symbol` — an exported symbol or declaration with no reference;
- `unreachable-branch` — a branch or guard proved unreachable;
- `unused-dependency` — a declared dependency no source imports;
- `unmatched-selector` — a CSS selector that matches no element.

A filed issue carries the category, at least one repository-relative `path:lines` evidence entry
with a verbatim quote, the exact reference search that proves the absence, every affected file,
the concrete removal, and binary acceptance criteria. A finding without that proof is never
filed. The agent files each accepted finding itself through the Devboard MCP `issue_create` tool
with the exact `dead-code` label, no title prefix, one title line of at most 200 characters, and
the complete Markdown body; the worker reads the tool's records and re-reads the forge rather
than parsing an answer document.

A finding is a duplicate when its normalized title equals the normalized title of any `dead-code`
issue in any state, any open issue, or any draft-goal heading; `issue_create` enforces that guard
for the `dead-code` label and files nothing for a duplicate. One cycle files no more than the
smaller of the hourly and pending room, or 100 when both caps are empty; a cycle with no room
files nothing and records the skip in activity. A tool error is recorded in activity and ends
filing for that cycle without a retry or a second turn.

Start preflight refuses before spawning a worker when the state directory is outside the
checkout, the origin is not a supported forge, the account cannot write, `omp` or `gh` is
missing, the `/dead-code-removal` command is not installed, or the `dead-code` label cannot be
created. Start publishes `starting` before the spawn and `running` once the state is readable; at
most one cycle runs at a time for a checkout. Stop ends the worker and leaves the settings and
filed rows. State lives at `<STATE_DIR>/dead-code/<journalKey(REPO_DIR)>/`, the lock and cycles
stay inside the checkout, and a dashboard restart, page open, or tab restore starts nothing.

The periodic read records every resolution attempt, not just its empty version: a closed issue
whose commit no release contains yet keeps the attempt time and the reason on its row, and the
Shipped cell's tooltip shows that reason. The row is resolved again only when the published
release list changes, which retries every unresolved row at once, or after six hours, so an
unchanged read costs no forge call for a row it already failed to resolve. A release the row was
waiting for fills the version and clears the reason.

### Single Responsibility

Single Responsibility is the `single-responsibility` descriptor. Its sidebar entry
`open-devboard-single-responsibility` opens the shared `agent-page` with
`data-agent="single-responsibility"`: the same core id sequence every background-agent page
renders, exactly one of `agent-start`/`agent-stop`, `agent-cadence`, `agent-last-run`,
`agent-next-run`, `agent-limit-hour`, `agent-limit-pending`, `agent-issues`,
`agent-issues-count`, `agent-sync-at`, and the pinned `agent-activity-bar`. It renders no
`agent-detail` and no `agent-documentation` panel, and `agent-count-single-responsibility`
equals the rendered row count. Its prompt section shows
`.devboard/prompts/single-responsibility.md`, the file the `/single-responsibility` command
reads, as read-only bytes exactly like the Auto Scout prompt.

The normative source is the project OMP skill
`<REPO_DIR>/.omp/skills/devboard-single-responsibility-principle/SKILL.md`. It is the only
normative text of a cycle: the agent reads it once and quotes it verbatim. Its
`## Architectural Violations` section publishes exactly five categories:

- `mixed-responsibilities` — unrelated concerns share one component;
- `divergent-change` — one component changes for multiple independent reasons;
- `accidental-aggregation` — unrelated functionality is grouped for convenience;
- `responsibility-leakage` — a component implements another component's responsibility;
- `artificial-fragmentation` — a cohesive responsibility is split into trivial components.

A candidate outside those five is recorded in activity and never filed. Every issue carries
exactly one component and exactly one category: two violations proved in one component are two
issues, and one violation proved in two components is two issues. Never two of either in one
issue.

Each cycle writes `<REPO_DIR>/.devboard/.tmp/single-responsibility/cycles/<id>/request.json`
naming the `surface`, `seed`, `entryPoint`, the five `categories`, the `skillPath`, the
normalized `knownTitles`, `issueRoom`, `maxPerHour`, `maxPending`, and `createdAt`, runs one ACP
turn with that directory as its working directory, and writes nothing in the checkout. The crawl
starts at the seeded entry point, follows imports, exports, references, callers, and callees
outward, records the reachable region in activity, and admits only evidence inside that region.
A filed issue carries the category, the affected component, the skill path, the category's
directive bullet quoted verbatim, the reason its responsibilities are mixed, at least one
repository-relative `path:lines` evidence entry with a quote copied from exactly those lines, the
concrete refactor, and binary acceptance criteria. The title is one plain line of at most 200
characters with no prefix, and the labels are exactly `["single-responsibility"]`.

A candidate is a duplicate when its normalized title — lowercased, whitespace runs collapsed,
trimmed — equals that of any `single-responsibility` issue in any state, any open issue, or any
draft-goal heading. The prompt reads the tracker and skips duplicates, and `issue_create`
enforces the same guard for the `single-responsibility` label and files nothing for a duplicate.
The page's limits are each empty (unlimited) or an integer 1 through 100, defaulting to 10 per
rolling hour and 5 open. The hourly cap counts every `single-responsibility` issue created in the
last rolling 60 minutes in any state; the pending cap counts every open one; one cycle files at
most the smaller room and 100. A zero room files nothing and records every skip in activity, and
a failed forge read files nothing while keeping the last known rows. `agent-cadence` defaults to
60 minutes, accepts 1 through 1440, persists across reload and restart, applies to a running
worker without a restart, and starts no cycle sooner than that interval after the previous cycle
start.

The worker files nothing itself. It reads the MCP tool log's `issue_create` records, re-reads
each created issue from the origin, and publishes a row only for an issue it read back carrying
the `single-responsibility` label and a body whose category, skill path, directive, component,
evidence quote, refactor, and acceptance criteria all verify. A filing that fails that proof is
recorded in activity as a verification failure and is not published as a row; a tool error files
nothing and is recorded, never claimed as a filing. The issue lands in the origin: on GitHub
through the forge-auth wrapper and `gh`, on Gitea through the HTTP API with the identity
`forge-auth check` selects. The periodic forge sync marks a known row `pending` while its issue
is open and `implemented` once it is closed, and records a failed sync in `agent-sync-error`
without dropping rows.

Start preflight refuses before spawning a worker or writing state, naming the missing fact, when
the skill is missing, unreadable, or resolves outside the repository, the state directory is
outside the checkout, the origin is not a supported forge, the account cannot write, `omp` or
`gh` is missing, the `/single-responsibility` command is not installed, or the
`single-responsibility` label cannot be created with its documented color and description. At
most one cycle runs at a time per checkout: Start during a cycle, a cadence change, a page open,
a tab restore, or a reload starts no second cycle, and a replacement dashboard drains an older
live worker of the family. Stop ends the worker and leaves the settings and filed rows. State
lives at `<STATE_DIR>/single-responsibility/<journalKey(REPO_DIR)>/`, the lock and cycles stay
inside `<REPO_DIR>/.devboard/.tmp/single-responsibility/`, and a cycle leaves
`git status --porcelain` and `git rev-parse HEAD` unchanged. `bun run verify:single-responsibility`
proves the entry, the shared page, the seeded entry point, the excluded test and fixture files,
one issue per component and violation with provenance, the five-category restriction, dedupe, the
caps, the label, the preflight refusals, the read-only checkout, single flight, and activity
freshness against a stub ACP peer and a stub `gh`.

## Harness watchdog

Watchdog is a detached worker started and stopped from the dashboard, not a systemd timer. It is
one machine-level instance per host root; every dashboard on that root reads the same worker state
and ledger regardless of its `STATE_DIR`:

- `<root>/.devboard/.tmp/watchdog/worker.json` — lifecycle, pid, last/next run, error, notice.
- `<root>/.devboard/.tmp/watchdog/settings.json` — cadence and nullable caps.
- `<root>/.devboard/.tmp/watchdog/control/` — stop, cadence, and limits commands.
- `<root>/.devboard/.tmp/watchdog/state.json` — the unchanged version 2 ledger.
- `<root>/.devboard/.tmp/watchdog/lock` — the unchanged machine lock.
- `<root>/.devboard/.tmp/watchdog/runs/` — unchanged run directories.
- `<root>/.devboard/.tmp/watchdog/projection.json` — the last successful forge projection.

The worker survives a dashboard restart; a replacement dashboard reattaches and can control it
when it owns the recorded `STATE_DIR`. The machine lock still serializes cycles. Stop persists
`enabled: false`, releases the lock, and leaves no live child; during a cycle it stays `stopping`
until that cycle finishes and starts no further cycle.

Stop waits a ten-minute cycle grace: a signal or a control command sets the same stopping flag,
the worker finishes the running cycle, and then publishes `stopped`. The dashboard re-reads
`worker.json` and signals only when that state still is not `stopped` after the grace, sending
`SIGTERM` first and `SIGKILL` two seconds later. The ledger is persisted after every successful
issue creation or comment, so a hard kill cannot leave an accepted filing unrecorded.

The legacy `devboard-watchdog.timer` is no longer the scheduler. While it is active or enabled,
the Watchdog page shows `agent-blocked` naming it, disables `agent-start`, and offers
`agent-disable-timer`, which runs `systemctl --user disable --now devboard-watchdog.timer` only
after the click and then re-reads the gate. No other `systemctl` mutation runs from the dashboard.
`watchdog/install.ts`, `watchdog/units/`, and the `watchdog:install` script are removed;
`watchdog:uninstall` and `watchdog/systemd.ts` remain for removing an old unit.

Watchdog's Start preflight requires the canonical root with `.devboard`, the forge write access
its delivery needs, and no active or enabled legacy timer; a refusal names the missing fact,
spawns nothing, writes no state, and renders `agent-error`.

The cycle itself is unchanged: it detects and reports, never fixes, reading the previous interval
of journal and omp evidence, filing one issue per fingerprint, and commenting on recurrences after
24 hours. A failing `gh` call leaves the fingerprint pending for the next cycle; a fingerprint
already `filed:<url>` is never filed again. No cycle closes an issue. A fingerprint covers the
category and the normalized evidence line only: the per-occurrence `raw-http-request` capture path
omp appends to an error it logs is removed, so repeated occurrences of one failure file one issue.
omp's own thinking-loop notice — `Thinking loop detected; aborting stream for retry.` — is a
recovery it performs itself, so it is never a finding; a turn that cannot recover still files its
provider-error record. A `Python runner stderr` warning whose traceback ends in `KeyboardInterrupt`
is the runner stopping the cell it ran, which is how it exits, so it is never a finding either; a
runner traceback that ends in any other exception still files its `omp-warn` record.

The ledger outlives a forge change: an entry may name an issue filed through another forge, or
through the same project under a different instance. The delivery reports the URLs its configured
forge serves, and the cycle never comments on one it does not. Such an entry stays filed in the
ledger, is listed under `unowned` in `report.json` and under `Issues on another forge` in
`report.md`, and makes the cycle `skipped` instead of `failed`; a failed write never masks a
ledger entry that this forge cannot address.

A cycle reads only real dashboards. A verification fixture is invisible: a dashboard whose
repository root sits in `.devboard/.tmp`, or that reads a local release directory
(`DEVBOARD_RELEASE_DIR`), is skipped, because its deliberate release, install, and server failures
prove a script's assertion. The live watchdog verification opts back in with
`DEVBOARD_WATCHDOG_FIXTURE=1`.

### Deduplication gate

No new issue is filed until a deduplication agent has decided the whole candidate set. In every
cycle with at least one candidate — a finding with no issue in the ledger and no open issue
currently covering it — the watchdog makes one request to the configured agent before any forge
create call. The request carries the repository identity and, for every candidate, its category,
fingerprint, normalized line, first and last seen times, count, contributing instances, and the
cycle window. It never carries an open-issue list, snapshot, or summary.

The agent reads the repository's currently open issues itself through the Devboard MCP read tools
(`issues_list` and `issue_get`). It files each unique candidate itself through the MCP
`issue_create` tool and records each duplicate disposition, against an open issue URL or another
candidate's fingerprint, through the MCP `watchdog_duplicate_record` tool. A duplicate creates and
comments on nothing. The tools write `<run-dir>/dedup-records.jsonl`; the cycle reads those records
and never asks for, parses, or validates an answer object. A candidate with no record stays
pending, so a failed tool call files nothing and the next cycle retries it. A duplicate of an open
issue is suppressed silently: no issue, no comment. Its ledger entry records `duplicate:<url>` with
no `filed:` disposition, so it is never treated as filed and never takes a 24-hour recurrence
comment. `issues_list` reads every open issue page by page and reports `truncated: true` when an
explicit `limit` or a forge read ceiling kept the older rows back, so an open issue below one
`list` page is never invisible by silence.

Suppression is open-only. While the matched issue is open, the candidate is not sent again. Once
that issue is closed, the next cycle that observes the same evidence sends the candidate to the
agent again, and it is filed when the agent judges it unique. Candidates the agent marks
duplicates of one another produce at most one issue for the group, named by its representative in
`report.json`. Filing caps are applied after deduplication, so only unique candidates consume
room; previously filed entries keep their dispositions and their recurrence comments.

The gate fails closed. If the agent cannot be started, exits nonzero, or times out, the cycle
creates no issue and makes no comment, keeps every candidate pending, records the reason in
`report.json`, and exits nonzero. A candidate whose tool call failed has no record and stays
pending. The next cycle retries the same candidates through the agent. There is no whole-answer
coverage check and no re-ask for a rewritten answer.

`report.json` carries a `deduplication` section with the number of candidates requested, the
number of open issues the agent read, every candidate's disposition (`unique`, `duplicate` with
`issue` and/or `representative`, or `failed` with `reason`), and the candidates suppressed because
their matched issue is still open. The existing `action`, `reason`, `findings`, `issues`, and
`pending` fields keep their meaning, and `/api/watchdog`, the Watchdog page, and the footer
indicator are unchanged.

### State-directory cleanup

Every cycle sweeps each covered state directory. Covered directories are the canonical checkout's
`.devboard/.tmp`, every `*/.devboard/.tmp` directly under the canonical root's parent, and the
`STATE_DIR` of every live dashboard the cycle discovers, de-duplicated by real path. Entries older
than seven days are deleted; these are never deleted at any age:

- `.tmp/state/`, `.tmp/journal/`, and `.tmp/providers/`.
- `.tmp/watchdog/state.json`, `latest.json`, `lock`, `worker.json`, `settings.json`,
  `projection.json`, and `control/`.
- `.tmp/orchestrator/state.json`, `ledger.json`, and `lock`.
- `.tmp/issues/` and `.tmp/flow/` in full.
- `.tmp/coach/` in full: worker, settings, control, ledger, lock, runs, latest report, and the
  forge projection its caps count.
- `.tmp/goal-drafts/` in full: every draft's owner run record, activity, pending question,
  control directory, lease, and reload handoff. An elaboration waiting on an operator answer is
  still running however long it waits, and a finished draft's status is its only record.
- `.tmp/scout/<24-hex>/`, every repository's Auto Scout settings, worker state, and control
  commands, so a stopped worker keeps its caps and cadence.
- the run directory of the cycle performing the sweep, and a live `devboard-<pid>.lock`.

- any `lock` file whose content records a live `LockOwner`, such as the checkout-anchored
  `.tmp/scout/lock` a running Auto Scout holds. A lock whose owner is gone is swept, and the
  rest of `.tmp/scout/` — stale scans and issue bodies — follows the ordinary age rule.

Run the sweep by hand from `.devboard`:

```bash
bun run cleanup -- --dry-run --root <root>
bun run cleanup -- --once --root <root>
bun run cleanup -- --processes --dry-run   # orphaned processes, print only
bun run cleanup -- --processes --once      # orphaned processes, kill
```

The manual watchdog CLI remains:

```bash
bun run watchdog -- --once                  # one cycle now
bun run watchdog -- --collect --dry-run     # print this cycle's report; change nothing
bun run watchdog:uninstall                  # stop, disable, and remove a legacy unit
```

`verify:watchdog` proves the dashboard-started lifecycle, shared page ids, retained history, the
removed GET endpoint, and the footer indicator. `verify:watchdog-live` starts the seeded
dashboard's watchdog through its Start control (not systemd), waits for a real cycle to file the
seeded marker, asserts the ledger entry, title, and body, and closes the issue in `finally`.
`verify:agents` drives all five pages through headless Chrome; `verify:design` drives the Design
System route through the same shared interface.

## MCP optimizer

MCP optimizer is the `mcp-optimizer` descriptor in the shared background-agent contract: label
`MCP optimizer`, scope `repository`, cadence default 60 minutes, at most 2 issues per cycle, and
10 filings per rolling hour. `maxPending` remains a visible setting but no proposal is queued: the
synthesis turn files directly or records a skip. Its page is the shared `agent-page` with
`data-agent="mcp-optimizer"` and every shared core id; `agent-detail` renders the shared cycle
history. Opening, selecting, restoring, or reloading the page starts nothing. Start and Stop
command one detached worker per repository state directory.

MCP optimizer's files live under `<STATE_DIR>/coach/`: `worker.json` (published lifecycle),
`settings.json`, `control/`, `state.json` (the ledger), `lock`,
`runs/<cycle>/report.json|report.md`, `latest.json`, and `projection.json` (the dashboard's last
forge projection, rendered by the page). The directory keeps its historical `coach/` name: an
upgrade can leave a worker of the previous harness version live on the same lock, control
channel, and ledger, so moving the state would strand that worker and start a second one beside
it. The synthesizer also needs the generated per-peer directory under
`<STATE_DIR>/providers/agents/`, written with the same shared helpers every peer uses. Start reaches
`starting` before the worker exists and `running` once its state is readable; Stop reaches
`stopping` and then `stopped` after the running cycle ends and before any further cycle starts. A
stopped worker is not restarted by a dashboard restart, a page open, or a tab restore; a live
worker owned by another dashboard's state directory reads `running` with `owned: false`, cannot be
stopped from this dashboard, and Start is a no-op with a notice. Start preflight requires a GitHub
or Gitea origin and a write-capable account; a refusal names the missing fact, writes no state,
spawns nothing, and renders `agent-error`.

### Evidence

One cycle's window is the 24 hours ending at cycle start. It reads:

- every `.jsonl` under `<STATE_DIR>/providers/agents/*/sessions/**` whose `session` record names a
  `cwd` equal to the resolved `REPO_DIR` or inside `<REPO_DIR>/.worktree/`; any other cwd is
  ignored. Selection reads file metadata and the `session` header only: a transcript last written
  before the window starts is skipped, and the newest 1,000 selected files by session start are
  the only ones parsed. The report carries `truncated: true` with the totals when files were left
  out.
- this repository's dashboard journal, live and rotated, keeping the in-window records of kinds
  `question`, `acp-stderr`, `activity`, `run-start`, and `run-stop`, de-duplicated across a
  rotation exactly as the existing journal reader does.

Malformed JSONL lines and sessions without a usable timestamp, `cwd`, or id are counted and
skipped; they never abort the cycle. The report carries the window, session count, journal record
count, malformed count, and skipped-session count. Nothing under `$HOME`, `/tmp`, another checkout,
or outside `REPO_DIR` and `STATE_DIR` is read.

### Families

A cycle turns the window into families. One bash command yields one normalized key: the command is
trimmed, a wrapping `( cd <path> && ... )` is unwrapped, a leading `cd <path> &&` segment is
dropped, and the first remaining segment whose command is not an inspection prefix is kept. Pipes
(`| tail -N`, `| head -N`, any `| <command>`) and redirections (`2>&1`, `> <path>`, `2> <path>`,
`< <path>`) are stripped. The existing replacements then apply: a leading environment assignment
becomes `<env>`, the repository root becomes `<repo>`, `.worktree/<name>`, UUIDs, ISO timestamps,
and seven-or-more hex runs are replaced, and a `git -C <dir>` prefix becomes `git`. The family key
is the remaining tokens up to the first `--flag`, so `bun run publish 2>&1 | tail -40`,
`bun run publish | tail -60`, and `( cd /checkout && bun run publish )` are all `bun run publish`,
while `git push origin HEAD:main` and `git push origin other` stay separate. Two families never
merge when their tokens before the first flag differ.

A nonzero exit whose command matches an inspection prefix is normal and produces no evidence. Every
other bash call attaches to its family as an occurrence; an errored mutating tool call (`edit`,
`write`, `multiedit`, `apply_patch`, `patch`, `ast_edit`) attaches to a family named for the tool;
a read-only tool error is ignored. A retry loop (one call identity at least three times, at least
two after an error) adds weight to the repeated command's family and never forms its own family. A
journal `question` repeated in at least two scopes becomes `question: <normalized text>`; an
`acp-stderr` line repeated in at least two scopes becomes `run-failure: <normalized line>`.
Sessions and commands owned by MCP optimizer (`.devboard/mcp-optimizer`,
`verify:mcp-optimizer`, an MCP optimizer run cwd), fixture-only commands (`true`, a no-op `echo`,
`i: noop`), and anything under `.worktree/` or `.devboard/.tmp/` are excluded from families and
excerpts.

Each family carries `key`, `kind` (`command`, `question`, `run-failure`), `calls`, `sessions`,
`days`, `firstAt`, `lastAt`, `fragments` with counts, and at most five excerpts. An excerpt holds
the command bounded to 300 characters, its exit status, at most 10 output lines and 2,000
characters, and the session title. The score is `sessions * days * calls` after normalization. The
selection sorts by score descending with ties by key ascending and takes at most 20; the report
carries the selected keys in order and the omitted count. Identical evidence and clock produce
identical families and prompt bytes.

### Synthesis and validation

Each selected family gets exactly one ACP synthesis call, at most four at a time, with a
120-second timeout. The peer is `AGENT_COMMAND` (default `omp acp`) built from every enabled
OpenCode Go subscription, led by the dashboard's published selection when it still names an enabled
key and otherwise by the operator's list order, pinned to
`opencode-go/deepseek-v4.1-flash`; permission and elicitation requests are cancelled. The MCP
optimizer does not probe the usage endpoint: a quota read cannot decide whether a cycle finishes,
so it follows `selection.json` instead. A credential rejection the peer reports in its ACP error
frame or stderr rotates to the next enabled Go subscription and, when none is left, fails closed;
a 401 or "unauthorized" quoted inside assistant text never rotates. The prompt starts with a
`## Manifesto`, carries the family summary, every fragment with its count, at most five excerpts,
the MCP catalog as name/title pairs plus every `covers` entry, every open MCP optimizer issue as
number/title/URL, the configured allowlist, `maxIssuesPerCycle`, the rolling-hour room, the family
tag, and the exact body sections; it stays under 24 KiB. A cycle whose synthesis calls all fail
records the failure and files nothing. A failed call among successful ones is recorded for its
family and does not discard what the other calls filed.

The agent reads the open MCP optimizer issues through the MCP read tools and files at most one
proposal itself through the MCP `issue_create` tool, or records why it filed nothing through
`mcp_optimizer_proposal_skip`. There is no synthesis answer object, no deterministic proposal
validator, and no `pendingFiling` queue. A proposal the agent does not file is recorded as
`skipped` with its reason; the next cycle reconsiders the family. The tool records are the only
filing evidence, and a tool error is recorded for that family.

The MCP optimizer page's Prompt disclosure shows that same prompt as one read-only template
(`agent-prompt-template`, with the text in `agent-prompt-template-text`), not as a prompt file and
not as an absence. `synthesize.ts` renders both the call's prompt and the template from one fixed
text and one catalog/allowlist/limit/issue rendering, so the manifesto, the section headings, and
the `Rules:` bullets cannot drift apart; a test builds a real prompt for a fixture family and
asserts the fixed lines are equal. The per-family sections show `<family>`, `<fragments>`, and
`<excerpts>`; the live sections name the current catalog, read the allowlist and limits from
`<STATE_DIR>/coach/settings.json` on each connect, and list the dashboard's current open issues
filtered by `[mcp-optimizer]` title or `family:` body, sorted by number, or state that the open
MCP optimizer issues could not be read before the first successful read. Opening, closing,
restoring, or reloading the disclosure writes nothing and starts nothing, and no editor, Save, or
chat exists for MCP optimizer.

### Filing, caps, and the ledger

A tool proposal files `[mcp-optimizer] <family key>`; a prompt proposal files
`[mcp-optimizer] prompt: <family key>`. The body carries exactly one `## Family`, `## Evidence`,
`## Proposed tool` or `## Proposed prompt`, `## Acceptance`, and `## Rationale` section in that
order. The tool section holds a fenced JSON block of the proposed tool, its covers list, and the
exact allowlist entry the implementer must add. The body carries
`family:<first 12 hex of SHA-256 over the key>`. Every title, body, and failure reason is redacted
before the bytes leave the process: against the worker environment, against every API key
registered in the Providers store, and against the GitHub, Gitea, GitLab, npm, OpenCode Go, and
OpenRouter token shapes.

Before filing, the agent reads the repository's open issues. A family is skipped when an open issue
has the exact computed title or its body contains `family:<tag>`; the skip is recorded as
`duplicate` with the existing URL and the URL and number of the issue the turn just filed, and
nothing closes or comments on that issue. There is no suppression, no cooldown, and no recurrence
comment.

`maxIssuesPerCycle` (1 to 20, default 2) caps filings per cycle, and `maxPerHour` caps filings per
rolling hour. Each family's prompt receives a `filingRoom` of 0 or 1 after the caps and the already
filed count, and the agent files only when it is 1. Nothing is queued: a family that does not file
records its skip reason, and `pending` stays 0.

`<STATE_DIR>/coach/state.json` is version 3:
`{version: 3, families: {<key>: {firstSeen, lastSeen, calls, sessions, kind, lastAction,
lastIssueUrl?, lastTitle?, lastFiledAt?}}, pendingFiling: []}`. The field stays in the format for
compatibility but is always empty; a queue written by an older revision is discarded and reported
as `dropped`, never filed. It is written atomically after every filing. A version-2 ledger is
discarded on load, the report states `ledgerReset: true`, and deduplication relies on the forge.
`report.json` and `report.md` carry the window, session and journal counts, total family count,
selected keys with scores, omitted count, each synthesis call's model and duration, each recorded
outcome with its rule or skip reason, filed URLs, duplicate skips with both the matched and the
created URL, dropped count, and `pending: 0`.
The dashboard's `McpOptimizerStatus` exposes `cycle`, `action` (`filed`, `none`, `capped`, `failed`),
`reason`, `families`, `selected`, `filed`, `dropped`, `pending`, `issues`, and `cycles`.

A cycle edits no prompt, wrapper, source, session file, or journal record, and writes only
`<STATE_DIR>/coach/` plus the generated provider agent directory the synthesizer peer needs. The
page and worker send no command that starts, stops, or repairs another agent.

Run it by hand from `.devboard`:

```bash
bun run mcp-optimizer -- --collect --dry-run --root <checkout> --state-dir <state> --json
bun run mcp-optimizer -- --once --root <checkout> --state-dir <state> [--now <ISO>] --json
```

`verify:mcp-optimizer` seeds exactly three command families under `.devboard/.tmp`, injects a
deterministic synthesizer and a stub forge, and proves one synthesis call per family, the filed
title and body sections, the fenced tool definition and allowlist entry, no second filing, a cap
holding a proposal pending, and byte-identical session and journal directories.

## Devboard MCP server

`.devboard/omp/mcp.json` declares `mcpServers.devboard` with `type: "stdio"`. Its command and
arguments contain no absolute path: a small `sh -c` probe resolves the harness from
`DEVBOARD_HARNESS_DIR` when set, else the checkout's `.devboard`, else the installed prefix. The
harness serves the protocol itself as `devboard mcp`; `install.sh` copies the file to
`<host>/.omp/mcp.json` and the launcher installs the same bytes on install and update.

Every ACP peer the dashboard starts also receives an `mcp.json` beside its generated `config.yml`
in `PI_CODING_AGENT_DIR`. That registration names the running harness executable with the `mcp`
argument, so a peer whose cwd is a worktree, a temporary clone, or a host directory starts the
same stdio server with no project `.omp` directory and no module to resolve. An ACP session
ignores on-disk MCP discovery — the client owns the definitions — so the ACP client reads that
`mcp.json` and sends every enabled stdio entry in the `session/new` `mcpServers` list, converting
its `env` map to name/value pairs. A session opened without it has no Devboard tools at all, and a
lifecycle prompt that reads or closes an issue fails at its first call. Model roles, provider
selection, keys, and the peer environment are unchanged.

The server speaks newline-delimited JSON-RPC over stdio. Only JSON-RPC messages reach stdout;
diagnostics go to stderr. It answers `initialize` (protocol version, `serverInfo.name`,
`capabilities.tools`), accepts `notifications/initialized`, answers `tools/list` with the catalog
sorted by name, and answers `tools/call`. An unknown method returns JSON-RPC error `-32601`; an
unknown tool returns an error result without a side effect. It exits cleanly on stdin EOF and
starts no HTTP listener.

Every `tools/call` naming a catalog tool increments that tool's count in
`<stateDir>/mcp/tool-invocations/<repository key>.db`, a SQLite table with one bounded row per
tool name. The key is the 24-hex SHA-256 prefix of the resolved `REPO_DIR`, the same key the
journal and dashboard state use, so peers and the dashboard of one repository share counts while
two repositories that share a harness never mix them. The write happens when the request arrives,
the update is atomic across peer processes, and a failed or damaged counter never fails the tool
call; `getMcpTools` reports the table as the `invocations` map and a missing file as no counts.

### Read tools

|Tool|Inputs|Bounds|
|---|---|---|
|`devboard_status`|none|root, harness, state, branch/upstream/ahead/behind, live dashboard port/pid, version and versionState; no secret|
|`agent_sessions_list`|`since`, `until`, `cwd`, `limit`, `offset`|50 rows default, 200 max, newest first|
|`agent_session_read`|`id`, `offset`, `limit`|50 messages default, 200 max, 64 KiB of text|
|`agent_session_search`|`query`, `limit`|case-insensitive, 100 matches, 200-character snippets|
|`journal_search`|`kind`, `scope`, `since`, `until`, `query`, `limit`|200 records, 64 KiB, newest first|
|`background_agents_list`|none|the live `getAgents` snapshot, or persisted state|
|`background_agent_get`|`id`|the live `getAgent` snapshot, or persisted state|
|`goal_get`|none|the goal document, bounded at 64 KiB|
|`goal_drafts_list`|none|`.devboard/goal-proposals/*.md`|
|`goal_draft_read`|`path`|one draft, bounded at 64 KiB|
|`issues_list`|`state`, `limit`|open and closed issues, 200 rows|
|`issue_get`|`number`|title, bounded body, labels, state, URL|
|`entry_point`|`surface`, `seed`|one repository-relative path, a line inside it, the surface, and the seed|

The ACP session parser, token and cost summation, and tool-error fingerprint are the same module
MCP optimizer reads, so a seeded session reports the same id, relative cwd, totals, cost, tool name, and
error fingerprint through both surfaces. Every truncated response states `truncated: true` and the
next offset where paging exists. Selection stats each transcript and reads its `session` header;
only the newest 1,000 selected transcripts are parsed, and `agent_session_read` resolves the id
from those headers and parses only the matching file, so one read does not cost the corpus.

### Work tools

- `goal_spec_write` accepts the five section bodies and an optional slug, writes exactly
  `<REPO_DIR>/.devboard/goals/<slug>.md` with `## Objective`, `## Success criteria`,
  `## Verification`, `## Boundaries`, and `## Stop conditions` once each in that order, derives a
  lowercase kebab-case slug of at most six words, uses the first free `-2`, `-3`, … suffix, and
  refuses an empty section.
- `goal_draft_file` accepts a repository-relative spec path under `.devboard/goals/`, a one-line
  title of at most 200 characters with no leading heading marker, and an optional repository-relative
  draft under `.devboard/goal-proposals/`. It ensures the exact `goal` label, files the spec's bytes
  as the issue body, reads the issue back, verifies the label and byte equality, and only then
  removes the named draft. A failure names the step and keeps the draft.
- `issue_create` creates one issue with a one-line title, a full Markdown body, and an optional
  label list. It ensures each label before filing and returns the created number, URL, title, and
  labels. `issue_comment` appends one Markdown comment to an existing issue and returns the
  number that received it. Both use the shared forge client and its credential and timeout rules.
- `flow_widgets_register` replaces one Flow session's `widgets.json` with the supplied widget list
  and returns the recorded path and count. `flow_steering_ack` appends the consumed steering ids
  once each to `steering-ack.jsonl` and returns the written and already-recorded ids.
  `flow_checkpoint_record` appends one checkpoint to `checkpoints.jsonl` and returns its id and
  commit, and `flow_verification_record` replaces `verification.json` and returns the recorded
  status. The session directory must sit under `<STATE_DIR>/flow/`.
- `discover_sheet_stage`, `discover_contribution_stage`, `discover_glossary_stage`,
  `discover_significance_stage`, and `discover_skill_stage` write one Discover agent's staged slice
  under `<REPO_DIR>/.omp/discover/staging/` and return the path and identity. Publication reads
  exactly those paths.
- `design_release_request` records one cycle's release summary and rationale as
  `<cycle>/release-request.json`; the Design System worker still performs the commit, push, release
  workflow wait, and publish.
- `watchdog_duplicate_record` records one watchdog candidate's duplicate disposition for the
  cycle, and `mcp_optimizer_proposal_skip` records why one MCP optimizer family filed nothing.
  Neither creates or comments on an issue.
- `issue_close` closes one issue through the repository's forge as `completed` or `not planned` and
  returns the resulting state. Every issue read and write shares one bounded forge client: a
  credential probe or forge command that outlives its deadline (60 seconds by default) fails the
  call with a retryable timeout message instead of leaving it pending.
- `verification_run` runs only `test`, `check`, `build`, `typecheck`, or a `verify:<name>` present
  in `.devboard/package.json`, with `.devboard` as cwd, an optional bounded list of existing test
  paths, a 900-second deadline, and at most 16 KiB of captured output. It writes the check's complete
  output to a log unique to that invocation and returns that repository-relative path as `log`, then
  publishes the same complete output to `<stateDir>/<check>.log` when the run settles, so two
  concurrent runs never unlink each other's evidence and the 16 KiB `output` bound never shortens it.
  The deadline covers the output reads too and reaps the check's process group, so a descendant that
  inherits the pipes cannot hold the call. Any other check, a path outside `.devboard`, or an
  unknown `verify:<name>` is refused before anything runs.

### Control tools

`background_agent_control` (`start`, `stop`, `set_settings`, `disable_timer`), `issues_control`
(`start`, `pause`, `resume`, `stop`, `check_now`), `lifecycle_control` (`start`, `pause`, `resume`,
`stop`, `start_run` with a repository-relative `adrs/*.md`), `goal_control` (`save`, `create`,
`revise`, `prepare_skills`, `reset_implementation`), and `flow_control` (`create_goal`, `save_goal`,
`start_implementation`, `stop_implementation`) discover the single live dashboard whose `REPO_DIR`
resolves to this repository, delegate to its existing command handling, wait for the resulting
state or event, and return it. They never write a second copy of live state. Zero matches and more
than one match are refused with a message naming the repository and every port found; an action the
dashboard refuses is an error result naming its reason, with no state change.

### Confinement

Every path argument resolves inside `REPO_DIR`, `STATE_DIR`, or the one directory its tool names.
Absolute paths, `..`, and symlinks leaving those roots are refused. The server never executes an
arbitrary shell command, never prints a known secret environment value or a token-shaped string,
never edits a prompt, command wrapper, or source file, never creates a worktree, branch, commit,
merge, or push, and never applies a label the caller did not name. Read-only tools leave every file
byte-identical, a refused call has no side effect, and an identical call on unchanged state returns
identical JSON except for live timestamps. Every write tool validates its own arguments against the
catalog schema before acting and returns the created or recorded identity; no tool asks an agent
for an answer document to parse later.

`verify:mcp` starts a source dashboard against a throwaway host with a stub forge, stub ACP command,
and seeded sessions, journal, goals, drafts, and issues; speaks JSON-RPC over the declared command;
and proves the catalog, every read, work, write, and control tool, the expected written paths, the
refusals, the caps, the generated peer registration, the installed-package server, and secret
redaction. Its `entry_point` section names the tool, its schema, a repeated seed returning the
same path, two seeds reaching different paths on a two-file pool, a fresh seed that replays, and
a refused unknown surface.


## Issues mode

Issues is the fourth mode in the activity rail, below Goal. Each dashboard controls exactly one
repository: its own `REPO_DIR`. Starting Issues in one checkout's dashboard polls that checkout's
origin open issues and starts one ACP agent for every open, unhandled issue in that same poll, up to
thirty at once. Each issue without the exact `goal` label receives exactly
`/implement-issue <number>`; each `goal`-labeled issue receives exactly
`/implement-goal-issue <number>`. A thirty-first ready issue waits in the queue and starts as soon
as a running peer finishes; no peer waits for another to finish. A detached worker
owns the poll loop, the peers, the ledger, the lock, and the activity for one repository, so it
survives a dashboard restart and two repositories never share a worker. No systemd unit, timer, or
machine-level scheduler is involved, and neither starting nor restarting a dashboard starts a
worker.

Start first proves the facts it needs: a canonical checkout root that is not a linked worktree,
a GitHub `origin`, `omp` and `gh` on `PATH`, the `/implement-issue` command installed for the
operator's omp, and the `/implement-goal-issue` extension installed beside it. Commands are
discovered in `<REPO_DIR>/.omp/commands/`, `<REPO_DIR>/.omp/agent/commands/`,
`$HOME/.omp/commands/`, and `$HOME/.omp/agent/commands/`; the extension in
`<REPO_DIR>/.omp/extensions/` or `$HOME/.omp/extensions/`. A refusal names the missing file, every
path searched, and `.devboard/install.sh` as the remedy, spawns no peer, and writes no run. Start
also requires `gh api repos/<owner>/<repo> --jq .permissions.push` to return `true`. A live legacy
`devboard-orchestrator` lock is refused too; the harness never stops that process. Issues mode no
longer requires `/implement-all-issues`; that command stays usable by hand outside the mode.

The whole Start preflight has a 20-second deadline. A `gh` probe or preflight that does not settle
is abandoned at that deadline, its child is killed (`SIGTERM`, then `SIGKILL` after 200 ms), and
Start answers `{ ok: false, message }` naming the deadline. The in-flight Start task is cleared
from memory, so the next Start runs the preflight again and spawns the worker when it succeeds;
no restart is needed.

The worker is spawned detached in its own session from the harness package the server loaded,
with `REPO_DIR` as its working directory. It holds `<REPO_DIR>/.devboard/.tmp/issues/lock`, which
records its pid, argv, state directory, and harness version. A lock whose owner is gone is
reclaimed before a new worker starts; a lock with a live owner is never taken over. A second
dashboard with the same `REPO_DIR` and `STATE_DIR` attaches to that worker. A second dashboard
with the same `REPO_DIR` and another `STATE_DIR` cannot attach and is refused, because the
repo-anchored lock names the live worker. Start after Stop on the same dashboard waits for the
stopping worker to exit and only then spawns; if it still lives at the stop proof deadline, Start
is refused with a message naming it instead of reporting it attached. Concurrent Starts share one
preflight and spawn. Different repositories get independent workers.

The poll is the origin's issues endpoint through the operator's forge credential every 10 seconds,
conditional on the previous `ETag` (`If-None-Match`). A `304` is no change; `403`/`429` honor
`Retry-After` or `X-RateLimit-Reset`. Each read has a 20-second deadline: a stalled `gh` is killed,
the poll records the timeout in `poll.error`, and the next poll runs on schedule instead of
leaving the loop blocked on the abandoned read. Pull requests returned by the endpoint are
excluded, and every issue's labels are part of the poll result. An issue that already has a
running agent never receives a second peer, so a poll while four peers run starts none of them
again. An issue first seen while three peers run gets its own peer on the next poll without
pausing, restarting, or shortening the others. The worker's ledger records which issues a
successful run already handled; it is bookkeeping that decides when a run may start, never a row
or a count on any surface. A handled issue is never retriggered while it stays open; a closed issue
leaves the ledger, so a reopened one is eligible again. A poll with no unhandled open issue starts
no peer and publishes `idle`.

The Open issues list and every row's state come from one forge read: the dashboard's own read of
the origin's open issues. While at least one client is connected it re-reads every 30 seconds
(`DEVBOARD_ISSUES_SYNC_INTERVAL_MS`) and immediately on connect, and publishes the result in the
snapshot's `sync` field. That read is the only source of a row: no worker state file, stopped
worker's memory, or ledger entry adds, removes, or re-states one. The `processing` label is the
one forge state that marks a run in progress: a running worker ensures the label exists, adds it
to the issue before its peer starts, and removes it when the run finishes, fails, is abandoned, or
stops. The pending count is every listed issue without that label; the running count is every
listed issue with it, and the page badge, sidebar entry, overview `Queue` line, and status bar all
read those numbers from the same queue. A failed read freezes the last successful answer and
publishes its error in `sync.error`.

A running issue that no longer appears in the dashboard's read is stopped: the dashboard sends one
`abandon` command for that issue, and the worker records its run `stopped` with no handled entry
and no cooldown. A live worker's own poll never changes the page's rows or counts, even when it
lists a different set; only the dashboard's own fresh read does. With no connected client the
dashboard makes no tracker call, and the worker's own poll still ends a run the moment it sees the
issue leave the open list. Every running worker also reconciles the `processing` label against the
repository's live claims: an open issue that carries the label with no live claim is repaired on
the next poll, which covers a killed worker, a restarted dashboard, and an upgrade that leaves an
older worker's state behind.

A goal issue is the record of one goal, so its run settles only on a proven close: while the
issue is open it never finishes `succeeded` or `stopped`. A poll that drops an open goal issue
fails the run with a detail naming the issue and its open state, and a close the tracker proves
keeps the cancellation record.

That stop is a cancellation, never a completion. A run closes its own issue through
`issue_close`, which records the closing run beside the issue's state under the worker's state
directory; the worker passes `DEVBOARD_ISSUES_RUN_ID` to each peer so the tool can name it. The
dashboard sends no `abandon` for a run the record names, and the worker applies none: the run
finishes its turn, its own turn-end read proves the issue closed, and it is recorded `succeeded`
with its handled entry, exactly as when a poll never dropped the issue. The record names one run,
so a later run for the same issue is stopped as usual, and it is removed when its run settles.

Session updates stream into the mode, permission requests are auto-approved by the ACP client,
elicitation questions are answered per agent, and every peer closes when its run ends or Stop is
clicked. The agents own every worktree, commit, push, issue closure, and repository mutation; the
worker passes no scope beyond the issue number and never edits code itself.

### The `/implement-issue` contract

`.devboard/prompts/implement-issue.md` holds the whole contract and
`.devboard/omp/commands/implement-issue.md` is its command wrapper: it carries a `description` and
an `argument-hint`, reads the prompt, and passes `$ARGUMENTS` as the issue number. No other
harness file duplicates the contract.

The prompt requires the argument to be exactly one positive integer issue number and refuses a
missing, non-numeric, or multi-token argument before changing anything. It fetches exactly that
one issue and never fetches, surveys, or builds a dependency graph for the rest of the backlog.
It creates and works in one worktree under `<REPO_DIR>/.worktree/` named for the issue, never in
the canonical checkout and never in another agent's worktree, and writes nothing outside
`<REPO_DIR>`. Forge write access is a precondition it resolves once per session: a `canWrite: true`
result already in context is reused as-is, and only when the context lacks one does it run one
canonical auth check, `bun .devboard/scripts/forge-auth.ts check --required write --json`, from the
repository root: the wrapper takes the target from `DEVBOARD_GITEA_URL`, `GITEA_TOKEN`, and the
`origin` remote, so no forge, host, project, or URL flag is passed, the exit status and JSON are
read directly, and no further auth probe runs in the session. The shared credential rule every
tracker prompt follows is `.devboard/prompts/forge-auth.md`: the wrapper is the only authority for
forge host, project, and token scope, and enumerating the environment or reading credential files
to find them is forbidden. It changes only that issue's implementation, tests, and documentation;
it may read other issues and code but never edits, comments on, closes, or reopens another issue.
When the issue declares an open prerequisite (`depends on`, `blocked by`, or a
task-list issue reference), it writes `blocked: #<prerequisite>` as the first stderr line, exits
nonzero, leaves the issue open and unhandled, and never implements the prerequisite in another
agent's place. It is
non-interactive: no `question` tool, no confirmation, no interactive editor, no login prompt. It
fetches the canonical integration line, integrates concurrent changes, resolves every conflict
itself, reruns every check the integration invalidates, and publishes directly to that line with
bounded retry when a push is rejected; it never creates a pull request or merge request and never
force-pushes. It lands with one fast-forward merge and one push, then proves the push with a
single verification block read once: `git fetch origin main`,
`git rev-parse --verify origin/main`, `git rev-parse --short HEAD`,
`git rev-parse --short origin/main`, `git rev-list --left-right --count HEAD...origin/main`,
`git merge-base --is-ancestor HEAD origin/main`, and `git status --short --branch`. It never
chains those ref probes with `&&`, never passes two revisions to `--short` or `--verify`, never
repeats the block to reconfirm printed output, and forbids `git ls-remote` and a second
`git status` readback. It closes the issue only after the block reports `ancestor=0` with no
`ahead` marker and the required checks pass, and puts the revision and the verification evidence
in the final response.
A proven duplicate, invalid, or already-fixed issue is closed with evidence and without committing
unrelated work. A successful agent removes only the worktree and branch it created; a failed or
blocked agent leaves its worktree in place and reports its path.

A goal label keeps its goal-mode implementation contract: every goal-labeled issue runs
`/implement-goal-issue <number>` concurrently with the rest. For every origin the command reads the
issue through the repository's forge, and the emitted goal prompt closes it through the Devboard
MCP `issue_close` tool with that issue number and `reason` `completed`. That tool records the
closing run, so a finished goal run settles `succeeded` instead of being read as an operator's
cancellation, and the prompt names no other tracker write. A GitLab goal issue is refused with
that reason.

### Per-agent state, lifecycle, and history

Each agent has its own run directory, `run.json`, `activity.json`, first-stderr line, question,
ACP child record, and retry gate keyed by issue number. No agent shares a run record or question
slot with another. The published state carries `agents`, one entry per running issue with `runId`,
`issueNumber`, `startedAt`, `question`, and `acp`; the worker's own queue document carries each
issue's `handled`, last handling `runId`, and `agentRunId` for its bookkeeping, never for the Open
issues snapshot; and `cooldowns` maps an issue number to its ISO 8601 retry
time. A failed agent finishes its run as `failed` with its first stderr line, leaves its issue
open and unhandled, and writes only its own cooldown. A clean ACP turn is not proof of work: a
refused slash command still ends the turn normally, so before a run can succeed the worker asks the
tracker for that issue's state. Only an issue the tracker now reports closed finishes as
`succeeded`, records only its issue as handled, and does not touch another issue. An issue still
open after its turn gets up to four follow-up turns on the same peer, because nothing else prompts
an ACP session again: a peer that yielded to a long background job — a full-suite
`verification_run` can wait many minutes — reads that job's result in the next turn and closes its
issue instead of leaving landed work unhandled. When the issue is still open after the last
follow-up turn, or its state cannot be read, the run finishes as `failed` with a cooldown and
stays unhandled. A peer can also stop answering without ever ending its turn — a model call or
tool that never returns — so a run that produces no activity, stderr, question, or turn end for
thirty minutes is verified and settled the same way: a close that landed meanwhile is a success,
and an issue the tracker still reports open finishes `failed` naming `<issue>` and its open state
instead of sitting `running` indefinitely. A verification error names its issue; when a later poll
no longer lists that issue, the error clears, so the Overview never keeps claiming a closed issue
is open. The
five-minute cooldown remains: an issue in cooldown is retried when it expires, and other issues
keep running and start normally.

`Check now` clears every cooldown and polls immediately; while paused it writes a notice and polls
nothing. Lifecycle is `running` while any peer runs, `pausing` while paused with any peer,
`paused` when paused with none, `failed` when enabled and unpaused with no peer and an unhandled
issue still cooling down, `idle` when enabled and unpaused with no peer and no unhandled issue,
and `stopped` after Stop. Pause, Resume, Check now, and Stop apply to the whole fleet. Pause starts
no peer and no poll and lets every peer finish. Stop closes every peer, records every active run as
`stopped`, leaves every captured issue unhandled, writes no cooldown, releases the lock, and stops
the ticker; no peer survives Stop. A fresh worker start terminates every ACP child the previous
state recorded when `/proc` proves the process is that child, closes every interrupted run as
`stopped`, clears `agents`, and starts no peer from stale state.

State, ledger, runs, and activity live under `<STATE_DIR>/issues/<journalKey(REPO_DIR)>/`:
`state.json` is atomic, `ledger.json` records handled numbers with the run id,
`runs/<runId>/run.json` and `runs/<runId>/activity.json` keep the newest 50 finished runs plus
every currently running run, and `control/` carries dashboard commands as atomically renamed
files. Each run's activity is persisted before the dashboard can read it, bounded at the first of
1,000 entries or 1 MiB with the trimmed marker, and is never merged with another run's activity.
On connect, the bridge replays `issuesState` and then one `issuesActivity` with `replay: true` for
every running agent, so a dashboard connecting mid-flight sees every agent and all its output. The
state document version is 2; the parser still accepts version 1, loading it with empty `agents`,
`cooldowns` populated from its `goalCooldowns`, and its queue, labels, ledger, and runs intact. A
damaged state file is renamed aside and never prevents the mode from opening.

The worker records the harness version it loaded, its pid, and its argv; a mismatched dashboard
shows a notice and never kills the worker, and the state records each ACP child's pid, argv, and
cwd so Stop or a fresh Start can terminate a proven orphan. The state also records why it stopped
claiming work (`pauseSource: "operator"` for a Pause, `"drain"` for a newer version's takeover)
and each run summary's owning `harnessVersion` and `workerPid`; both fields are optional, so a
document from an earlier harness still loads, and a summary without them is attributed from its
`run.json`. `workers/<version>/drain.json` records the dashboard's automatic drain for a worker
whose harness predates the pause source; it is honoured only for the pid it names, so a later
worker of the same version never inherits the drain. The first worker to find no repo-keyed
ledger imports handled numbers from `<STATE_DIR>/orchestrator/state.json` and `ledger.json` when
the legacy state parses and its `root` resolves to this `REPO_DIR`. A missing, damaged, or
mismatched legacy file is ignored. The legacy files are otherwise left untouched.

An already-installed legacy unit is removed by hand, once:

```bash
systemctl --user disable --now devboard-orchestrator.service
rm -f ~/.config/systemd/user/devboard-orchestrator.service
rm -f ~/.config/systemd/user/default.target.wants/devboard-orchestrator.service
systemctl --user daemon-reload
```

### The Agents surface

The Issues sidebar has no `Agents` entry and the Overview has no Open Agents control; the command
palette lists `open.issues.agents` in the `Workspace` group with the title `Open Agents` and opens
the tab from any mode.

The tab is `{ id: "agents", kind: "agents", resourceId: "agents", title: "Agents" }` and is
restored after a reload. The page renders `data-testid="issues-agents-page"` with a page header
`data-testid="issues-agents-header"` that carries the repository, the running count
`data-testid="issues-agents-count"`, and, when any agent is blocked, a warning badge
`data-testid="issues-agents-asking"` with the aggregate `<n> need answers`. With no active agent it
renders `data-testid="issues-agents-empty"` and an `Open Overview` control
`data-testid="issues-agents-overview"` instead of the grid.

The grid `data-testid="issues-agents"` holds one card per running agent, sorted by issue number
ascending. Each card has `data-testid="issues-agent"`, `data-issue`, `data-run`, `data-status`, and
`data-asked` while its agent waits for an answer; its head shows the issue number linked to its
tracker URL while the queue lists the issue and as plain text without an `href` otherwise, plus
the `Focus` control, and it does not repeat the fleet's status or waiting state as
a badge. Below it the issue title reserves two lines, then one compact elapsed and started-time
line whose tooltip carries the exact timestamp. Cards in one grid row share a height. The run id
appears in the Focus tab, not on the card. Every card renders its agent's full streamed output in
`data-testid="issues-agent-activity"` with `data-run`, under the `Latest activity` label; the log
scrolls, follows its newest line while the operator is at the bottom, and stays put when scrolled
back. It is 64px on a waiting card and fills the remaining card body otherwise. A pending question
renders inside only that agent's card as `data-testid="issues-agent-question"` with `data-run`, its
options with a recommended marker, and a free-text answer. The controls are
`data-testid="issues-agent-choice"`,
`data-testid="issues-agent-answer-input"`, and `data-testid="issues-agent-answer-submit"`, each
carrying `data-run`. Answering sends `{ type: "answerIssues", runId, id, value }`; only the agent
with that run id receives the value, only its question clears, and a missing or unknown run id is
refused with an error that reaches no peer. Two agents asking at once keep two independent
questions.

Activating a card (its `Focus` control) opens
`{ id: "agent:<runId>", kind: "agent", resourceId: <runId>, title: "#<issue> <title>" }`, rendering
`data-testid="issues-agent-focus"` with `data-testid="issues-agent-focus-status"`, the same full
activity in `data-testid="issues-agent-focus-activity"`, its question in
`data-testid="issues-agent-focus-question"`, and `data-testid="issues-agent-focus-close"`. The
output panel header names its run once: a `Run` label, the identifier as a `.code-chip` in
`data-testid="issues-agent-focus-run-id"` (capped at 220px; the full id is in its `title`), and
`data-testid="issues-agent-focus-run-started"` reading `Started <relative time>` with the ISO
start in its `title`. The start time comes from the live agent and falls back to run history; a
missing timestamp renders no age. The header carries no bare `panel__subtitle` run id and no
second status badge. The focus tab survives a reload while the run is active. After the run ends,
a restored focus tab shows that run's final status and activity from run history, or a clear
no-longer-available state linking to Runs when the run has been pruned.

The Overview keeps the Start, Pause, Resume, Stop, and Check now controls, the poll and worker
facts, and `data-testid="issues-overview"`. It shows the running-agent count as
`data-testid="issues-running-agents"`, the pending count, the number of issues in cooldown and the
earliest cooldown time as `data-testid="issues-cooldowns"`. The left column holds the Automation
panel and, directly after it, the running agents in
`data-testid="issues-agent-summary"`: one row per agent carrying `data-run` and `data-issue`,
sorted by issue number, with `aria-current="true"` on
the selected agent, the issue title, a `needs answer` badge while it asks, and its elapsed time.
The row's issue number is a tracker link (`data-testid="issues-agent-row-issue"`, opening the
issue URL from the queue in a new tab) while the queue lists the issue and plain text without an
`href` once it does not, next to a control that selects the agent's output.
The running-agent panel header carries an aggregate `data-testid="issues-overview-asking"` warning
badge (`<n> needs answer` or `<n> need answers`) only while at least one agent waits; the fleet
count is not repeated in that header because the Automation panel states it.
Each row also carries `data-testid="issues-close-issue"` with `data-issue`; it closes that issue on
the tracker as `not planned`, so an issue the operator does not want implemented leaves the next
poll without stopping the agent already working it. A refused or failed closure leaves the issue
open, reports the reason as an error notification, and releases that row's control at once so it
takes a retry; a stalled credential probe or `gh`/`glab` close fails at its 60-second deadline with
that timeout as the reason instead of leaving the control pending; a successful one reports
`Closed issue #<number>.` and disables the control until the queue drops the issue.
The right column renders only the selected agent's output in
`data-testid="issues-overview-output"` with `data-run`, its stream in
`data-testid="issues-overview-activity"`, and its question in
`data-testid="issues-overview-question"`. The first agent is selected by default, the row's select
control switches the output, and the pane falls back to the first live agent when the selected run
ends; the overview list selects instead of opening a tab. The queue lists exactly the open issues the forge
read returned, each with its `goal` badge and its `processing` state, and shows a running marker
only for an issue whose labels carry `processing`; no handled badge, run id, or worker state adds a
row or a marker. The Runs page lists every run with its status and issue,
and a run's detail shows only that run's activity. The status bar's issues indicator reports the
family's running work rather than an older member's drain: `issues working (N)` counts running
agents across every attached worker, and neither the label nor its accessible name or title says
`pausing` or `drain` while a newer worker takes over; an operator's Pause still reads
`issues pausing`. Each running task names its owning worker's harness version on the Overview row,
the Agents card, and the run detail, so granular version migration is visible at all times and a
known version never reads `unknown`. Activating the indicator opens the
Issues Overview from whichever Issues surface was open, so a click always lands on the automation
state it reports.

## Draft goals and proposed goals

The Issues sidebar carries `Draft goals` after `Issues`, with `data-command="open.issues.drafts"`
and `data-testid="open-issues-drafts"`. It trails the number of listed drafts, its accessible
name names the Issues mode and the `Alt+2` shortcut, and the command palette lists it under the
same command id. Opening it renders `data-testid="issues-drafts"`: every regular `.md` file
directly under `<REPO_DIR>/.devboard/goal-proposals/`, sorted by filename, each with
`data-testid="issues-draft"` and `data-path` holding the repository-relative path, its filename,
and its first Markdown heading. An empty directory replaces the two-column body with one
full-width Proposed goals panel whose centered state (`data-testid="issues-drafts-empty"`) reads
`No drafts yet` and explains the creation paths; no empty detail column is rendered. While drafts
exist but none is selected, the detail column carries the centered `No draft selected` state
(`data-testid="issues-drafts-selection"`).

The list header carries a `New goal` control (`data-testid="issues-draft-new"`,
`data-command="issues.draft.new"`); the command palette lists the same id, opens the Draft goals
page, and opens the popover. Activating the control opens
`data-testid="issues-draft-new-popover"` under the header and writes nothing. The popover holds
one instructions field (`issues-draft-new-input`), a submit control (`issues-draft-new-submit`),
and Cancel (`issues-draft-new-cancel`); Escape and Cancel close it without writing a draft or
starting a peer. One submit posts `{ "report": <instructions> }` with no captured page context to
`POST /goal-proposals`, so exactly one draft lands with the heading, the line
`> Unprocessed draft. ...`, the instructions verbatim, and a `## Captured UI context` section that
states `No page context was captured.`; it invents no route, element, viewport, visible text, or
DOM excerpt. Naming, the exclusive create, and the `-2`, `-3`, … suffix are the report panel's. A
whitespace-only input submits nothing.

When no elaboration runs, the page sends exactly one `startGoalDraft` for the written path after
the write, so `/goal-draft <repository-relative path>` starts at once and the popover closes with
the new draft selected in `issues-draft-detail`, its `running` state, its activity, and
`issues-draft-stop`; a question for it renders in `issues-draft-question` and its answer reaches
only that peer. When another elaboration is already running, the submit still writes and selects
the draft but starts nothing: the new draft's start control is disabled with the running
elaboration named as its blocker, and it becomes startable once that run ends, with no queued
start. A write the server refuses leaves no draft and no peer and shows the server's reason in
`issues-draft-new-error` while the popover and instructions stay; a start the server refuses after
the write keeps the draft listed, selected, and startable, and shows that reason in the detail. A
double submit while the write or start is pending produces one draft and one peer. Creation never
runs `gh`, files an issue, creates a worktree or branch, or writes a goal spec; only the draft file
is created. The report panel's `Goal` action and the path that opens a draft and starts it from
its row are unchanged.

Selecting one opens `data-testid="issues-draft-detail"`: the header carries the draft's file name,
the state badge for this draft's run only (absent while the run is `idle`) and, while this draft
runs, `issues-draft-stop` (`issues.draft.stop`). Starting an elaboration is the row's job: each
row carries its own `data-status`, renders that state as text, and has its own
`issues-draft-row-start` control (`issues.draft.start`); the detail does not repeat it. Starting
a draft from its row selects that draft before the start is sent, so `issues-draft-detail`
switches to it and the `issues-draft-activity` stream on screen belongs to the goal just started.
A row whose elaboration waits for an answer carries `data-question="true"` and renders a warning
`answer` badge (`issues-draft-waiting`) so the wait is visible without opening that draft;
answering clears both. The body reads the proposal before the
`## Captured UI context` marker, then the activity stream in `issues-draft-activity` once a run
exists; the captured UI context itself is not shown. A pending elaboration question
(`issues-draft-question`) renders above the proposal, with `issues-draft-choice`,
`issues-draft-answer-input`, and `issues-draft-answer-submit`. Selecting another draft switches the
detail to that path's own state, activity, and question, and reselecting the first restores its
transcript and still-pending question. The detail refreshes when the page opens, after the report
panel writes a draft through `POST /goal-proposals`, after an elaboration finishes or stops,
and when a listed draft disappears. The page polls the list every two seconds while it is mounted,
so an external deletion is visible without a reload, and the report panel's write broadcast
reaches an open page immediately. A browser reload restores the Draft goals page and the selected
path; when the file no longer exists, the page opens the list.

The read path accepts only `.devboard/goal-proposals/<name>.md`: an absolute path, `..`, a nested
path, a directory, a missing file, or a symlink whose real path leaves the drafts directory is
refused with a visible error, and nothing outside the directory is read. The list never follows
symlinks.

Every row also carries a delete control (`issues-draft-row-delete`, `issues.draft.delete`) beside
its Start control. Activating it opens `issues-draft-delete-confirmation` naming the draft and the
directory it leaves; Cancel closes the dialog without writing anything, and the confirm control
(`issues.draft.delete.confirm`) sends `deleteGoalDraft` for that path. The row leaves only when
the server's republished list arrives, so a refusal leaves the draft listed and its reason arrives
as a server error notification. The server unlinks the draft and its recorded run, then
republishes the list to every client; deleting the open draft clears the selection to the
`No draft selected` state, and every other draft keeps its own run state. A draft whose
elaboration is live or still closing stays listed: its delete control is disabled with
`This draft is being elaborated.` as its title, and a command that reaches that state anyway is
refused with the same reason. Deletion files nothing, runs no `gh`, and starts no peer.

Every draft may elaborate at the same time; there is no concurrency cap beyond the repository's
own draft files. Starting a draft spawns exactly one ACP peer with `AGENT_COMMAND --no-skills` in
`REPO_DIR`, opens one session, and sends exactly `/goal-draft <repository-relative path>`. The
elaboration reads the repository directly and names no skill, so the flag keeps OMP from
discovering the host's skills; their background description compression would otherwise log a
warning the watchdog files. Each path has at most one live peer: a start for a path already
running is refused with `This draft is being elaborated.` and starts no second peer. While a draft
runs, only its own row shows the disabled start control, whose title is
`This draft is being elaborated.`; every other draft stays startable. Each peer's activity streams
only into its own run's `issues-draft-activity`, its `ask` question renders only for that
draft, and an answer goes only to the addressed draft's peer; an answer for a draft with no
pending question is refused without reaching any peer. Stop closes only the selected draft's peer,
records `stopped`, keeps that draft, and leaves every other elaboration running. A successful or
failed run closes only its own peer before recording `succeeded` or `failed`; a failed peer keeps
its draft, shows its error there, and accepts a retry as a new peer. A successful completion
removes its draft from the list when the agent deleted the file, without clearing another draft's
state. Browser reload and WebSocket reconnect replay every draft's own run state, activity, and
pending question.

The peers are not held by the server process. One detached owner process per draft carries each
running elaboration, persists its run under `STATE_DIR`, and consumes that draft's answer and Stop
commands, so a version reload hands every running elaboration to the replacement: the reload
control writes a handoff before this server exits, and the replacement attaches to the same
owners, peers, prompts, activity, and pending questions before it serves the Draft goals page. An
answer or Stop after the reload reaches the original peer for its own draft, and no second peer
or second question appears. Any other dashboard exit, abrupt or not, ends every owner and its peer
within ten seconds and records one `failed` run per interrupted draft whose error names that the
server exit interrupted the elaboration; each draft stays listed and startable, and nothing
resumes automatically.

`.devboard/prompts/goal-draft.md` is the elaboration contract and
`.devboard/omp/commands/goal-draft.md` its command wrapper, which reads the prompt and passes
`$ARGUMENTS` as the draft path; `install.sh` installs the wrapper into the host's `.omp/commands/`.
The prompt requires repository research before questions, then an `ask` interview with exactly one
question per call, three mutually exclusive options with concrete descriptions and exactly one
recommended, and forbids questions about effort, cost, time, token budget, or attempt caps. The
finalized spec contains exactly `## Objective`, `## Success criteria`, `## Verification`,
`## Boundaries`, and `## Stop conditions`, in that order, with binary success criteria and exact
verification commands or actions.

The spec is written to `<REPO_DIR>/.devboard/goals/<slug>.md`: lowercase kebab-case, at most six
words, and an existing filename is never overwritten (`-2`, `-3`, …). The elaboration agent
creates no other file except that spec and the draft removal, starts no implementation, and does
not enter goal mode. It files the spec's bytes verbatim, as a body file, as an open issue in the
checkout's `origin` (never the harness repository unless that is the origin), with a one-line title
bounded to 200 characters and the exact `goal` label, creating the label first when it is missing.
Every tracker command goes through `.devboard/scripts/forge-auth.ts exec --required write`. After
filing it reads the issue back with `gh issue view <number> --json number,url,labels,body`; only
when the `goal` label is present and the body equals the spec file may it delete the draft. A
failed label creation, issue creation, or verification leaves the draft in place and reports the
failure and any created issue URL. A successful completion removes the draft from the list, keeps
the spec under `.devboard/goals/`, and the next Issues poll lists the new open issue with its
`goal` badge.

The Open issues list shows exactly the open issues one forge read returns, each with its `goal`
badge and its `processing` state, so an issue closed in the forge disappears there without waiting
for the worker and the worker's own poll can never add, remove, or restate a row. Every
open, unhandled issue gets its own concurrent peer: non-goal issues are prompted with exactly
`/implement-issue <number>`, goal issues with exactly `/implement-goal-issue <number>`. Each has its
own run record, activity, and question slot. The snapshot publishes
`agents: [{ runId, issueNumber, startedAt, question, acp }]`, so the Agents page, the Overview, and
the Runs page address each agent by issue number and run id while several are active, and an
answer carries that `runId` so it routes only to its peer.

`.devboard/extensions/implement-goal-issue.ts` implements the command and
`.devboard/omp/extensions/implement-goal-issue.ts` is its host-side re-export copied by
`install.sh`. It accepts one issue number and refuses a missing number, a missing issue, an issue
without the exact `goal` label, or an existing goal in the session. It creates one worktree and
branch under `.worktree/`, activates the `goal` tool, and calls the `goal` create operation with
the fetched issue body verbatim as the objective: no distillation, no section filtering, and no
appended requirements. It then implements the body, verifies every criterion through the product
surface, merges into `main` with conflict integration and retry, pushes `main` to origin, removes
the worktree and branch, and closes the issue only after the push through the Devboard MCP
`issue_close` tool with `reason` `completed`. That close records the closing run, so the finished
goal run settles `succeeded` instead of reading as an operator's cancellation. The command's
prompt carries no forge CLI or forge API write of its own.

Pause lets every active peer finish, then reports `paused` and starts no new peer or poll.
Resume polls immediately. Stop closes every peer, records every active run as `stopped`, leaves
every issue unhandled, releases the lock, and writes no cooldown. A successful run records only
its issue as handled in the ledger once the tracker reports it closed; an open issue after a clean
turn, or a failed state lookup, records `failed` and gates only that issue for five minutes,
leaving it open and unhandled. A failed run records its first stderr line. An issue closed by its
agent leaves the queue on the next poll.

## Auto Scout

Auto Scout is the `scout` descriptor in the shared background-agent contract. The Devboard sidebar
entry `open-devboard-scout` opens the shared `agent-page` with `data-agent="scout"`; opening,
selecting, restoring, or reloading a tab starts no worker, scan, or lock. Opening the page reads
the forge through the shared dashboard reader, so a closure reaches the table within the
60-second interval even while the worker is stopped, and asks an already attached worker for its
own fresh read; a stopped worker is left stopped and receives no command. The page shows the
shared lifecycle, last-read clock, cadence, limits, filed-issues table, and detail panel described
above, plus `scout-activity` for the current or newest scan. The page also shows `agent-error` for
the last error and `agent-sync-error` for a failed forge read.

There is no review path. While a worker runs, each scan turn describes the complete survey and lets
the agent file its own accepted items: every recommendation scored 4 or 5 is created as a GitHub
issue in the host `origin` through the Devboard MCP `issue_create` tool with the exact `scout`
label, in the same turn. The worker reads the tool's records and re-reads the forge; it never asks
for, reads, parses, or corrects a `recommendations.json` answer, and a tool error is recorded in
scan activity without a second turn. `approveScout`, `draftScoutGoal`, and `rejectScout` are not
accepted commands. Stop keeps the filed rows and the limits; the next Start reads the forge and
scans again.

Auto Scout's Start preflight uses the same 20-second deadline as Issues mode: a `gh` permission
probe that does not settle is killed at the deadline, Start answers a bounded refusal naming it,
and the cleared task lets the next Start run the preflight again and spawn the worker.

Auto Scout's persisted settings live at
`<STATE_DIR>/scout/<journalKey(REPO_DIR)>/settings.json` and carry `maxPerHour`, `maxPending`,
and `intervalMinutes`. Empty limits remove that constraint. `maxPerHour` counts every Auto Scout
issue whose creation time is inside a rolling 60-minute window, in any state; `maxPending` counts
every open `scout` issue. One scan requests at most the smaller room, or 100 when both are
unlimited. A zero batch starts no scan; the next attempt is the earlier of the next 60-second read
and the moment the oldest hourly entry expires. A scan that files fewer items than requested is a
normal shortfall, recorded in scan activity, never a failure. The scan prompt states both caps and
the requested count, and the agent enforces them by reading the issue list through the MCP read
tools. After the turn the worker re-reads every `scout` issue; a failed read keeps the last known
rows and blocks filing until a read succeeds. The 60-second read and its 30-second bound are
unchanged.

### Significance and provenance

Every recommendation carries an integer `significance` from 1 to 5 and a non-empty
`significanceReason`. The prompt states the rubric, and the agent files only items scoring 4 or 5.
Each filed issue carries the exact `scout` label, no title prefix, and a body with category,
summary, impact, significance, evidence, proposed change, files, and acceptance criteria.
Detection, dedupe, title normalization, bodies, labels, ledger dispositions, and existing issue
URLs are unchanged by the shared control plane. No scan answer file is requested or written.

A scan never files a title whose normalized form matches any existing Auto Scout issue in any
state, any open issue title, or any draft goal heading. The agent reads those titles through
`issues_list` and `issue_get`; a duplicate is skipped and consumes no cap slot.

An open issue is `pending`; a closed issue is `implemented` regardless of `stateReason`; a
reopened issue returns to `pending` on the next read. For an implemented issue the worker first
reads the checkout: every commit whose landed subject ends with `(#<number>)` names the issue, and
the earliest published release containing any of them is the exact shipped version. That local
answer outranks the forge and is re-read on every sync while the version is blank, so a release
published later fills the row without waiting out the negative backoff. When the checkout names
none, the worker resolves the commit that shipped it from the forge — the close entry's commit
when present, otherwise the `commit_ref` entries of earlier commits whose message names the issue,
otherwise every 7–40 character hex token of the newest comments, most recent first — to one
unambiguous full commit through the checkout or the forge. Each candidate is verified rather than
trusted: comment prose carries fingerprints, process ids, and epoch stamps that look like a SHA, so
a candidate the forge reports as no such commit is skipped and the next one is tried, up to twelve
candidates per issue. The first commit that resolves and appears in a published release decides
the version. It then selects the earliest published release tag whose history contains that
commit, ordered by `publishedAt` and breaking ties by tag name. A tag the checkout already carries
answers containment offline; a release the checkout has not fetched is compared on the forge, so a
host without local release tags still reports the version. A closed issue that names no commit at
all — an API close records none, and a commit message that omits the issue number leaves the
timeline empty — reports the release published closest to its close: the newest release published
at or before the close, restricted to releases published after the issue was filed, and otherwise
the earliest release published after the close. That fallback is an approximation: an issue closed
long after the release that fixed it reports the newest release published before that close. The
row shows `—` when a resolved commit has no published release yet, or when no commit resolves and
no release falls after the filing; a release published later fills a blank version on the next
read. A commit message names its issue with a trailing `(#<number>)`, which is both the forge's
exact link and the checkout's landed reference.

### Periodic check

While started, the worker reads every `scout` issue and every published release every 60 seconds,
and immediately on Start; the table, states, and versions reflect a change within one interval. One
periodic read, including every `gh` child it starts and the release resolution that follows it, is
bounded to 30 seconds; a read that does not finish is a retryable transport failure and releases
the worker, so the retry schedule reads again (or, once exhausted, the next interval does). A
closed issue whose version does not resolve is attempted at most
once every six hours, and a newly published release retries every unresolved row at once. Each
attempt records its time and, when it fails, the reason on the row; the rows that have waited
longest are attempted first, and the whole resolution shares the read's deadline, so a stubborn
issue cannot hold `syncing` and starve the remaining rows or the next scan. A transient read
failure keeps the last known rows and the last success time, records no reason, reads as `stale`,
and retries after 1, 2, 4, and 8 seconds; only the fifth consecutive transport failure writes that
attempt's reason to `agent-sync-error`, after which the next attempt waits the 60-second cadence. A
permanent failure (unusable credentials, a missing repository, a malformed answer, or missing forge
configuration) surfaces on the first attempt. The reason clears on the next successful read, and a
failed read names the forge, never GitHub, so a Gitea failure never claims a GitHub read. Opening
the page retries at
once: each open reads the forge through the shared dashboard reader when its interval allows and
asks the attached worker for its own read, shared across clients inside a five-second window, so a
recovery no longer waits out the 60-second interval; Start still reads immediately, and a stopped
worker is never started by a page yet its table still shows a closure. Filing stays blocked until a
read succeeds. A
GitHub rate limit (the `gh` text naming a primary or secondary limit, abuse detection, or HTTP
429) is a failed read like any other: it keeps the rows and blocks filing, and its reason stays in
the sync banner on the first answer without a retry. Because the operator's credential is shared
with every other process on the host and the limit clears itself, it never raises the
dashboard-wide error notification.

## Report, remove, or redesign a UI element

When the server has a Gitea address for harness-owned reporting, every page carries three UI issue
controls in the activity bar's application actions, beside commands, notifications, and theme:
`Report UI issue`, `Remove element`, and `Redesign element`. Without `DEVBOARD_GITEA_URL` they are
not rendered and their palette commands are disabled, so no page offers a filing control that
cannot work.
Each is a 28px icon control with an accessible name and `aria-pressed="true"` while its action is
armed; the outcome toast and its error stay out of element picking. `Esc` cancels a mode that is
not filing, and `app.report.cancel` cancels any active mode from the palette. While one request is
in flight every control is disabled and the active one is labelled `Filing the UI issue`, so one
click or one double-click files at most one issue.

`Report UI issue` enters element-selection mode: the element under the pointer is outlined, and a
click opens a report panel anchored beside it, without filing anything yet. The panel shows the
selected element's selector path; the report text is free-form. `File issue` posts the report and
the captured context to `POST /feedback`, the server files the issue through the configured
Gitea API, and the panel closes back into report selection mode so another
element can be picked without leaving and re-entering the mode. A successful filing shows a
`Report filed.` toast with an `Open issue` link to the created issue. `Esc`, the control again, or
`Cancel` leaves the mode, a failed report stays in the panel with its error, and a click in
selection mode never activates the element. The toast survives leaving the mode: a success
dismisses itself after eight seconds, a failure stays until dismissed or replaced.

The panel also answers questions. `Ask`, or `Enter` in the composer (`Shift+Enter` inserts a
newline), sends the typed question and the captured element context — route, URL, selector,
viewport, visible text, DOM excerpt, and capture time — over the existing WebSocket to a
background ACP agent started from `AGENT_COMMAND`. The agent runs in the host repository root,
and its answer streams into a compact transcript in the same panel as plain text, with preserved
line breaks and no Markdown interpretation. Every prompt tells it the conversation is `read-only`:
never edit files, run mutating commands, file issues, commit, or push. It also tells it to answer
in at most `three short sentences` and about 400 characters in plain text. That is a prompt-level
rule, not a sandbox.

One conversation exists `per selected element`, and only while its panel is open. Escape, `×`,
`Cancel`, a new pick, a successful filing, or a lost connection closes it: the server kills the
agent and the transcript is discarded. Reopening a panel starts a new conversation, selecting a
different element never resumes the previous one, nothing is written to `localStorage` or the
state directory, and a page reload loses it. While a turn is pending the composer and both action
buttons are disabled, `Ask` reads `Asking…`, and `Cancel` stays enabled. A failed start, an exited
agent, a prompt the agent never answered inside its deadline, or a rejected prompt shows the error
in the panel, keeps the question and earlier answers, and accepts the next question: the failed
turn's question returns to the composer, so `File issue`, `Ask`, and `Goal` are enabled again and
one click or one `Enter` re-asks it. `Ask` never calls `POST /feedback` and creates no issue.

Filing or proposing from a panel that has answered questions carries the visible Ask conversation
into the issue or draft as a `## Ask conversation` block between the request and
`## Captured UI context`, labelled `You:` and `Agent:` per turn. The conversation is bounded to 40
turns, 4000 characters per turn, and 12000 characters in total; when it exceeds that, the newest
whole turns are kept and the oldest dropped. Each turn's `role` is `DEVELOPER` or `AGENT`; any
other value is refused with HTTP 400. A panel without a conversation produces no block, and
a conversation is never resumed from storage.

`Goal` turns the composer text into a raw proposed goal instead of an issue. With non-whitespace
text it posts `report`, the Ask turns as `turns` when the panel has one, and the same captured
element context to `POST /goal-proposals`; the server writes one Markdown draft under
`<REPO_DIR>/.devboard/goal-proposals/` and answers `201` with the common hypertext control
object `{ "links": { "draft": { "href": "file:///…/.devboard/goal-proposals/<file>.md" } } }`,
carrying the draft's absolute URI, plus a `Location` header naming that same URI. An idempotent
replay answers the same `201` body and the same `Location`. The directory is deliberately separate
from the final goal specs in `.devboard/goals/`: a draft is unprocessed input, and this action
never writes a goal document, `GOAL.md`, or an ADR, never files an issue, and never runs `gh`.
The file name is chosen by one bounded naming turn: an ACP peer starts with
`AGENT_COMMAND --no-skills` in `REPO_DIR`, receives the operator report marked as data with a
read-only instruction, and must answer with only a lowercase kebab-case slug, at most six
hyphen-separated words, `[a-z0-9-]`, and at most 64 characters. A naming turn reads no skill, so
the flag also keeps OMP's background description compression from logging a warning the watchdog
files. A start failure, an exited peer, a question, a 15-second timeout, or an unusable answer
falls back to the report's first non-empty line, lowercased, with every run of
non-alphanumeric characters replaced by `-`, leading and trailing `-` removed, and at most six
hyphen-separated words, falling back to `ui-goal`; an existing name earns `-2`, `-3`, … through an
exclusive create, so the first draft is never overwritten. The body opens with
`# Proposed goal: <first line, whitespace collapsed, at most 200 characters>`, then the operator's
text verbatim, the `## Ask conversation` block when the panel has one, and the
`## Captured UI context` block an issue report carries. It carries no notice line or other prose
the operator did not write. A successful click closes the panel,
stays in report selection mode with an empty composer, and shows the
`Goal proposed: <repository-relative path>` toast as plain text with no link; a failed write keeps
the panel open with the server's error and leaves no draft. The drafts are ignored by git.

Both `POST /feedback` and `POST /goal-proposals` accept an `Idempotency-Key` header. The
server retains each key's result under `<STATE_DIR>/idempotency/` for 24 hours, so a retry with the
same key answers with the first issue or draft instead of creating a second resource, while a
failed attempt is never retained. A key is 1–255 characters with no control characters; an empty
or oversized key is refused with `400`.

Every request may carry an `X-Flow-ID` header so one call flow stays correlatable across the
dashboard, its journal, and the forge. The server reads it on every request, echoes the same value
on that request's response — including the `101` a `/ws` upgrade answers with, which carries it on
the upgrade's own headers because the upgrade assembles that response itself — forwards it on the
outbound Gitea issue request `POST /feedback` makes, and records it as the scope of the
`server-error` journal record a failed mutating request writes. A value is 1–200 printable ASCII
characters with no spaces or control characters;
surrounding whitespace is trimmed, and an empty, oversized, or non-printable value is refused with
`400` before any handler runs. A request without the header keeps today's behavior: no outbound
header, no echoed header, and an unchanged journal record.

`Remove element` and `Redesign element` are one-click shortcuts. Selecting one arms it and shows a
shortcut-specific hint; the next click on any element files the issue immediately, with no panel
and no text field. Filing does not use client-supplied report text. A successful filing shows a
`Removal issue filed.` or `Redesign issue filed.` toast with an `Open issue` link to the created
issue and keeps the mode armed, so the next element is one click away; a failure shows a
`Removal issue failed: <message>` or `Redesign issue failed: <message>` alert toast, creates no
issue, and keeps the mode armed with the controls re-enabled. A success toast dismisses itself
after eight seconds; a failure stays until dismissed or replaced. Either survives `Esc`, the
active control, or `app.report.cancel`, because leaving the mode is not a reason to hide whether
the issue was created. The active control, `Esc`, or `app.report.cancel` returns to idle.

Both shortcuts use a fixed title and body, so the implementation agent starts from the captured
context rather than operator prose. The title is `[ui] Remove element: <selector>` or
`[ui] Redesign element: <selector>`, with the selector's whitespace collapsed and the whole title
clamped to 200 characters; an empty selector leaves `[ui] Remove element`. A removal body starts
with `## Removal request` and the instruction `Remove the selected UI element from the
interface.`. A redesign body starts with `## Redesign request` and the instruction `Check the
selected UI element and redesign it because it does not look good. Use the project UI/UX skill
(devboard-ui-ux) and this repository's DESIGN.md and design/tokens.json as the normative design
system.` Both bodies end with the same `## Captured UI context` block: route, URL, selected
element, viewport, capture time, visible text, and DOM excerpt.

The report title is `[ui] ` plus the first line of the report, at most 200 characters; its body is
the verbatim report followed by the same captured context, so the ticket stays authoritative
without a model in the loop.

Every request carries an `action` of `REPORT`, `REMOVE`, or `REDESIGN`; an absent `action` means
`REPORT`, the only action that requires report text, and any other value — including a lower-case
spelling — is refused with HTTP 400 before the Gitea request. Both endpoints are strict about their
body: `POST /feedback` accepts `action`, `report`, `turns`, `route`, `url`, `selector`,
`dom_excerpt`, `visible_text`, `viewport`, and `captured_at`, `POST /goal-proposals` accepts the
same set without `action`, and any other top-level key is refused with HTTP 400 naming the first
unknown key before any Gitea request or draft write. A present `captured_at` must be an RFC 3339
date-time with upper-case `T` and `Z` separators, such as `2026-11-03T10:32:14.584Z`, and is
refused with HTTP 400 naming `captured_at` otherwise; an absent value stays optional, and an
accepted value is stored unchanged, so the filed issue or draft carries its upper-case `T` and `Z`.
Harness-owned reporting uses only the Gitea API: `DEVBOARD_GITEA_URL` names the instance,
`GITEA_TOKEN` (or `DEVBOARD_GITEA_TOKEN`) authenticates it, and `DEVBOARD_RELEASE_REPO` selects
the repository (default `dsdenes/devboard`),
whatever host project the interface is serving. Nothing is created in the host's own tracker, and
no `github.com` repository is used for filing. Starting the dashboard from the canonical
`.devboard` checkout resolves the HTTP origin itself when the `origin` remote is a Gitea SSH address
on this machine and neither variable is set: it probes the local listening ports for
`GET /api/v1/version` and uses the lowest matching loopback port. An explicit variable always wins,
an HTTP(S) origin needs no discovery, and an installed host never probes. Without a configured or
discovered origin the endpoint answers HTTP 503 naming `DEVBOARD_GITEA_URL` and performs no
request. A refused or failing request is reported in the filing toast and creates nothing. The
endpoint accepts only same-origin `POST` requests, bounds the body to 64 KB, and gives the request
60 seconds. A request whose method is not `POST` answers `405` with `Allow: POST` before the
disabled-reporting `503`, which therefore answers a `POST` only.

Every 4xx and 5xx response these routes answer is `application/problem+json` carrying `type`,
`title`, `status`, and `detail`, so a client reads one media type and one body shape. A successful
`POST /feedback` answers `201` with `title` and the `links.issue.href` hypertext control carrying
the filed issue's absolute URL, plus a `Location` header naming that same URL; no top-level `url`
property remains. An idempotent replay answers the same `201` body and the same `Location`.

`POST /feedback`, `POST /goal-proposals`, and the `/ws` upgrade require the dashboard token
before their handler runs. The request carries `Authorization: Bearer <token>`, which the server
compares with its own token in constant time; a missing or wrong credential answers `401` with
`WWW-Authenticate: Bearer`, and the request then files no issue, writes no draft, and never
upgrades the socket. `/ready` stays unauthenticated because the launcher probes it before it
holds a credential. The token comes from `DEVBOARD_DASHBOARD_TOKEN`, or is generated at startup
when that variable is unset and kept in the process environment so a replacement inherits it. The
page never reads the token in JavaScript: the `index.html` response sets the same value as an
`HttpOnly`, `SameSite=Strict` cookie, which the browser attaches to its own socket upgrade and
mutating fetches. A reverse proxy, a script, or a health probe that is not a page sends the
bearer header.

An unexpected exception in either mutating endpoint answers `500` with the fixed Problem JSON
detail "An internal error occurred.": `POST /feedback` and
`POST /goal-proposals` share that one fixed detail, record the exception text as a
`server-error` journal record prefixed with the endpoint, and never return the text to the
client.

A failed Gitea delivery answers `502` with the fixed Problem JSON detail "The issue could not be
filed.", and a delivery that runs past its bound answers `504` with the timeout detail. The
upstream error text, which names the Gitea request path and carries the first line of the
upstream response, reaches only the `server-error` journal record prefixed with the endpoint, so
no stack trace or other implementation internal is ever returned. A refused payload keeps its
own `400` detail.

## Container

Build the container from the `.devboard` context at the repository root:

```bash
docker build -t devboard-adr-ui .devboard
docker run --rm -d --name devboard-adr-ui -p 127.0.0.1:8080:8080 \
  -v "$PWD:/repo" devboard-adr-ui
```

The container reads `/repo/adrs` and listens on port `8080`. The repository mount is writable because agent runs write their worktrees, goal documents, and Discover artifacts into `/repo`; the dashboard itself writes no document by hand. Docker publishes the port on the host's loopback interface only. The container process binds `0.0.0.0` because Docker forwards published traffic to the container interface; the local-only access boundary is enforced by the `127.0.0.1` host publish.

## WebSocket contract

The client sends:

```json
{ "type": "listRecords" }
{ "type": "getGoal" }
{ "type": "getProject" }
{ "type": "getVersion" }
{ "type": "getMcpTools" }
{ "type": "getIssues" }
{ "type": "getIssuesRun", "runId": "2026-10-27T10-00-00-000Z" }
{ "type": "startIssues" }
{ "type": "pauseIssues" }
{ "type": "resumeIssues" }
{ "type": "stopIssues" }
{ "type": "checkIssues" }
{ "type": "answerIssues", "id": 7, "value": "all", "runId": "2026-10-27T10-00-02-000Z" }
{ "type": "closeIssue", "number": 240 }
{ "type": "getGoalDrafts" }
{ "type": "getGoalDraft", "path": ".devboard/goal-proposals/example.md" }
{ "type": "startGoalDraft", "path": ".devboard/goal-proposals/example.md" }
{ "type": "stopGoalDraft", "path": ".devboard/goal-proposals/example.md" }
{ "type": "deleteGoalDraft", "path": ".devboard/goal-proposals/example.md" }
{ "type": "answerGoalDraft", "path": ".devboard/goal-proposals/example.md", "id": 4, "value": "The whole goal" }

{ "type": "getAgents" }
{ "type": "getAgent", "id": "scout" }
{ "type": "refreshAgent", "id": "scout" }
{ "type": "startAgent", "id": "scout" }
{ "type": "stopAgent", "id": "scout" }
{ "type": "setAgentSettings", "id": "scout", "minutes": 1, "maxPerHour": 10, "maxPending": 5 }
{ "type": "disableAgentTimer", "id": "watchdog" }
{ "type": "restartServer" }
{ "type": "restartServer", "whenIdle": true }
{ "type": "startRun" }
{ "type": "startRun", "file": "0002-example.md" }
{ "type": "startLifecycle" }
{ "type": "pauseLifecycle" }
{ "type": "resumeLifecycle" }
{ "type": "reviseGoal", "request": "Tighten the goal" }
{ "type": "reviseGoal" }
{ "type": "createGoal" }
{ "type": "prepareSkills" }
{ "type": "getSkills" }
{ "type": "deleteSkill", "name": "test-strategy" }
{ "type": "resetImplementation" }
{ "type": "answer", "id": 1, "value": "Gamma" }
{ "type": "ask", "conversationId": "…", "question": "What does this label mean?", "context": { … } }
{ "type": "closeAsk", "conversationId": "…" }
{ "type": "getProviders" }
{ "type": "saveProvider", "requestId": 7, "id": "…", "provider": "opencode-go",
  "label": "Work", "key": "…" }
{ "type": "deleteProvider", "requestId": 8, "id": "…" }
{ "type": "setProviderEnabled", "requestId": 9, "id": "…", "enabled": false }
{ "type": "refreshProviders" }
```

- `getGoal` reads the goal document from disk and answers with its complete contents; an
  absent document answers with empty text, which shows `Create goal` and keeps the lifecycle
  start disabled.
- `getMcpTools` answers `mcpTools` with `tools`, the exact `tools/list` payload, and
  `invocations`, a map from tool name to how many `tools/call` requests named it for this
  repository. A tool that was never called is absent from the map and the page renders zero.
- `getProject` answers with the page heading label. `path` is `REPO_DIR` relative to the user's
  home directory when the repository lies inside it, and the absolute path otherwise.
- `getVersion` answers with `versionState`: `running` is the harness package version the
  backend loaded, `installed` is the version its prefix holds now, `latest` is the newest
  release an update check has seen, and `stale` is true only when `running` and `installed` are
  readable and differ. A dashboard that serves the canonical source checkout reads neither side
  from the checked-in manifest: it reports the newest release tag reachable from its `HEAD`, the
  same version a release created for that history, so an unpacked checkout never claims `0.1.0`
  and an unreleased commit on top never changes the number. A client that connects,
  and the page every few seconds, asks for it; a stale answer makes the reload control appear
  with both versions in its title.
- `getProviders` answers with `providersState`: every subscription with its masked key, status,
  quota windows, remaining fraction, last check time, and error; the current `selection` (or
  `null`), the refusal reason, and the fixed rule `rotates at 1% remaining`. `saveProvider`
  validates a new or changed key first: HTTP 401/403 answers `providerError` and changes nothing,
  while an unreachable endpoint or 5xx saves the subscription with status `unknown`. Editing a
  label without a key never revalidates. `deleteProvider` and `setProviderEnabled` persist the
  store without touching a running peer. `refreshProviders` bypasses the 60-second usage cache.
  Every save, delete, and enable carries a `requestId` the server echoes in a `providerChanged`
  acknowledgement sent before the mutation broadcasts a fresh `providersState`; a refusal answers
  `providerError` with the same `requestId`, and a change with no id is refused, so a client can
  always tell its own answer apart. A `providersState` never confirms a change: it also answers
  `getProviders`, `refreshProviders`, another client's mutation, and the periodic refresh. While
  at least one client is connected, the server forces a refresh and broadcasts a fresh
  `providersState` every 60 seconds; an idle server makes no provider call.
- `getIssues` answers with `issuesState`, the worker snapshot plus `present` and `attached`:
  lifecycle, enabled, paused, repository, poll times, queue entries from the dashboard's forge read
  with `labels` (and `handled: false`, `runId: null`, `agentRunId: null` because no worker state
  supplies a row), run summaries, the running `agents` (run id, issue number, startedAt, question,
  ACP child), the per-issue `cooldowns` map, errors, and the harness version the worker loaded. A missing state and no live lock answer `present: false`, `attached: false`, and
  `lifecycle: "stopped"`. A live worker from another harness version adds a non-blocking `notice`
  naming both versions. A connect also replays one `issuesActivity` with `replay: true` for every
  running agent; `getIssuesRun` answers `issuesRun` with one run's metadata and activity. The
  client never polls: state and activity arrive as events, so switching modes and reconnecting
  send no frame.
- `answerIssues` carries `{ runId, id, value }`; the answer reaches only the agent with that run
  id, and a missing or unknown run id is refused with an `error` that reaches no peer.
- `closeIssue` carries `{ number }` and closes that issue on the checkout's GitHub origin as
  `not planned` with a write-capable account. It answers `issuesClosed` with `{ number, ok }` and,
  on failure, the reason in `message`; a missing number answers `error`. A running agent is not
  interrupted, and the queue drops the issue on the worker's next poll.
- `getGoalDrafts` answers `issuesDrafts` with the sorted list of `{ path, name, heading }` and
  `runs`, the full per-path run snapshot (live runs plus finished runs whose draft still exists).
  `getGoalDraft` answers `issuesDraftDetail` with the draft's exact bytes, or `issuesDraftError`
  carrying `path` when the path is refused or missing. `startGoalDraft` starts one peer for its
  `path` and broadcasts that run's `issuesDraftState` and the list; starting a path that is
  already running is refused with `This draft is being elaborated.` and starts no peer.
  `stopGoalDraft` and `answerGoalDraft` carry the draft `path`; stop closes only that peer and
  records `stopped`, and an answer reaches only that path's pending question. Each run's activity
  is sent as its own `issuesDraftState` snapshot while its peer runs. `deleteGoalDraft` carries the
  draft `path`, removes the draft file and its recorded run, and broadcasts the shorter list to
  every client; a path whose elaboration is live or still closing is refused with `error` and
  `This draft is being elaborated. Stop the elaboration and delete it again.`, and a missing or
  refused path answers `error` with the refusal.

  lifecycle, enabled, paused, repository, poll times, queue, run summaries, active run, question,
  next attempt, errors, and the harness version the worker loaded. A missing state and no live
  lock answer `present: false`, `attached: false`, and `lifecycle: "stopped"`. A live worker from
  another harness version adds a non-blocking `notice` naming both versions. A connect also
  replays the active run's whole activity as one `issuesActivity` with `replay: true`;
  `getIssuesRun` answers `issuesRun` with one run's metadata and activity. The client never
  polls: state and activity arrive as events, so switching modes and reconnecting send no frame.
- `getAgents` answers `agentsState` with both shared snapshots, and `getAgent` answers
  `agentState` with one; a connect replays `agentsState` and Auto Scout's newest scan as
  `agentActivity` before any reply to the client's own commands. Every command carries `id`;
  an unknown id is refused with an error naming it and spawns nothing. `refreshAgent` is the
  page-open read: it asks the shared dashboard reader for one fresh forge read when the
  60-second interval allows and answers `agentState`; an attached Auto Scout worker is also
  asked for its own read, shared across clients inside five seconds. A stopped worker is left
  stopped, takes no lock, and receives no command, while the dashboard read still refreshes
  its table. `startAgent` runs the
  agent's preflight and spawns or attaches; `stopAgent` writes one stop command and persists
  `enabled: false`; `setAgentSettings` accepts `{ minutes, maxPerHour, maxPending }`, requires
  `minutes` from 1 through 1440 and each limit empty or 1–100, and writes `settings.json` once;
  `disableAgentTimer` runs the legacy `systemctl --user disable --now` only for the Watchdog
  descriptor. A changed snapshot is pushed to every connected dashboard within the bridge poll,
  so a lifecycle, cadence, limit, issue row, or state change appears without a reload. There is no
  `approveScout`, `draftScoutGoal`, or `rejectScout`.
- `restartServer` broadcasts `serverRestarting`, then hands the process to its launcher, which
  stops the listener, starts the installed harness package, and exits. It is refused with an
  `error` when no launcher is configured or while a restart is already in progress. A client
  that clicked the reload control waits for the replacement to answer and reloads the page even
  if the acknowledgement was lost when the old process exited. With `"whenIdle": true`, a
  dashboard with active work answers `upgradePending` instead and restarts itself as soon as
  that work ends; an idle dashboard restarts immediately.
- `getGoal` is the only goal-document read; no client command writes `GOAL.md` or a Flow
  document. The creation and revision agents and the Flow goal interview write their own files.
- `startRun` without `file` starts the sequence with the lowest-numbered pending record.
- `startRun` with `file` starts that record first only when it is pending; the sequence then
  continues with the lowest-numbered remaining pending records.
- Every accepted start resolves one record at a time until no pending record remains or a run
  ends without resolving its record. A still-pending or removed active record ends the
  sequence.
- A manual start is accepted while a lifecycle run is active. When the lifecycle is advancing,
  the server first pauses it at its interrupted stage and then starts the sequence; a start that
  cannot run leaves the lifecycle advancing. While the lifecycle is paused, the manual sequence
  runs beside the suspended lifecycle lanes, which keep their tabs, activity, and questions.
  Resolving the record the lifecycle itself has in progress is refused. When the sequence ends
  the lanes stay paused, with their tabs intact, until the lifecycle is resumed. `runStarted` events for a manual record carry `"manual": true`, and a client that
  connects during the sequence receives that conversation.
- A start is refused with an `error` event while another manual sequence is running (including
  between records), while a goal revision, goal creation, or skills preparation is active, when
  no record is pending, or when the named record is not pending.
- `answer` supplies one value for the pending elicitation; the question is cleared after the first answer.
- `ask` sends one question and the captured element context for a conversation id. The first turn
  starts one ACP peer from `AGENT_COMMAND` in `REPO_DIR`; a follow-up reuses that peer and session,
  and a replacement peer receives the earlier turns. Only the asking socket receives the
  conversation's `askChunk`, `askDone`, and `askError` events, each carrying its conversation id.
  A question must be 1–4000 trimmed characters with a present, bounded context, one turn runs at a
  time per conversation, and events for a closed conversation are dropped. `closeAsk` closes the
  conversation and kills its peer; closing the socket closes every conversation it owned. See
  Report, remove, or redesign a UI element.
- `reviseGoal` starts a guided goal revision with one ACP peer. The dashboard sends no guidance; a `request` from tooling is optional free-form guidance passed to the agent, and without it the agent establishes the direction through its interview questions. The agent writes the goal document itself. Activity and questions use the existing `activity` and `question` events, and `answer` replies to a revision question exactly as it does to a run question. It is accepted while the lifecycle is paused, where the suspended lanes keep their tabs.
- A revision is refused with an `error` event while the lifecycle is advancing, a run or run
  sequence is active, a manual ADR sequence is active, or another revision is active. While a revision is active, `startRun`, `startLifecycle`, `resumeLifecycle`, and another `reviseGoal` are each refused with an `error`, and no agent is spawned.
- `createGoal` starts the guided goal creation with one ACP peer whose prompt is exactly
  `/goal-outcome`, the installed skill command that reads the harness prompt and interviews the
  developer. The server accepts it in every state: it replaces a goal document that already has
  content, and it preempts an in-flight creation or revision and stops an advancing ADR run,
  manual ADR sequence, or lifecycle before the new peer starts. It reads
  `<REPO_DIR>/GOAL.md` before and after the peer, while `getGoal` keeps using `GOAL_FILE`. It is accepted while a lifecycle run is paused, where the suspended lanes keep
  their tabs, and it stops a manual sequence running beside those lanes. Activity and
  questions use the existing `activity` and `question` events, and `answer` replies to a creation question
  exactly as it does to a revision question; a second answer for the same question id is refused
  with an `error`. When the peer ends, the server reads `<REPO_DIR>/GOAL.md` again: text that
  contains at least one non-whitespace character completes the creation, while an absent, empty,
  or whitespace-only document is a failure that sends an `error` followed by a failed
  `goalCreationStopped`.
- A creation is refused with an `error` event, without spawning a peer, only when
  `<REPO_DIR>/GOAL.md` exists but cannot be read. Otherwise a `createGoal` request always wins:
  the server cancels the active creation or revision, reports it stopped with `completed: false`,
  stops an advancing run or lifecycle and reports the idle `goal` stage, then starts the new peer.
  While a creation is active, `startRun`, `startLifecycle`, `resumeLifecycle`, and `reviseGoal`
  are each refused with an `error`, and no agent is spawned; a second `createGoal` restarts the
  creation instead. The creation runs in the server, so closing the browser does not stop it, and
  a client that connects during it receives `goalCreationStarted`, the recorded activity, and the
  pending question before its own command replies.
- `prepareSkills` starts one ACP peer whose prompt is exactly `/prepare-skills`, the installed
  command that reads `.devboard/prompts/prepare-skills.md`. The server accepts it only while
  `<REPO_DIR>/GOAL.md` contains at least one non-whitespace character and no run, run sequence,
  lifecycle run (paused or advancing), goal creation, goal revision, or other preparation is
  active; otherwise it answers with an `error` and spawns no peer. The server snapshots
  `<REPO_DIR>/.omp/skills/`, deletes every skill carrying `metadata.devboard-managed: "true"`,
  and broadcasts `skillsPreparationStarted`. Activity and questions use the existing `activity`
  and `question` events, and `answer` replies to a preparation question like any other. When the
  peer exits, the server validates the managed set, compares every installed skill for
  incompatible directives, and checks that no unmanaged skill changed; success broadcasts
  `skillsPreparationStopped` with `completed: true`, the skill list, and an empty contradiction
  list, while any failure broadcasts an `error`, restores the snapshot, and broadcasts the same
  event with `completed: false`. `getSkills` answers with the current managed set read from disk
  and sends `skillsState`; the client issues it on every connection, so the panel is rebuilt after
  a reload or restart instead of starting a run. While preparation is active, `startRun`,
  `startLifecycle`, `resumeLifecycle`, `reviseGoal`, `createGoal`, and a second
  `prepareSkills` are each refused with an `error` and spawn no peer. `deleteSkill` (with `name`)
  removes exactly one installed managed skill of the prepare family from `<REPO_DIR>/.omp/skills/`,
  is accepted only while that directory is installed and no run, lifecycle, goal creation,
  revision, or preparation is active, and answers by broadcasting a fresh `skillsState`; it
  refuses an unmanaged skill, a Discover-family skill, and a name that is not in the managed set.
- `resetImplementation` deletes and commits the implementation as described above. The configured
  state directory is not implementation: when `STATE_DIR` resolves inside `REPO_DIR`, its bytes
  survive untouched, its path is added to `.git/info/exclude`, and `git rm --cached` removes it
  from the staged tree, so the commit carries no path under it and `git status --porcelain` stays
  empty. A `STATE_DIR` equal to `REPO_DIR` is refused with an `error` before anything is deleted or
  stopped. The server
  broadcasts `implementationResetStarted` when it accepts the command, performs the reset
  itself, and broadcasts `implementationResetStopped` with `completed: true` and the 40-hex
  `commit` only after `git push origin main` succeeds; a failed push includes the local commit
  with `completed: false`, and a failure before or during the commit omits `commit`. Every
  failure is preceded by one `error` carrying git's stderr where git failed. Every git invocation
  the reset runs is bounded by `gitTimeoutMs` (60 seconds by default); an invocation past that
  deadline is killed, reports `error` with `git <verb> timed out after <ms>ms`, and settles the
  reset with `completed: false`, so a stalled push never keeps the reset guard active. While a reset
  runs, `startRun`, `startLifecycle`, `pauseLifecycle`, `resumeLifecycle`,
  `reviseGoal`, `createGoal`, `prepareSkills`, `answer`, and a second `resetImplementation`
  are each refused with an `error`; `listRecords`, `getGoal`, `getProject`, `getIssues`, `getIssuesRun`,
  and `getSkills` still answer. A client that connects during a reset receives `implementationResetStarted` before its own
  command replies. On success the server follows the stopped event, in order, with
  `lifecycleState` at `goal` with pass `1`, `work: null`, and `paused: false`, `records` with
  an empty list and `next: null`, and `goal` with the unchanged text (empty when the document
  is absent).
- `startLifecycle` starts the backend-owned parallel pipeline. It is refused with an `error`
  while a run, a run sequence, a manual ADR sequence, a goal revision, a goal creation, or
  another lifecycle run is active; when the goal document is absent, unreadable, or contains only
  whitespace; when `<REPO_DIR>/.omp/skills/` cannot be read; and when no managed skill is
  installed there. A refused start spawns no agent and reports no `lifecycleState`. An accepted
  start reports `lifecycleState` at `epic` with `work: null`, the pass already held, and
  `paused: false` before its first tracker query and before any agent starts. While the lifecycle
  run is active, `startLifecycle` is also refused. A tracker read is bounded by
  `trackerTimeoutMs` (30 seconds by default); a read past that deadline kills every tracker
  child, reports an `error` naming the deadline, and returns the run to the idle `goal` stage, so
  the next Start is accepted instead of waiting on the unfinished one. An answer that arrives
  after a stop or reset is ignored and changes no lane or stage. `startRun` is accepted and
  pauses every lane as described above, and the lifecycle resumes when the manual sequence ends.
  `reviseGoal` is refused only while the lifecycle is advancing.
- `stopLifecycle` ends an active run for real. It closes every live lane peer, aborts an
  in-flight tracker read so the start unwinds at once, reports the idle
  `lifecycleState` at `goal` with `work: null`, `paused: false`, and the pass already reached,
  and publishes a lane snapshot with every stopped lane `failed` and `runningLanes: 0`. It
  leaves nothing suspended. It is refused with an `error` when no lifecycle run is active. A
  stopped run's loop finishes unwinding before a later `startLifecycle` is accepted, so the two
  runs never publish concurrently.
- The accepted run reads every open epic and starts one implementation lane per epic at once,
  with no fixed cap. Each lane sends `/implement-next-epic <ref>` to its own ACP peer; a lane
  never selects a different epic. If no epic is open, the run sends one `/epic-next` peer.
  Generation is zero-or-more: it may file several pairwise-independent epics in one pass, and
  every epic it files starts its own lane immediately. Closing an epic increments `pass`, marks
  that lane `closed`, and requests a generation pass immediately, even while other lanes keep
  implementing; a request during an active pass coalesces into at most one follow-up, and two
  generation peers never run at once.
- A lane that ends with its epic still open is marked `retrying` and its lane sends an `error`;
  it is retried after a five-second backoff and immediately when `main` advances. A lane whose
  peer prints a line beginning `DEVBOARD-BLOCKED:` is `parked`; it is retried only when `main`
  advances. Neither state ever creates a second concurrent lane for the same epic, and neither
  stops the other lanes. With no lane active, a generation pass that files
  nothing, and only parked epics remaining, the run sends an `error` naming every parked epic,
  reports the idle `goal` stage, and leaves those epics open; a new run clears the parked set.
- When no epic remains, a generation pass files nothing, and no ADR is still pending, the
  lifecycle resolves each pending record in ascending file-name order and then reports
  `finished`. A pass that leaves the same pending record set as the previous one without an epic
  sends an `error` and stops. Every stop before `finished` reports the idle `goal` stage with
  `work: null`, `paused: false`, and the pass reached. A tracker or record read failure also
  stops the run. A forge can expose a peer's tracker write a moment after the peer exits, so the
  server re-reads the tracker for a bounded settle window per lane before trusting an answer that
  still shows the pre-peer state; pause holds the loop between reads, and an exhausted window
  accepts the last answer.
- `pauseLifecycle` suspends every running lane with `SIGSTOP`, marks each lane `paused`, and holds
  the scheduler before the next peer start or stage transition. It reports `lifecycleState` with
  the interrupted `stage`, `pass`, and `work` and `paused: true`, then a lane snapshot with
  `runningLanes: 0`; a pause during the first lookup reports `epic` with `work: null`. No tracker
  result use, stage transition, retry, or new ACP peer happens until a resume. Pending lane
  questions stay in their tabs, and `answer` is accepted and buffered for the suspended child.
  Selecting a manual ADR start while the lifecycle advances pauses every lane the same way and
  resumes it once the sequence ends. An explicit pause command stays suspended until
  `resumeLifecycle`; the interface's single lifecycle button offers only start and stop, not
  pause.
- `resumeLifecycle` reports the same `stage`, `pass`, and `work` with `paused: false`, continues
  every suspended lane with `SIGCONT`, and releases the held loop. It is refused while a goal
  revision or a manual ADR sequence is active, leaving the lifecycle paused until that peer ends.
  Pause and resume are each refused with an `error` when no lifecycle run is active, when pausing
  an already-paused run, and when resuming a run that is not paused. The paused flag is part of
  the durable state, so a run paused before a restart stays paused and spawns no peer until
  `resumeLifecycle`; it is discarded when the run ends.
- Each lifecycle lane is one `omp acp` process. `runStarted`, `activity`, `question`, and
  `runStopped` for a lane carry its `lane` id; lanes also report their epic or record identity,
  attempt number, status, recorded activity, and pending question in `laneState`. Untagged
  `runStarted`, `activity`, `question`, and `runStopped` events remain the foreground run,
  revision, creation, and skills preparation. Lifecycle state is durable: the lifecycle, its
  pass, every lane tab with its activity and question, and the epic bookkeeping are written to
  the harness state directory keyed by `REPO_DIR` and restored when the backend starts. A client
  that connects while no run is active receives the idle `goal` state when the retained pass is
  above 1.

The server answers with events:

```json
{ "type": "lifecycleState", "stage": "epic", "pass": 1, "work": null, "paused": false }
{ "type": "lifecycleState", "stage": "adr", "pass": 1, "work": { "kind": "adr", "id": "0002-example.md" }, "paused": false }
{ "type": "lifecycleState", "stage": "implementation", "pass": 1, "work": { "kind": "epic", "id": "42", "url": "https://github.com/owner/repo/issues/42" }, "paused": false }
{ "type": "lifecycleState", "stage": "implementation", "pass": 1, "work": { "kind": "epic", "id": "42", "url": "https://github.com/owner/repo/issues/42" }, "paused": true }
{ "type": "lifecycleState", "stage": "epic", "pass": 2, "work": null, "paused": false }
{ "type": "lifecycleState", "stage": "goal", "pass": 2, "work": null, "paused": false }
{ "type": "laneState", "openEpics": 3, "runningLanes": 3, "lanes": [ { "id": "lane-2", "kind": "implementation", "epic": { "number": 42, "title": "Add export", "url": "https://github.com/owner/repo/issues/42" }, "record": null, "attempt": 1, "status": "running", "activity": [ "Working on epic 42" ], "question": null }, { "id": "lane-3", "kind": "adr", "epic": null, "record": { "file": "0002-example.md", "title": "Choose a runtime" }, "attempt": 1, "status": "paused", "activity": [ "Inspecting 0002-example.md" ], "question": { "id": 1, "message": "Choose an answer", "options": [] } } ] }
{ "type": "runStarted", "lane": "lane-2", "kind": "implementation", "attempt": 1, "file": "", "title": "Add export", "action": "implementing" }
{ "type": "activity", "lane": "lane-2", "text": "Working on epic 42" }
{ "type": "question", "lane": "lane-2", "id": 1, "message": "Choose an answer", "options": [] }
{ "type": "runStopped", "lane": "lane-2", "file": "", "title": "Add export", "resolved": true, "status": "closed" }
{ "type": "records", "records": [ { "file": "0001-example.md", "title": "Example", "status": "Accepted", "pending": false, "summary": "Use the simplest runtime." } ], "next": null }
{ "type": "project", "path": "projects/devboard" }
{ "type": "versionState", "running": "0.1.200", "installed": "0.1.201", "latest": "0.1.201", "stale": true }
{ "type": "serverRestarting" }
{ "type": "upgradePending" }
{ "type": "goal", "text": "# Goal\n\nThe complete goal text." }
{ "type": "goalRevisionStarted" }
{ "type": "goalRevisionStopped", "completed": true, "text": "# Revised goal\n\nThe agent rewrote this." }
{ "type": "goalRevisionStopped", "completed": false }
{ "type": "goalCreationStarted" }
{ "type": "goalCreationStopped", "completed": true, "text": "# Created goal\n\nThe agent wrote this." }
{ "type": "goalCreationStopped", "completed": false }
{ "type": "skillsPreparationStarted" }
{ "type": "skillsPreparationStopped", "completed": true, "skills": [ { "name": "dependency-direction", "description": "Choose dependency direction." } ], "contradictions": [] }
{ "type": "skillsPreparationStopped", "completed": false }
{ "type": "skillsState", "skills": [], "contradictions": [] }
{ "type": "implementationResetStarted" }
{ "type": "implementationResetStopped", "completed": true, "commit": "0123456789abcdef0123456789abcdef01234567" }
{ "type": "implementationResetStopped", "completed": false, "commit": "0123456789abcdef0123456789abcdef01234567" }
{ "type": "implementationResetStopped", "completed": false }
{ "type": "runStarted", "file": "0001-example.md", "title": "Example", "action": "resolving" }
{ "type": "runStarted", "file": "", "title": "Improve watch mode", "action": "implementing" }
{ "type": "runStarted", "file": "", "title": "Epic generation", "action": "generating" }
{ "type": "runStarted", "file": "0002-example.md", "title": "Manual example", "action": "resolving", "manual": true }
{ "type": "activity", "text": "Inspecting 0001-example.md" }
{ "type": "activity", "text": " and its status line", "append": true }
{
  "type": "question",
  "id": 1,
  "message": "Choose an answer",
  "options": [
    { "label": "Alpha", "description": "Alpha leads to the first outcome.", "recommended": true },
    { "label": "Beta", "description": "Beta leads to the second outcome.", "recommended": false }
  ]
}
{ "type": "runStopped", "file": "0001-example.md", "title": "Example", "resolved": true, "status": "Accepted" }
{ "type": "error", "message": "No pending ADRs to start." }
```

- A `records` event carries every record in file-name order. `summary` is the first paragraph
  of the record's `Decision` section, shortened at a word boundary; it is empty when the record
  has no such section. `next` names the lowest-numbered pending record, or null.
- `runStarted` carries `action`: `resolving` for an ADR peer, `implementing` when the lifecycle
  peer implements an epic, and `generating` when it creates one. The client labels the run from
  it, so an implementation is never described as a resolution.
- `activity` events carry one line of the agent's output. An event with `"append": true`
  continues the previous line: the client appends `text` to it instead of starting a new one.
  Streamed ACP text updates are deltas of one assistant message (identified by its
  `messageId`) and are joined this way, so the developer reads whole messages rather than
  chunks; a different message id, a change from thought to reply, a tool call, or a plan
  starts a new line. The server stores the joined lines, so a client that connects during a
  run receives each line once, without the `append` flag. Text updates that carry no message
  id are complete lines and always start a new one. The interface renders the last line as the
  current action and lists earlier lines under a collapsed history.
- A manual record `runStarted` carries `"manual": true`; a lifecycle stage's event omits the
  field. The flag lets the client keep its start controls disabled for the manual sequence while
  a paused lifecycle remains resumable. A client that connects during a manual sequence receives
  that `runStarted`, the recorded activity, and the pending question, ahead of the suspended
  lifecycle conversation.
- A `question` event carries one option per choice. Each option has a `label`, an optional
  `description` stating the consequence of choosing it, and `recommended`, true for the answer
  the agent suggests. When the peer's schema marks none, the server marks the first option as
  recommended, so a choice list never lacks a suggestion. `answer` names the selected label as
  `value`.
- A record's title and status come from its YAML frontmatter `title` and `status` fields.
- A record is pending exactly when its status is `draft` or `proposed`; every other status is
  resolved.
- Records are ordered by file name, and `next` is the first pending record in that order (the lowest-numbered pending file).
- `lifecycleState` reports `stage` (`goal`, `epic`, `adr`, `implementation`, or `finished`),
  the `pass` number, `work` (`null`, an ADR filename, or an epic issue number), and `paused`.
  An epic `work` also carries the issue's `url` from the tracker when the origin reported one,
  which the page renders as a link. A `lifecycleState` is sent when a lifecycle run is accepted,
  on every transition and pause change, and to
  each client that connects or reconnects before any other event, ahead of that client's own
  command replies: while a lifecycle run is active, the current state; when no run is active
  and a state has been reported, the last reported state, including `finished` with its final
  pass or the idle `goal` state of an aborted run with the pass it reached. An accepted run
  is reported at `epic` with `work: null` before the origin-tracker query, and an open epic
  follows as a transition to `implementation`. A client that connects while paused receives
  `paused: true`, followed by the lane snapshot with every lane's recorded activity and pending
  question. Stage `goal` is the idle state before a lifecycle run starts and after one
  stops before `finished`; a backend on which no lifecycle run has ever started sends no
  `lifecycleState` on connection. The retained state is durable, so a replacement process
  replays the same `lifecycleState`, lanes, activity, questions, and pass.
- `goalRevisionStarted` marks the beginning of a revision. `goalRevisionStopped` marks its end: `completed` is `true` only when the peer ended without error and the goal file could be read, in which case `text` carries the complete file contents. A failed revision has `completed: false`, omits `text`, and is accompanied by an `error` event.
- A revision emits no `runStarted` or `runStopped` events of its own and does not read or write `adrs/`. When it ends while a lifecycle run is paused, the suspended lane tabs stay as they were; the server does not replay them because they were never removed.
- `goalCreationStarted` marks the beginning of a guided goal creation. `goalCreationStopped`
  marks its end: `completed` is `true` only when the peer ended without error and
  `<REPO_DIR>/GOAL.md` could be read with at least one non-whitespace character, in which case
  `text` carries the complete file contents. A failed creation has `completed: false`, omits
  `text`, and is accompanied by an `error` event; that includes a peer that ends with an absent,
  empty, or whitespace-only goal document. A creation emits no `runStarted` or `runStopped`
  events and does not read or write `adrs/`. When it ends while a lifecycle run is paused, the
  suspended lane tabs stay as they were. A client that connects or reconnects during a creation
  receives `goalCreationStarted`, every recorded `activity` line, and the pending `question` if
  one exists, before any other event beyond the lifecycle state and lane snapshot.
- A client that connects or reconnects during a revision receives `goalRevisionStarted`, every `activity` line recorded so far, and the pending `question` if one exists, before any other event beyond the lifecycle state and lane snapshot.
- `skillsPreparationStarted` marks the beginning of a skills preparation, and
  `skillsPreparationStopped` marks its end. Success is `completed: true` with `skills` (each
  entry carries `name` and `description`, and nothing else) and `contradictions: []`; failure is
  `completed: false` without either field, and follows an `error`. A run that ends with no
  managed skill is a failure, like every other validation failure. A failed run restores
  `<REPO_DIR>/.omp/skills/` to its pre-run bytes, so the panel and the disk still show the
  previous managed set. Preparation emits no `runStarted`, `runStopped`, or `records` events and
  does not read or write `adrs/`. `skillsState` reports the managed skills read from disk and
  the current contradiction list; `getSkills` requests it, and a client that connects or
  reconnects during preparation first receives `skillsPreparationStarted`, every recorded
  `activity` line, and the pending `question` if one exists. The panel lists managed skills only
  and shows a contradiction list only when the review found one; the review itself covers every
  skill directory, managed or not.
- The server reads ADR files and never writes them; the agent changes the status line. The server reads the tracker and never writes issues. The goal document is written by the revision and creation agents, and the server reads it to answer `getGoal` and to report `goalRevisionStopped` or `goalCreationStopped`; a creation always writes `<REPO_DIR>/GOAL.md` even when `GOAL_FILE` names another file. No browser command writes a goal, Flow, or skill document.
- Skills preparation writes only under `<REPO_DIR>/.omp/skills/` and only through its ACP peer;
  the server deletes managed skill directories before the run and restores the snapshot after a
  failure. `runStopped` reports whether the active record is now resolved; a `records` event
  follows each `runStopped` before the next `runStarted`. One foreground agent — a run, manual
  sequence, goal revision, goal creation, or skills preparation — works at a time, in server
  memory, beside any number of lifecycle lanes. A paused lifecycle's suspended lanes coexist
  with a manual sequence or revision, and resume waits until that peer ends. Stopping the server terminates its child
  process and the loop.

## Tests

```bash
cd .devboard
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p devboard-contract          # the whole contract corpus
cargo run -p devboard-shadow -- --report ../shadow-report.json --window 1800 --iterations 100
bun run verify:dead-code
```

The shadow router sends every mutating command to the TypeScript server once, then replays that
command's recorded TypeScript answer, state tree, and repository tree against fresh Rust instances
until the write reaches the comparison target. Reads are mirrored live against the untouched
baseline. `--typescript <dir>` names the pre-cutover checkout that still supplies
`contract/serve-typescript.ts` and `server/fixtures/stub-agent.ts`; it defaults to the harness root.
`bench/shadow-report.json` is the last full 100-comparison soak.

`verify:interface` drives the IDE shell against a seeded fixture host in headless Chrome and
writes its screenshots under `.tmp/interface`. The other `verify:` scripts build fixture releases
under `.devboard/.tmp`, install them into throwaway hosts, and assert the launcher, update, and
reload contracts end to end. They never touch a real host. `verify:source-refresh` starts real
source dashboards against a throwaway source checkout, delivers a request through the same writer
`publish` uses, and proves the replacement, the digest check, the applied-request dedupe, the
failure and never-ready paths, the fixed retry interval, and the two-dashboard delivery without
running a release or `bun run publish`.

`bun run verify:issues` is the deterministic end-to-end gate. It starts a source dashboard
against a throwaway checkout with stub `gh` and ACP commands, starts the worker, and proves four
simultaneous peers started in one poll with exact distinct prompts, per-agent run directories and
activity files, per-agent questions answered by run id, an issue opened mid-run, one issue's
cooldown leaving the others running, Check now retrying the gated issue, pause draining every peer,
Stop closing every peer without a cooldown, connect-time replay of every agent, server-restart
reattachment, per-repository isolation, same-repository attach, refusal with another `STATE_DIR`,
legacy-lock refusal, that no `/implement-all-issues` prompt is ever sent, and that no systemd unit
or timer is written and no `systemctl`/`loginctl` stub is invoked. It writes only under
`.devboard/.tmp`.
`bun run verify:scout` drives the built dashboard in headless Chrome against a fixture checkout,
a stub ACP peer, and a stub `gh`: Start files significant items with no click, a duplicate and a
score below 4 are dropped and named in the activity, the issue table shows the title anchor, the
creation time, the category, the state, and the shipped version, both limits save and survive a
reload, an invalid save shows its error and sends nothing, a close flips the row to implemented,
a release published later fills its blank version, a failed read shows `error` with its reason
and the last success time while keeping the rows, no review widget or command remains, and Stop
leaves the table and a released lock. Its entry-point section names the path and seed recorded in
the scan request, replays the seed, and proves the activity names both. It writes only under
`.devboard/.tmp`.
`bun run verify:dead-code` runs the real detached Dead Code worker against a fixture checkout, a
stub ACP peer, and a stub `gh`: one cycle records its seeded entry point and seed in the request
and activity, files exactly one `dead-code` issue with its detection category, evidence path, and
acceptance criteria, and replays the recorded seed to the same entry point. It writes only under
`.devboard/.tmp`.
`bun run verify:agents` builds the client, seeds all five agents, and drives headless Chrome
through the Background agents section of the Devboard sidebar, the Dead Code entry and page with
its 60-minute, 10-per-hour, and 5-open defaults, the identical core test ids on every
page, Start -> starting -> running and Stop -> stopping -> stopped, cadence and limit validation
and persistence, the Watchdog cap, the shared table columns, freshness without a reload, no
mutating command on reload, the timer-blocked state and one-click disable against a stub
`systemctl`, and the footer indicator with no console error. It also proves MCP optimizer's
shared cycle detail and persisted settings, and the read-only prompt section: every page renders
`agent-prompt` directly after `agent-header`, closed on load; Auto Scout, Design System, and Dead
Code show complete prompt bytes in `agent-prompt-text`; Watchdog shows `agent-prompt-absent`; MCP
optimizer shows the one read-only `agent-prompt-template` with the fixed intro, every heading and
rule line, the three placeholders, every catalog tool name, the seeded allowlist, and the
fixture's two MCP optimizer issues but not its unrelated issue; no page renders an editor, Save,
or chat test id and no prompt carries a source-only marker; an installed fixture and a
source-checkout fixture render the same bytes and template and both refuse the removed save as an
unknown command, leaving `.devboard/prompts`
byte-identical; editing MCP optimizer's settings file and reconnecting shows the new allowlist.

`server/scout.test.ts` covers recommendation identity and the body's `## Category`, result
validation (over-count, malformed item, multi-line title, path escape, excluded tree, duplicate
id, out-of-range span, uncited file, shortfall, missing score, out-of-range score, missing
reason), the version-2 request, the shipped-version rules (earliest release, tie by tag,
timeline commit, newest comment SHA, open issue, no release), settings and state migration,
the bridge's limits and absent decision path, the Stop/limits command surface, the Start preflight
refusals, a stalled preflight failing at its deadline and the next Start retrying, and the activity
delta.
`tests/scout.test.ts` covers filing without a command, the significance score and issue body,
duplicates against closed issues, open issues, and drafts, both caps across a restart, the
effective batch, zero capacity, a close freeing a slot, limits applying live and surviving a
restart, state mapping and a reopen, a later release filling a blank version, a failed periodic
read, a periodic read that never settles failing at its deadline and releasing the worker, the
default client's bounded `gh` calls, a failed pre-filing read, migration from a version-1 board, a
missing score failing the scan atomically, a failed filing, Stop keeping the rows, the live lock,
a replacement closing an interrupted scan, bridge replay without a spawn, another `STATE_DIR`
refused, a harness-version notice, the issue body and label creation, and the scan prompt's rubric.
`tests/issues.test.ts` covers the fleet (four mixed issues, the thirty-peer cap with a queued peer
starting when one finishes, duplicate prevention, an issue opened mid-run, per-issue success and
ledger entries, one failure cooling only its issue), Check now clearing every cooldown, pause
draining every peer, Stop closing every peer without a cooldown, per-agent questions and answer
routing, two orphan children on a fresh start, version 1 state loading, reopened-issue eligibility,
history pruning that keeps every running directory, preflight for both wrappers, a stalled
permission probe and the killed `gh` child failing at the preflight deadline, repo-scoped state
and lock isolation, atomic and damaged state, ledger migration, the activity bounds, and the
conditional tracker. `tests/cleanup.test.ts` proves the watchdog preserves repo-scoped issues state,
the repo-anchored lock, Auto Scout settings and state, and Flow session records that Flow restore
still reads, while sweeping legacy orchestrator run files and stale scan archives. Every fixture stays under `.devboard/.tmp`.
`tests/launcher.test.ts` covers the single public package: the manifest, the help output, the
tarball's required and forbidden paths, the fallback asset name, and template identity. `lib/inventory.test.ts` covers the publish report. `lib/release.test.ts`
covers installing a release when the process working directory has been deleted.
`server/updates.test.ts` covers the startup check, the interval, backoff, single-flight, and
failure journaling.
`tests/install.test.ts` covers the wrapper script: a fresh install, an idempotent rerun that
keeps unrelated files, a host without `.devboard/`, a differing file refused without `--force`,
`--force` replacing it, and the default host path. `server/run.test.ts` drives the interface
against the stub ACP agent, covering sequential
resolution in file-name order, selected first records, refusal of a second start during a run
and between runs, activity and question/answer relay, the unresolved-record stop, the
removed-record stop, disconnect continuation, records refresh, and an idle restart deferred
until the active run ends. `server/app.test.ts`
covers `getGoal`, the read error, the goal prompt payload without an `editable` field, and the
absence of agent startup. `server/goal-revision.test.ts` covers guided goal revision: request and
no-request starts, activity and question relay, the rewritten goal reported verbatim, refusal
during lifecycle and record runs (including between records), refusals during a revision,
reconnect replay, the unreadable-goal failure, and the absence of run events or ADR writes.
`server/goal-creation.test.ts` covers guided goal creation: the `/goal-outcome` prompt, no
spawn on connect, activity and question relay, the created goal reported verbatim from
`<REPO_DIR>/GOAL.md`, the unreadable goal before and after the peer, an absent goal answered as
empty, an empty or whitespace-only result reported as a failed creation that leaves the
document unchanged and creation available, every refusal, the
single-agent refusals while creating, reconnect replay before the late client's own replies,
acceptance while the lifecycle is paused with the paused lane tabs retained, completion without
reading or writing `adrs/`, and the custom `GOAL_FILE` split.
`server/lifecycle.test.ts` covers the `lifecycleState` sequence, the running `epic` state
reported before the first tracker lookup and to every client, a start whose tracker read
exceeds its configured deadline reporting an `error` and the idle `goal` stage while the next
start reaches the loop, a tracker answer that arrives after a stop changing no lane or stage
and not blocking the next start, stopping a running lifecycle and
its in-flight lanes with the idle state that follows, the single `/epic-next`
peer, ADR-order resolution, implementation of an already-open epic, return to epic generation
on the next pass, the settle window that waits out a lagging tracker after epic generation and
after implementation and that finishes when the window is exhausted, a lane that stays open
marked `retrying` without stopping the run, retry after the backoff, the parked-only stop, the
finished transition when a pass yields no epic and no pending ADR, restart after that
transition, the lifecycle and goal-save refusals during implementation plus an empty ADR start,
replay of the implementation state and activity to a reconnecting client and
of the finished state to a client that connects after the run ends, the absence of a
`lifecycleState` before any run, the new run's stage after restarting from `finished`, and the
goal precondition: an absent, whitespace-only, or just-cleared goal refuses the start with one
`error` and no agent, while a non-blank goal starts the loop. It also covers each abort: a
same-open-epic stop, epic generation leaving the same pending records, and a throwing tracker
query each end with the idle `goal` state, `work: null`, `paused: false`, and the aborting
pass; a later client receives that state first, goal saving answers with the saved text, and
a new lifecycle start is accepted and runs without a stale refusal.
`server/tracker-timeout.test.ts` proves a stalled tracker child is killed at the read deadline
with a retryable `TrackerTimeoutError`, and that aborting the read kills the child and rejects
`TrackerAbortedError`.
`server/skills-preparation.test.ts` covers skills preparation: the `prepareSkills` command and
its `/prepare-skills` prompt, the project-agnostic prompt rules, one peer, activity and question
relay, the non-whitespace goal precondition, every refusal while preparation runs and while each
other activity runs, reconnect replay and disk replay after a restart, skill layout/name and
description validation, the failure when no managed skill is prepared, managed-only replacement
with an unmanaged skill preserved byte for byte, the all-skill contradiction pass, the
unmanaged-conflict and name-collision errors, invalid output and peer failure restoring the
previous managed set, and the absence of `GOAL.md` or `adrs/` writes.
`server/lifecycle-pause.test.ts` covers pausing during an implementation and resuming the same
peer, pausing with a pending question and carrying its answer across the pause, pausing between
stages while a tracker query is outstanding, pausing the initial tracker lookup and resuming
into its result, paused lane replay with recorded activity and question, goal saving while
paused, manual ADR resolution while paused and while advancing (which pauses first), automatic
resume when the manual sequence ends, stopping a paused run for good, refusal of
the lifecycle's own in-progress record and of resume during the manual sequence, retention of
the paused lane tabs when the sequence ends, guided goal revision while paused including replay
of the paused lanes and every refusal path with unchanged state.
`server/parallel-lifecycle.test.ts` covers the parallel pipeline: one overlapping implementation
peer per open epic, five lanes with no cap, stopping every running lane at once and returning to
the idle stage, generation filing several epics that start their own
lanes immediately, refill on close while other lanes keep implementing, coalesced refill
triggers, per-epic assignment, retry after backoff, immediate retry when `main` advances, a
parked lane isolated from the others and retried on `main`, the parked-only error and idle
`goal` stage, reconnect replay of counts, tabs, activity, and a lane question, pause and resume
across lanes, reset across lanes, finish when nothing remains, and five-epic tracker reads
through the existing GitHub and GitLab query shapes.
`server/reset-implementation.test.ts` drives the reset against temporary hosts with local bare
remotes: the command and started/stopped events, tracked/untracked/ignored deletion, keep-set
bytes, the `.worktree` sentinel, symlink removal without following, the exact commit subject and
remote tree, staging exclusions without a `.gitignore`, empty-change idempotence, an absent,
empty, or whitespace-only goal, a differently named `GOAL_FILE`, a bypassed failing pre-commit
hook, refusal off `main`, without `origin`, outside the top level, with an unborn `HEAD`, with an
in-repo `STATE_DIR`, and with `STATE_DIR` equal to the repository root, during an active run, a
rejecting pre-receive hook retaining the local commit, a commit failure
retaining the staged deletion, mutating-command refusal during a reset, replay to a late client,
and the post-reset empty records, goal text, and `getGoal` behavior.
`server/journal.test.ts` covers the dashboard journal: a real stub-agent run writes `activity`,
`question`, `run-start`, and `run-stop` records with `ts`, `repo`, `port`, and `pid`; a write
failure is reported without interrupting the run; rotation keeps every record; and pruning
applies the seven-day limit and the size bound without deleting the live window.
`tests/watchdog.test.ts` covers discovery (de-duplication, harness resolution, self-exclusion,
legacy logs), the inclusive ten-minute window, omp-log attribution and self-exclusion, the exact
evidence mapping (prose never produces a finding), host-independent fingerprints, filing and
commenting against a stub `gh`, per-filing and per-comment ledger persistence, pending retries
after a failed call, duplicate windows, the version 1 ledger migration, and the absence of any
commit, merge, push, or publish. It also covers the deduplication gate against a stub agent and a
stub forge: one request over the whole candidate set before any create, no issue list in the
request, the agent's own open-issue read, silent duplicate suppression with a non-filed ledger
match, same-set duplicates producing one issue, every fail-closed case, reconsideration after the
matched issue closes, the agent's decision rather than a string comparison, and the read-only MCP
surface.
`tests/watchdog-api.test.ts` covers the adapter projection, the newest-cycle history, the shared
issue row order and fields, open/closed state mapping, the `ok`/`error`/`stale` transitions
against a stubbed GitHub reader and clock, the never-waits contract, the removed GET endpoint,
and the WebSocket `agentState` reply. `tests/agent-registry.test.ts` covers the registry, the
synthetic third descriptor, shared issue sorting, and unknown-id refusal.
`tests/agent-watchdog-runtime.test.ts` covers the detached worker's first cycle, Stop during a
slow filing cycle, a SIGTERM that lets the cycle finish, cadence application without restart, the
lifecycle transitions, foreign ownership, preflight refusals, and the timer gate. All new
fixtures live under `.devboard/.tmp`; no test uses the network or a real model.

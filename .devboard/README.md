# Devboard

Local browser interface for a repository's goal, Flow implementation, and Discover artifacts.
It renders one full-viewport, dark-first administration workspace with an activity bar, a
contextual sidebar, workspace tabs, resizable split panes, Monaco editors, xterm terminals, a
command palette, and a status bar. Every mode is a client-side view over the existing WebSocket
contract; the server still owns all work and durable state.

## Interface

The interface is a desktop tool. It requires a viewport of at least 1024×720 CSS pixels. Below
either threshold the shell is not rendered: a notice carrying
`data-testid="unsupported-viewport"` states the minimum instead, so the application never
degrades into a clipped mobile layout.

### Application shell

`data-testid="app-shell"` fills the viewport exactly. It contains, in order:

|Region|Test hook|Role|
|---|---|---|
|Activity bar|`activity-bar`|Three mode tabs and their Lucide icons|
|Sidebar|`sidebar`|Contextual navigation for the active mode|
|Workspace tabs|`workspace-tabs`|Open resources in the active mode|
|Workspace|`workspace`|The active tab's surface; absorbs all remaining space|
|Status bar|`status-bar`|Connection, project, counts, mode status, versions, theme, notifications|

The status bar stays visible while panes resize, and the document itself never scrolls
vertically or horizontally. Each mode's panel keeps its scroll position, focus, open tabs, and
unsaved editor text while another mode is shown.

### Activity bar

The bar presents exactly the three existing modes as `role="tab"` controls:
`data-testid="mode-goal"`, `data-testid="mode-flow"`, and `data-testid="mode-discover"`. Each
carries a Lucide icon, an accessible name, `aria-selected`, and `aria-controls` naming its
workspace panel. A fresh profile starts on Goal. Clicking a tab or pressing Alt+1, Alt+2, or
Alt+3 changes only which mounted view is shown; it never sends a WebSocket frame.

### Sidebar

The sidebar is contextual and can be hidden with Ctrl/Cmd+B or the control in its header.
It is initially 300 CSS px wide, constrained to 200–600 CSS px, and resized by dragging its
separator or pressing the arrow keys with that separator focused. Double-clicking the separator
restores the default width. Visibility and width survive a reload.

- **Goal** lists the goal workspace surfaces, every ADR record (title, status, pending or
  resolved state, next marker, file), the lifecycle lanes, and the prepared skills.
- **Flow** lists the session, PR state, widgets, changed files, checkpoints, steering, decision
  board, blockers, and history.
- **Discover** lists the overview and glossary sections, the five skills under their own group, a
  nested glossary submenu, warnings, and recent notices.

Selecting an entry opens or focuses its workspace surface. Informational entries open the
surface that holds the same facts.

### Workspace tabs

Opening an ADR, a Flow widget, changed file, or checkpoint, a Discover term, or a Discover skill
adds one tab to the workspace strip. A tab shows its resource name, active state, close control,
and a dirty dot when its editor has unsaved changes. Opening an already-open resource activates
its existing tab. Each mode keeps its own open tabs and active tab across mode switches.

Closing a dirty tab opens a confirmation dialog; discarding restores the last saved text. A
reload restores the active mode, every mode's tabs and active tab, sidebar visibility and width,
split sizes, and theme. All of that state lives in `localStorage`; none of it is sent to the
server.

### Split panes

PaneForge groups provide the sidebar/workspace split and the workspace/detail split used by Flow
widgets and diffs and by Discover term and skill detail. Separators are focusable, carry
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
start/stop and PR actions, Discover start/stop and skill editing, sidebar and theme toggles, reset
layout, reload when stale, and reporting a UI issue.

### Keyboard shortcuts

|Shortcut|Action|
|---|---|
|Ctrl/Cmd+K|Open the command palette|
|Ctrl/Cmd+B|Toggle the sidebar|
|Alt+1 / Alt+2 / Alt+3|Switch to Goal / Flow / Discover|
|Ctrl/Cmd+S|Save the focused editor when it has unsaved changes|
|Escape|Close the palette, dialogs, and overlays|

Shortcuts are inert while text is being typed, except palette, save, and Escape. Every shortcut
is listed in the palette or in the control's tooltip. Focus rings are always visible; dialogs
trap focus and restore it on close.

### Theme

A fresh profile starts dark with `data-theme="dark"` on the root element, regardless of the OS
preference. The status-bar control and the palette toggle between dark and light; the choice
persists and an inline head script applies it before the first paint, so there is no wrong-theme
flash. Both themes define every token used by the shell, tables, editors, terminals, diffs,
status indicators, and overlays. Body text and muted text meet 4.5:1 contrast; interactive
borders and focus rings meet 3:1; no state is conveyed by color alone. `prefers-reduced-motion:
reduce` disables nonessential transitions.

### Dense data views

TanStack Table renders the ADR record list and the Discover command, testing, architecture,
dependency, unknown-field, and glossary tables. The ADR table keeps title, status,
pending or resolved state, next marker, file, and decision summary; selecting a row opens its
detail tab without navigating away. Body and table text is 12–14 CSS px, paths, code, diffs,
terminal output, and IDs are monospace, one-line data rows are at most 32 CSS px tall, and wrapped
data rows stay within 120 CSS px. The shell uses
the full viewport with no application max-width.

### Editors and terminals

Monaco Editor provides the Goal document (`goal-text`), Flow goal (`flow-goal-text`), Flow
decision board (`flow-decisions`), and Discover skill editor (`discover-skill-text`). Each
supports multiline Markdown or plain-text editing, its Save control, Ctrl/Cmd+S, a dirty marker,
and an accessible label; a save sends the editor's exact text. Flow diffs remain rendered by
`diff2html`; the client never parses unified diff hunks.

xterm.js renders read-only agent output for Goal current activity and history, lane current
activity and history, Flow goal creation, implementation activity, conversation activity, and
Discover activity. Terminals preserve ANSI output, are selectable and copyable, auto-scroll
unless the developer scrolls away, keep a bounded scrollback, and expose their full buffer to
assistive technology.

### Notifications and status bar

Server errors and notices appear in the notification region (`data-testid="notifications"`) with
severity, text, and dismissal, and remain in a history opened from the status bar. Notifications
never replace mode content or steal focus, and several arrivals are all retained. Flow blockers
and verification results also remain in their mode context.

The status bar shows the WebSocket connection, the project path, running work and lane counts,
the active mode's status, and the running and installed versions. When `versionState.stale` is
true it shows the existing reload control (`reload-devboard`), whose accessible name and title
name both versions; reload behavior is unchanged. It also carries the theme toggle and the
notification indicator.

### Verifying the interface

```bash
cd .devboard
bun run verify:interface
```

The script builds the client, seeds a fixture host under `.devboard/.tmp` with eight ADRs and
real Discover artifacts produced by the stub ACP peer, starts a source dashboard, launches
headless Chrome with a profile under the same tree, and asserts the shell, modes, sidebar,
tabs, splits, palette, shortcuts, theme and first paint, layout persistence and reset, the
1024×720 boundary, dense tables, Monaco editors, xterm terminals, contrast, reduced motion,
notifications, status bar, preserved test hooks, and the absence of exceptions, console errors,
failed requests, and overflow. It writes screenshots under `.devboard/.tmp/interface/`.

## Stack

- Backend: TypeScript on Bun, serving the built client and one WebSocket at `/ws`. Each run
  spawns one `omp acp` subprocess over stdio.
- Client: Svelte 5 built with Vite, with shadcn-svelte components and its Tailwind CSS 4 setup,
  Bits UI dialogs, tooltips, and popovers, PaneForge split panes, TanStack Table data grids,
  Monaco Editor, xterm.js, and Lucide icons. All workers and assets are bundled locally; the
  page makes no network request beyond its WebSocket.
- Density: 13 px body text with 12 px tables and monospace paths, code, diffs, terminals, and IDs.
- Records: read from `adrs/` on every `listRecords` command and after every run, so files added,
  removed, or resolved while the server runs appear without a restart. Each record carries the
  first paragraph of its `Decision` section as a short summary.
- State: the dashboard's server-owned state is written atomically to
  `<stateDir>/state/<24-hex hash of REPO_DIR>.json` (default `stateDir` is `<harness>/.tmp`), so it
  survives a backend restart without leaking between repositories that share one harness install.
  See [Durable state](#durable-state).

## Install

The harness ships as the private `@dsdenes/devboard-harness` GitHub Release. The public npmjs
package `@dsdenes/devboard` is a launcher: it resolves the newest release, installs it through
npm, copies the wrapper files, and runs diagnostics. It contains no harness code.

```bash
npx @dsdenes/devboard install    # install or refresh this host
npx @dsdenes/devboard update     # install the newest release; do not restart
npx @dsdenes/devboard doctor     # one PASS or FAIL line per check
```

`install` writes a real npm prefix at `<host>/.devboard`, replacing `.devboard`,
`.omp/commands`, and `.omp/extensions` symlinks with real directories that hold the installed
package's files. It keeps `.devboard/.tmp`, copies `templates/host-AGENTS.md` to
`<host>/AGENTS.md` when that file is a symlink or absent (an existing regular file is untouched
and reported as drift), adds the three ignored paths to `.gitignore`, and leaves exactly one
dashboard running from the installed package. A reinstall keeps the version and `.tmp`; `update`
never starts, stops, or restarts the dashboard.

`doctor` checks Node 20+, Bun, npm, the git root, `gh` access to the release repository, the
release metadata and digest, the installed package, the installed version against the latest
release, `omp` and its authenticated probe, wrapper byte-equality, `AGENTS.md`, the dashboard's
package and HTTP response, a non-symlinked `.devboard`, and a recorded update failure. Drift in a
regular `AGENTS.md` is reported without failing the check; every other mismatch exits nonzero.

`--host <path>` targets another repository. `DEVBOARD_RELEASE_DIR` points the launcher and the
server at a local directory of tarballs for offline verification.

`install.sh` still copies the agent wrappers under `omp/` into an existing host:

```bash
./install.sh /path/to/host
./install.sh --force /path/to/host
```

The host must already contain a `.devboard/` directory. Every file under `omp/` is copied to the
same relative path under `<host>/.omp/`; matching files are left alone, unrelated host files are
never removed, and a differing file stops the run unless `--force` is given.

The global `/setup-devboard` command runs the launcher against the invoking session's working
directory. It lives here as `omp/commands/setup-devboard.md` and is linked into the user-level
command directory (`$HOME/.omp/agent/commands/setup-devboard.md`) so every session sees it.

### Model selection

`omp/config.yml` is installed as `<host>/.omp/config.yml`, the host's omp project settings.
Every harness peer starts its ACP process with `<REPO_DIR>` as the working directory, so each
one, and the interactive agent started in that repository, uses the same policy:

|Setting|Value|Meaning|
|---|---|---|
|`modelRoles`|`opencode-go/deepseek-v4.1-flash` for `default`, `plan`, `smol`, `slow`, and `task`|Model for every chat role the harness uses.|

The model is served by OpenCode Go and reads `OPENCODE_API_KEY`. No fallback chain is
configured. Editing `omp/config.yml` here and rerunning `install.sh` changes the installed copy.

## Build and run

Run the interface from this directory:

```bash
cd .devboard
bun install
bun run build
bun run check
bunx tsc --noEmit
ADRS_DIR="<host>/adrs" bun run start
```

`bun run check` type-checks every `.svelte` and `.ts` file under `client/` and `server/`;
`bunx tsc --noEmit` type-checks the TypeScript sources.

Open `http://127.0.0.1:8080/`. The server binds to `127.0.0.1` by default.

## Durable state

The dashboard keeps the state that drives the page in one file per host repository and restores
it from a new process after a graceful stop, a launcher restart, or a `SIGKILL`. The file is
`<stateDir>/state/<key>.json`, where `key` is the 24-hex SHA-256 prefix of the resolved
`REPO_DIR` (the same key the journal uses) and `stateDir` is the harness state directory,
`<harness>/.tmp` by default and overridable with `STATE_DIR`. Two repositories that share one
harness therefore never read or overwrite each other's lifecycle, lane, pass, or foreground
state, and a repository with no stored state starts at pass 1 with no lanes and no
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
accepted `whenIdle` restart. Browser-only state (open tabs, active tab per mode, drafts, layout, theme,
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
continues from its persisted record, re-spawning that record only while it is still `Proposed`
and otherwise advancing to the next pending record; goal creation re-spawns `/goal-outcome`; a
revision re-spawns the same prompt including its original guidance; skills preparation re-spawns
`/prepare-skills` after restoring the same pre-run snapshot, so a resumed preparation that ends in
failure restores the exact bytes captured before the original run. Restored activity is kept and
new lines append. A pending lane or foreground question is replayed to every connecting client
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

A closed or failed lane whose retention window expired while the server was down is not
replayed; the remaining window is honored after a restart. An unreadable, truncated, or
unsupported-version state file never prevents startup: the server renames it aside inside
`stateDir` (`.damaged-<timestamp>`), starts from the initial state, and reports exactly one
`error` to the first connecting client and on stderr, leaving the preserved bytes in place. A
read-only state directory never stops the server: it keeps serving from memory and reports one
`error` on stderr and in the journal.

## Flow Mode

The activity bar carries three client-only tabs, `Goal`, `Flow`, and `Discover`
(`data-testid="mode-goal"`, `data-testid="mode-flow"`, and `data-testid="mode-discover"`).
Switching is a view change only: it sends no WebSocket frame and
starts, stops, pauses, or resumes no work in any mode. Goal Mode is the goal, ADR, epic,
lifecycle, and skills interface described above. Flow Mode is one implementation session that the
developer steers while it works: the developer interviews for a goal, starts an implementation
agent in an isolated worktree, reviews the changes as color-coded widgets, discusses a widget with
a read-only agent, and writes steering notes and decisions that the agent consumes between
checkpoints.

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
`startFlowImplementation`, `stopFlowImplementation`, `saveFlowGoal`, `retryFlowPr`,
`markFlowPrReady`, `mergeFlowPr`, `sendFlowSteering`, `saveFlowDecisions`, `acceptFlowWidget`,
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
`saveFlowGoal` replaces the goal text while the implementation is stopped. `startFlowImplementation`
requires a non-empty goal and starts `/flow-implement`; `stopFlowImplementation` ends that peer and
reports the session `stopped`. A session whose pull request has merged cannot be restarted: create
a new goal.

The implementation commits each coherent unit itself and never pushes. The server reads its
commits, records the checkpoints, follows the diff, and runs the change analyst whenever the
diff changes. The developer watches activity, answers implementation questions, accepts or refuses
widgets, and writes steering notes and decisions while it works. A refused widget becomes a
steering note telling the agent to abandon that change and implement another solution.

### Session state

A session lives at `<stateDir>/flow/<24-hex journalKey(REPO_DIR)>/<session-id>/`, keyed exactly
like the dashboard state, so repositories sharing one harness never see each other's sessions.
`stateDir` is the harness state directory (`<harness>/.tmp` by default, overridable with
`STATE_DIR`); `<session-id>` is an 8-hex id chosen when the session is created. The directory is
never committed and never written into the host.

|File|Contents|
|---|---|
|`goal.md`|The goal text `/flow-goal` wrote, or the text the developer saved.|
|`decisions.md`|The decision board: developer text plus appended timestamped sections.|
|`steering.jsonl`|Append-only developer steering notes.|
|`steering-ack.jsonl`|The ids of steering notes the implementation consumed.|
|`checkpoints.jsonl`|One JSON line per commit: id, time, summary, files, sha, verification.|
|`verification.json`|Latest test, lint, or build result: command, status, timestamp, output.|
|`changes.json`|The current changed files with status, insertion and deletion counts, and diffs.|
|`accepted.json`|The widget signatures the developer accepted.|
|`blockers.jsonl`|Every `DEVBOARD-BLOCKED:` line an implementation printed.|
|`session.json`|Machine state: ids, status, worktree, branch, base, widgets, checkpoints, PR.|
|`request.json`|Analyst input: goal, decisions, changed files and diffs, previous widgets.|
|`widgets.json`|The change analyst's complete widget list.|

`goal.md`, `decisions.md`, `verification.json`, and `checkpoints.jsonl` are re-read on restore,
so text a developer or agent changed while the server was down is the text the replacement uses.
`session.json` is the source of truth for status, worktree, branch, widgets, accepted signatures,
changed files, blockers, and the pull request.

### Change widgets

The change analyst groups every changed file into one or more widgets and writes the complete list
to `widgets.json`. Each widget has a fixed category, a concept, a summary, a rationale, and the
files it covers. The seven categories are:

- `contract` — an interface another part of the system or an external caller depends on.
- `entity` — the identity, lifecycle, or ownership of a domain object.
- `naming` — a rename or terminology change with behavior otherwise unchanged.
- `data` — a migration, schema, persistence, or stored-data shape change.
- `dependency` — an added, removed, or changed external package, service, or tool.
- `irreversible` — a change that is costly or impossible to undo after shipping.
- `structure` — file layout, module boundaries, or code organization, and the fallback for a
  file no clearer category explains.

Every category has its own color token, each with a light and a dark variant:
`--flow-contract-border` and `--flow-contract-surface` through
`--flow-structure-border` and `--flow-structure-surface`, defined for the day theme in `:root` and
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
never rewritten. Notes carry `new` until the implementation appends the consumed ids to
`steering-ack.jsonl`, after which the server reports them `read`. The implementation reads only
the lines it has not consumed, appends the ids it acted on, and applies every direction before
its next checkpoint. Refusing a widget records the refusal as a steering note, and concluding a
widget conversation appends its conclusion to the decision board and adds one steering note.

The decision board is `<session-dir>/decisions.md`. The developer's `Save decisions` replaces
the document and is authoritative: it is exactly the text the agent reads next. Sections the
server appends — a widget conclusion, for example — are timestamped and source-named, and only
ever append: they never edit, reflow, or remove the developer's text or an earlier section. An
appended section is a record, not a vote: the developer's saved text still governs, and the
implementation must not rewrite either form.

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

After a successful merge the server fast-forwards the host's `main` checkout when it is on `main`
and clean, removes the worktree, and deletes the local and remote branch once the branch tip is an
ancestor of `origin/main`. Whatever it could not remove is reported as a leftover and as one
`error`; the session still records the merge, and the leftover names each path or ref so nothing is
silently abandoned.

### Restart and resume

A graceful stop, launcher restart, or `SIGKILL` leaves the session on disk. The replacement reads
the session directory and re-emits its complete state. A session that was running is reported
`stopped`, its pending question is cleared, and the server sends one `flowNotice` saying the Flow
implementation stopped and that starting it again resumes it. It never re-spawns a Flow agent on
its own: no goal interview, implementation turn, change analysis, or widget conversation resumes
automatically. Selecting `Start implementation` re-spawns `/flow-implement` with the same session
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

The Discover mode is the third client-only view, opened from the activity bar. It exists for an existing host project: one
read-only crawl produces an evidence-backed project sheet, a UbiLang glossary for each detected
bounded context, and five project-specific Agent Skills that every devboard implementation agent in
that host discovers. Switching to Discover, and switching its tabs, sends no WebSocket frame
and starts, stops, resets, or clears nothing; all three views stay mounted, so native details,
scroll state, and focus survive. Discover events render only in this view and never touch Goal
Mode's activity, question, or error state.

The Discover sidebar opens tabs for `Overview` and `Glossary` under **Sections**, and the five
skills `Testing Strategy`, `Naming Conventions`, `Coding Conventions`,
`Architecture & Boundaries`, and `Glossary` under **Skills** (`data-testid="discover-tab"` with
`data-tab` values `overview`, `glossary`, `testing-strategy`, `naming-conventions`,
`coding-conventions`, `architecture-boundaries`, and `glossary-skill`). The active panel carries
`data-testid="discover-panel"` and the same `data-tab`. Warnings follows as its own group with a
count; the sidebar keeps no freshness group.

The Glossary row carries a disclosure control (`data-testid="discover-glossary-toggle"`) that opens
a nested submenu (`data-testid="discover-glossary-menu"`) listing each bounded context by its full
title and its terms. The submenu opens automatically while the Glossary tab or a term tab is
active, and its entries carry no status badges.

With no published artifacts the Overview tab shows an empty state (`data-testid="discover-empty"`)
and a `Discover project` button (`data-testid="discover-start"`); with artifacts it shows
`Re-discover`. The button is disabled when the socket is not open, while a Discover run is active,
or while Goal or Flow work is active, and its title names the reason. It never starts on page
load, reconnect, mode switch, or tab switch. Selecting it sends `{ "type": "discoverProject" }`;
the server broadcasts `discoverStarted` and starts exactly one ACP peer whose prompt is exactly
`/discover <staging-dir>`, whose working directory is the repository root, and whose staging
directory is `<host>/.omp/discover/staging/<run-id>/`. A second start while one runs is refused
with one `discoverError` and spawns no peer. A start requires no `GOAL.md`, no prepared skill, a
clean tree, or a forge account; it is accepted on a host with a dirty tree and no goal document.

The run is server-owned: closing the browser or switching views does not stop it. The view shows
an active marker (`data-testid="discover-active"`) and the xterm activity output, and a reconnect receives
`discoverState`, `discoverStarted`, every recorded activity line, and any pending question before
its own command replies. The crawl is not an interview: an ambiguity is recorded as `unknown` with
a reason, never a blocking question. `answerDiscover` with the pending id and a non-empty value
answers it once; a second answer, a stale id, or an empty value is refused with one
`discoverError`. `stopDiscover` closes the peer, clears the pending question, removes staging,
broadcasts `discoverStopped { completed: false }`, and leaves the last published artifacts
byte-identical; it spawns no replacement peer.

Discover uses the same WebSocket at `/ws`. The client sends `discoverProject`, `stopDiscover`,
`answerDiscover` (with `id` and `value`), `getDiscover`, `saveDiscoverSkill` (with `name` and
`text`), and `restoreDiscoverSkill` (with `name`). The protocol also accepts
`confirmGlossaryTerm` (with `context` and `id`) and `rejectGlossaryTerm` (with `context`, `id`, and
a non-empty `reason`) for tooling, but the Glossary tab does not use them. `getDiscover` asks for
the current snapshot and is answered with `discoverState`. The server
broadcasts `discoverState`, `discoverStarted`, `discoverActivity`, `discoverQuestion`,
`discoverStopped`, and `discoverError`; it never sends `activity`, `question`, `error`,
`runStarted`, or `runStopped` for Discover. `discoverState` carries the active and interrupt flags,
staleness, warnings, the busy reason, the last read error, the manifest, freshness, sheet,
glossaries, decisions, and the five skills with baseline text, live text, hashes, and state.
`discoverQuestion` carries `id`, `message`, and `options` of `{ label, description?, recommended }`.

When the peer exits, the server validates every staged artifact and the whole staged set before
publishing. Success publishes atomically, removes staging, broadcasts `discoverState` with the new
artifacts, and broadcasts `discoverStopped { completed: true }`. Any invalid, missing, unreadable,
or incomplete artifact, schema violation, write outside staging, or collision with a non-Discover
skill fails the run: staging is removed, one `discoverError` names the reason,
`discoverStopped { completed: false }` follows, and the previous sheet, glossary, manifest,
baselines, and live skills stay byte-identical.
Published artifacts are read from disk when a client connects, so no prior run in the process is
required; an unreadable or invalid published artifact is reported with one `discoverError` and the
files are never overwritten.

Artifacts live only under the host: `.omp/discover/manifest.json`, `.omp/discover/sheet.json`,
`.omp/discover/decisions.json`, `.omp/discover/glossary/<bounded-context>.glossary.yaml`,
`.omp/discover/skills/<skill>/SKILL.md` for the generated baselines, and the live, editable
`.omp/skills/<skill>/SKILL.md`. Staging mirrors the crawl's relative layout without `manifest.json`
or `decisions.json`, and the staged sheet omits freshness. The manifest carries a schema version,
the discovery fingerprint, the publication time, the run id, the sheet's structural digest, one
structural digest per glossary, the five skill names, each live skill's baseline and current hash,
each skill's edited or missing state, and artifact paths relative to the host; it contains no
secrets and no absolute path.

`sheet.json` is the canonical data sheet, with top-level keys in the fixed order `schemaVersion`,
`definition`, `stack`, `deployment`, `environments`, `commands`, `branching`, `testing`,
`architecture`, `ci`, `runtime`, `dependencyMap`, and `delivery`. It has a freshness header naming
the project, the short commit, the dirty flag, the discovery time, and the stored fingerprint. The
Overview tab is a project sheet, not a card grid. A masthead
(`data-testid="discover-freshness"`) carries the project name, `dirty` and `stale` badges, the
one-sentence definition, the short commit, the discovery time, and the definition's confidence and
evidence. Below it, `Run and verify` holds the commands and testing panels, `Platform` and
`Delivery` form a rail, and `Stack`, `Architecture and boundaries`, `Entry points and dependencies`,
and `Not observed` span the page. Every section carries `data-testid="discover-card"` and
`data-field`; the commands and testing panels are raised surfaces and the remaining sections are
flat, separated by hairlines. Below 1240px viewport the rail collapses into the single column.
Tables grow with the page; no panel scrolls inside the page.
Each section ends with its provenance line: one `data-testid="discover-confidence"` per confidence
present among the shown values and one `data-testid="discover-evidence"` per de-duplicated evidence
path. Unknown leaves are not rendered inside sections; they are collected in a `Not observed`
table with section, field, and reason. Every non-`unknown` leaf carries at least one sorted, unique
repository-relative evidence path, symbol anchor, or safe git fact and a confidence of `observed`,
`declared`, `inferred`, or `unknown`;
`unknown` carries empty evidence and a short reason. The definition is exactly one sentence of at
most 240 characters; every value and list entry is a single line of at most 160 characters. The
sheet covers the short platform stack (languages, runtimes, package managers, frameworks, and
major tools, not individual dependencies), customer-facing deployment (artifact class, artifact,
target, and pipeline sources), every environment (at least `production`, whose purpose states how
changes reach it), exact main commands (with `unknown` for an unobserved command), branching
strategy and model, test levels and pyramid, architecture boundaries, CI provider, triggers, jobs,
and quality gates, and the three mandatory sections: runtime inventory, entry-point and
dependency map, and delivery and versioning. It never guesses, invents an additional environment,
copies README prose, or records a configuration value; a claim it cannot ground is `unknown`.

Main commands render as a `Task`/`Command` table of the observed commands, `$`-prefixed, headed
by an `N of 8 commands found` count; a try-out command is followed by a note when it is not the test
suite. Testing shows a compact generated SVG pyramid (`data-testid="discover-pyramid-chart"`) beside
the known test and level totals and the whole-suite command
(`data-testid="discover-suite-command"`), then a `Level`/`Tests`/`Paths & fixtures` table
(`data-testid="discover-pyramid"`). Runtime, deployment, CI, and branching use compact `dt`/`dd`
facts; the three delivery facts share one provenance line. Architecture contexts render as a table
with path, responsibility, and entry points, followed by external-boundary and shared-kernel chips.
The dependency map renders observed groups as chips, and `Stack` renders one full-width chip band
after the two columns. Environments is `unknown` here, so it appears only in the ledger. The
delivery section and the deployment pipeline sources stay hidden because they repeat other facts. A
sheet with no observed test level and a glossary with no matching term keep an explicit empty state.

The Glossary tab and `.omp/discover/glossary/` implement the UbiLang glossary format: one YAML
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
earlier operator decision invalidated one. The tab groups terms by context and offers search; it
shows no status filter, status badge, or per-term control, and it hides invalidated terms. Each
context card holds a three-column table — Term, Definition, Kind — that grows with the page and
wraps long definitions; each term carries `data-testid="discover-term"`, `data-context`, `data-id`,
`data-status`, and `data-kind`, and each context carries `data-testid="discover-context"`. The
context heading shows its title, falling back to the context id only when no title exists. The
Kind column is muted rather than color-coded.

Confirmation is automatic, so the Glossary tab offers no `Confirm` or `Reject` control.
`confirmGlossaryTerm` still succeeds only for a term that is proposed or unconfirmed, and
`rejectGlossaryTerm` requires a non-empty reason and changes a proposed, unconfirmed, or confirmed
term to `invalidated`; neither is reachable from the tab. Both append a dated decision to
`decisions.json` with the context, id, action, reason when rejecting, and date, never adding a
field to the YAML, and the change survives reload, reconnect, and restart. A later crawl preserves
every confirmed or invalidated concept's labels, definitions, notes, status, origin, standard
reference, kind, and related ids; it may refresh grounding and add confirmed concepts, but it never
resurrects an invalidated id, never overwrites a human decision, and removes an undecided concept
only when the new crawl no longer grounds it. A malformed or structurally invalid glossary fails
the run atomically with one `discoverError` naming the file and rule.

A successful run publishes exactly five skills under `.omp/skills/`: `discover-testing-strategy`,
`discover-naming-conventions`, `discover-coding-conventions`,
`discover-architecture-boundaries`, and `discover-glossary`. Each is a directory containing
`SKILL.md` whose frontmatter has `name` equal to the directory, a non-empty `description` of at most
1024 characters, `metadata.devboard-managed: "true"`, `metadata.devboard-family: "discover"`, and
`metadata.devboard-skill` naming its role. The bodies are project-specific and directive: one
imperative bullet per rule, naming a path only when that path helps apply the rule. Testing
strategy states levels, pyramid, commands, paths, fixtures, coverage expectations, and how to add a
test; naming conventions state canonical terms, casing, and rejected aliases; coding conventions
state patterns, error handling, typing, async, logging, dependencies, formatting, and prohibited
constructs; architecture and boundaries state contexts, entry points, dependency direction,
persistence, integrations, and prohibited cross-boundary imports; the glossary skill names the
published glossary files, the confirmed and rejected rules, and the proposal process. From the host
root, a new `omp` session lists the five (`omp skill list`) and loads their bodies as skills, so
every implementation agent in that host discovers the set with no extra configuration.

Each skill has a tab that is one full-height Monaco Markdown editor for the whole `SKILL.md`
(`data-testid="discover-skill-text"`), with no rendered preview and no split pane. The header holds
the skill name, `discover-skill-save`, and, while the live text differs from the generated version
or the file is missing, `discover-skill-restore`. A `discover-skill-dirty` marker appears while the
draft has unsaved changes; the tab renders no state badge. `saveDiscoverSkill` writes the submitted
bytes verbatim and updates the manifest's current hash and edited state; it is refused with one
`discoverError` when the name is not one of the five, the skill is missing, the frontmatter name
no longer matches the directory, the description is empty or too long, or a marker was removed,
and invalid text leaves the previous file byte-identical. `restoreDiscoverSkill` copies the current
generated version over the live skill, recreating it when it was deleted; it spawns no agent. A
later run compares each live hash with its last baseline: an unedited skill is replaced,
an edited skill is preserved byte for byte with its new baseline published beside it, and a skill
the developer deleted is not recreated but shows the `Recreate generated version` action. A
generated name colliding with a prepare-family, unmanaged, or different Discover skill fails the
run and publishes nothing.

The goal lifecycle's skill prerequisite accepts a managed skill from either family: at least one
prepare-family or Discover skill is enough for `Start implementation`. `getSkills` and `skillsState`
carry `name`, `description`, `family` (`prepare` or `discover`), and `state` (`generated`, `edited`,
or `missing`), and a managed skill with no `devboard-family` field belongs to `prepare`. The Skills
panel lists both families with their family and Discover state. Prepare Skills replaces only its
own family, and its contradiction review covers its family plus hand-authored unmanaged skills, so
a project-specific Discover directive cannot fail a project-agnostic preparation. Discover's
generated baselines must agree with each other and with the glossary; a contradiction there fails
the run, while a contradiction introduced by a developer's skill edit is a non-blocking warning in
the skill editor and never discards the edit.

The sheet and every glossary are canonicalized before publication: fixed schema key order, arrays
sorted by stable identity, evidence sorted and de-duplicated, and enums in fixed spelling. The
structural digest excludes volatile fields (`discoveredAt`, fingerprint timestamps, run id, and
publication time) and bounded prose (the definition, glossary titles, definitions, scope notes,
history notes, and unknown reasons); skill bodies and descriptions are not part of it. Two runs
against the same unchanged host fingerprint produce the same sheet digest and the same digest for
every unchanged glossary, while bounded prose may differ. The fingerprint covers the host `HEAD`
and the content of tracked and untracked non-ignored files, excluding `.devboard/`, `.worktree/`,
`.omp/discover/`, `.omp/skills/`, VCS internals, and ignored files; the manifest stores it, and
`stale` is true only when the current fingerprint is readable and differs. Discover caches nothing:
every accepted start re-crawls.

The crawl is read-only with respect to the host. Its tools read files and safe read-only git facts
(`git rev-parse`, `git log`, `git branch`, `git status`, `git ls-files`) only; they never run a
project command, test, build, package manager, install, web fetch, or forge query, and the only
network traffic is the model endpoint that serves the peer. The crawl excludes `.devboard/`,
`.worktree/`, `.git/` internals, `.omp/`, dependency caches, build outputs, and ignored files, but
reads `README`, `AGENTS.md`, `GOAL.md`, `adrs/`, manifests, configuration, source, tests, and CI
files that remain. It never modifies `GOAL.md`, `adrs/`, or host source and never writes
`.omp/discover` or `.omp/skills` directly; its only write is the staging directory. Environment
and configuration names may be recorded, but their values, tokens, credentials, private URLs, and
URLs with user info are never copied into an artifact.

A Discover run is active work. While it runs, `startRun`, `startLifecycle`, `resumeLifecycle`,
`saveGoal`, `reviseGoal`, `createGoal`, `prepareSkills`, every Flow start, and a second
`discoverProject` are refused with one error naming the active run and spawn no peer; view and
tab switching, read-only commands, and `resetImplementation` stay available. While any Goal or
Flow work is active, `discoverProject` is refused with one `discoverError` naming the active work.
`restartServer` with `whenIdle: true` treats a Discover run as active and answers `upgradePending`,
and an immediate restart ends the recorded child, removes staging, publishes nothing, sends one
`discoverError` naming the interruption, sets the interrupted flag, and never auto-resumes.
`resetImplementation` cancels a run the same way and leaves `.omp/discover` and the Discover skills
untouched because reset preserves `.omp`. Only one run exists at a time; a stopped or interrupted
run leaves the previous artifacts readable, and a later start uses a fresh staging directory.

## Publish a change

Merging into `main` and pushing triggers `.github/workflows/devboard-release.yml`, which builds
the client, runs the harness suite and typecheck, packs `dist/`, `server/`, `templates/`, the
prompts and omp wrappers into the private harness tarball, publishes the launcher version to
npmjs, and creates the GitHub Release `v<version>` with the tarball and its `.sha256`. The
version is `0.1.<commit-count>` over the full history; a rerun on the same commit leaves the
existing npm version and release assets untouched.

After the push, verify from the integration checkout:

```bash
cd .devboard
bun run publish
```

`bun run publish` refuses a worktree, a branch other than `main`, or a checkout ahead of or
diverged from its canonical remote; fetches and fast-forwards `main` without discarding
uncommitted work; installs dependencies and rebuilds `dist/`; waits for the release workflow of
`HEAD`; verifies the GitHub Release assets and `npm view @dsdenes/devboard@<version> version`;
and reports every running dashboard's running and installed versions. It never restarts a
dashboard and never writes into a host. `--wait-timeout N` bounds the workflow and propagation
wait (default 1800 seconds).

Installed dashboards update themselves: each checks the newest release at startup and every
60,000 ms (`DEVBOARD_UPDATE_INTERVAL_MS` overrides it), verifies the `.sha256`, installs the
tarball through a staging prefix, and keeps serving its loaded code. The npm child always runs in
that staging directory, and the dashboard starts from the host root rather than the replaceable
package directory, so replacing the package never leaves a child with a deleted working
directory. `versionState` reports `running`, `installed`, `latest`, and `stale`; the reload
control appears while `stale` is true and restarts the server from the installed package. A
failed check, checksum, authentication, or npm install leaves the previous package and server
intact, writes `update-error` to the journal, and is retried with exponential backoff
(`DEVBOARD_UPDATE_BACKOFF_MAX_MS` caps it).

|Variable|Default|Purpose|
|---|---|---|
|`HOST`|`127.0.0.1`|Listen address.|
|`PORT`|`8080`|Listen port.|
|`ADRS_DIR`|`/repo/adrs`|Directory holding the ADR files.|
|`REPO_DIR`|parent of `ADRS_DIR`|Agent working directory and default goal location.|
|`GOAL_FILE`|`<REPO_DIR>/GOAL.md`|Goal document read on load and replaced on save.|
|`STATIC_DIR`|`dist`|Built client directory.|
|`AGENT_COMMAND`|`omp acp`|ACP peer command, split on whitespace. `server/fixtures/stub-agent.ts` is a deterministic substitute for tests and local verification.|
|`STATE_DIR`|`<harness>/.tmp`|State and journal directory; an installed dashboard passes `<host>/.devboard/.tmp`.|
|`DEVBOARD_UPDATE_INTERVAL_MS`|`60000`|Automatic update check interval.|
|`DEVBOARD_UPDATE_BACKOFF_MAX_MS`|`3600000`|Ceiling for the exponential retry delay after a failed check or install.|
|`DEVBOARD_RELEASE_DIR`|unset|Local release directory for offline verification; unset reads GitHub Releases through `gh`.|

## Harness watchdog

A machine-level systemd user timer runs the watchdog independently of every dashboard: at
minutes 0, 10, 20, 30, 40, and 50 of every hour (`OnCalendar=*:0/10`, `Persistent=true`), the
`devboard-watchdog.service` oneshot runs `bun run watchdog -- --once` from the canonical harness.
It survives logout (`Linger=yes`) and never starts, stops, or restarts a dashboard itself.

Each cycle reads the ten minutes before cycle start, both ends inclusive, from:

- every live dashboard's JSONL journal, `<STATE_DIR>/journal/<24-hex>.jsonl`, whose key is the
  first 24 hex characters of `sha256(REPO_DIR)`. `STATE_DIR` is the dashboard's environment
  value, `<host>/.devboard/.tmp` for an installed host. Each record carries `ts` (UTC ISO
  8601), `repo`, `port`, `pid`, `kind`, and `text`; kinds are `activity`, `question`,
  `run-start`, `run-stop`, `lane-start`, `lane-stop`, `lifecycle`, `acp-stderr`,
  `server-error`, `update`, and `update-error`. A live journal rotates at 8 MiB instead of
  truncating.
- omp's own warnings and errors under `~/.omp/logs/omp.*.log`, attributed to an instance only
  through that pid's working directory or process ancestry.

Retention is bounded: the watchdog deletes rotated journal files older than seven days at cycle
start and enforces a 1 GiB total for `.tmp/journal`, deleting the oldest complete files first. A
file still holding records inside the live window always wins over that bound, so the current
cycle never loses evidence.

Discovery scans `/proc` for every process running `server/index.ts` that supplies `REPO_DIR` and
`PORT`, de-duplicates by `(REPO_DIR, PORT)`, resolves the serving harness from `STATIC_DIR` or
the process working directory, and reads the journal from the process's `STATE_DIR`. Instances
from installed hosts and the canonical source checkout are covered alike; an instance whose
state directory has no journal is reported `uninstrumented` and its legacy
`.tmp/devboard-<cksum>.log` is read when present.

Findings are derived from evidence, one per distinct signal: `error`, `failed-command`, `retry`,
`blocker`, `confusion`, `question-loop`, and `stall`. A clean window reports zero findings and
changes nothing.

Each cycle writes one run directory, `<harness>/.tmp/watchdog/runs/<UTC timestamp>/`, containing
`report.json`, `report.md`, and `coordinator.log`; the newest report is also
`.tmp/watchdog/latest.json`. A persistent ledger at `.tmp/watchdog/state.json` records each
finding's first and last sighting, count, and disposition; an unchanged window reports
`action: "duplicate"` and publishes nothing.

A singleton lock at `.tmp/watchdog/lock` serializes every invocation: a second manual run or a
`systemctl --user start devboard-watchdog.service` while a cycle is live prints `already running`
and exits without invoking an agent. A stale lock whose pid is gone is reclaimed.

An actionable cycle starts a headless `omp` from the canonical repository root with auto-approval,
so `AGENTS.md` and `.omp/config.yml` apply. The prompt carries the evidence, the exact window,
the instance list, and this change policy. The agent works only in a fresh `.worktree/<name>`
worktree. Before merging, the coordinator requires `bun install --frozen-lockfile` when the
worktree has no `node_modules`, then `bun test`, `bun run build`, and
`bun run watchdog -- --collect --dry-run` to pass, and it rejects any diff outside
`.devboard/**`. It then fast-forwards `main`, pushes the canonical remote, and runs
`bun run publish`. A gate, scope, or merge failure leaves `main` unchanged and preserves the
worktree; a push or publish failure leaves the pushed revision in place and exits nonzero, and
a failed publish after a successful push is retried by the next cycle without another agent run.
A pre-existing uncommitted change is recorded and blocks merge, push, and publish; it is never
discarded, stashed, or committed.

Operate it from the canonical `.devboard`:

```bash
bun run watchdog:install     # write the two units, enable and start the timer
bun run watchdog -- --once   # run one cycle now
bun run watchdog -- --collect --dry-run   # print this cycle's report; change nothing
bun run watchdog:uninstall   # stop, disable, and remove the units
```

`watchdog:install` refuses a worktree, verifies `Linger=yes` before writing anything, discovers
the absolute Bun executable plus the `omp` and `git` directories for the unit's `PATH`, and is
idempotent. `watchdog:uninstall` changes no repository file. To pause the watchdog without
uninstalling, `systemctl --user stop devboard-watchdog.timer`; `systemctl --user start
devboard-watchdog.timer` resumes it. `WATCHDOG_AGENT_COMMAND` replaces the agent command for a
manual run, which is how the tests inject a stub.

## Report a UI issue

Every page carries a `Report UI issue` button in the lower-right corner. Selecting it enters
element-selection mode: the element under the pointer is outlined, and a click opens a report
panel anchored beside it. `Esc` or `Cancel` leaves the mode, and a click in selection mode never
activates the element. The panel shows the selected element's selector path; the report text is
free-form. `File issue` posts the report with the route, URL, selector, visible text, DOM excerpt,
viewport and capture time to `POST /api/feedback`, and the server files a GitHub issue through
the operator's authenticated `gh` CLI, then returns its URL. A filed report returns to element
selection mode, so another element can be picked without leaving and re-entering the mode.

The issue title is `[ui] ` plus the first line of the report, at most 200 characters. The body is
the verbatim report followed by the captured context, so the ticket stays authoritative without a
model in the loop. Every issue is filed in `dsdenes/devboard`, the harness repository, whatever
host project the interface is serving; nothing is created in the host's own tracker. `gh` runs in
`REPO_DIR` and must be authenticated with permission to create issues in `dsdenes/devboard`. A
missing, unauthenticated, or failing `gh` is reported in the panel and still creates nothing. The
endpoint accepts only same-origin `POST` requests, bounds the body to 64 KB, and gives `gh` 60
seconds.

## Container

Build the container from the `.devboard` context at the repository root:

```bash
docker build -t devboard-adr-ui .devboard
docker run --rm -d --name devboard-adr-ui -p 127.0.0.1:8080:8080 \
  -v "$PWD:/repo" devboard-adr-ui
```

The container reads `/repo/adrs` and listens on port `8080`. The repository mount is writable because `Save goal` replaces `/repo/GOAL.md`; mount it read-only only if goal saving is not needed. Docker publishes the port on the host's loopback interface only. The container process binds `0.0.0.0` because Docker forwards published traffic to the container interface; the local-only access boundary is enforced by the `127.0.0.1` host publish.

## WebSocket contract

The client sends:

```json
{ "type": "listRecords" }
{ "type": "getGoal" }
{ "type": "getProject" }
{ "type": "getVersion" }
{ "type": "restartServer" }
{ "type": "restartServer", "whenIdle": true }
{ "type": "saveGoal", "text": "# Goal\n\nThe complete goal text." }
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
{ "type": "resetImplementation" }
{ "type": "answer", "id": 1, "value": "Gamma" }
```

- `getGoal` reads the goal document from disk and answers with its complete contents; an
  absent document answers with empty text, which shows `Create goal` and keeps the lifecycle
  start disabled.
- `getProject` answers with the page heading label. `path` is `REPO_DIR` relative to the user's
  home directory when the repository lies inside it, and the absolute path otherwise.
- `getVersion` answers with `versionState`: `running` is the harness package version the
  backend loaded, `installed` is the version its prefix holds now, `latest` is the newest
  release an update check has seen, and `stale` is true only when `running` and `installed` are
  readable and differ. A client that connects, and the page every few seconds, asks for it; a
  stale answer makes the reload control appear with both versions in its title.
- `restartServer` broadcasts `serverRestarting`, then hands the process to its launcher, which
  stops the listener, starts the installed harness package, and exits. It is refused with an
  `error` when no launcher is configured or while a restart is already in progress. A client
  that clicked the reload control waits for the replacement to answer and reloads the page even
  if the acknowledgement was lost when the old process exited. With `"whenIdle": true`, a
  dashboard with active work answers `upgradePending` instead and restarts itself as soon as
  that work ends; an idle dashboard restarts immediately.
- `saveGoal` replaces the goal document with `text` exactly as submitted and answers with the same text. A write failure leaves the file unchanged and answers with an `error`. It is accepted while the lifecycle is paused and refused while the lifecycle is advancing.
- `startRun` without `file` starts the sequence with the lowest-numbered pending record.
- `startRun` with `file` starts that record first only when it is pending; the sequence then
  continues with the lowest-numbered remaining pending records.
- Every accepted start resolves one record at a time until no pending record remains or a run
  ends without resolving its record. A still-`Proposed` or removed active record ends the
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
- `reviseGoal` starts a guided goal revision with one ACP peer. `request` is optional free-form guidance passed to the agent; without it, the agent establishes the direction through its interview questions. The agent writes the goal document itself. Activity and questions use the existing `activity` and `question` events, and `answer` replies to a revision question exactly as it does to a run question. It is accepted while the lifecycle is paused, where the suspended lanes keep their tabs.
- A revision is refused with an `error` event while the lifecycle is advancing, a run or run
  sequence is active, a manual ADR sequence is active, or another revision is active. While a revision is active, `startRun`, `startLifecycle`, `resumeLifecycle`, and another `reviseGoal` are each refused with an `error`, and no agent is spawned.
- `createGoal` starts the guided goal creation with one ACP peer whose prompt is exactly
  `/goal-outcome`, the installed skill command that reads the harness prompt and interviews the
  developer. The server accepts it in every state: it replaces a goal document that already has
  content, and it preempts an in-flight creation or revision and stops an advancing ADR run,
  manual ADR sequence, or lifecycle before the new peer starts. It reads
  `<REPO_DIR>/GOAL.md` before and after the peer, while `getGoal` and `saveGoal` keep using
  `GOAL_FILE`. It is accepted while a lifecycle run is paused, where the suspended lanes keep
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
  `startLifecycle`, `resumeLifecycle`, `reviseGoal`, `saveGoal`, `createGoal`, and a second
  `prepareSkills` are each refused with an `error` and spawn no peer.
- `resetImplementation` deletes and commits the implementation as described above. The server
  broadcasts `implementationResetStarted` when it accepts the command, performs the reset
  itself, and broadcasts `implementationResetStopped` with `completed: true` and the 40-hex
  `commit` only after `git push origin main` succeeds; a failed push includes the local commit
  with `completed: false`, and a failure before or during the commit omits `commit`. Every
  failure is preceded by one `error` carrying git's stderr where git failed. While a reset
  runs, `saveGoal`, `startRun`, `startLifecycle`, `pauseLifecycle`, `resumeLifecycle`,
  `reviseGoal`, `createGoal`, `prepareSkills`, `answer`, and a second `resetImplementation`
  are each refused with an `error`; `listRecords`, `getGoal`, `getProject`, and `getSkills` still
  answer. A client that connects during a reset receives `implementationResetStarted` before its own
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
  run is active, `startLifecycle` is also refused. `startRun` is accepted and pauses every lane
  as described above, and the lifecycle resumes when the manual sequence ends.
  `reviseGoal` and `saveGoal` are refused only while the lifecycle is
  advancing.
- `stopLifecycle` ends an active run for real. It closes every live lane peer, reports the idle
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
- When no epic remains, a generation pass files nothing, and no ADR is still `Proposed`, the
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
{ "type": "versionState", "running": "0123456789abcdef0123456789abcdef01234567", "current": "fedcba9876543210fedcba9876543210fedcba98", "stale": true }
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
  the agent suggests. `answer` names the selected label as `value`.
- A record's title is its first level-one heading.
- A record is pending exactly when its status is `Proposed`; every other status is resolved.
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
  and shows `No contradictions` when the list is empty; the contradiction review itself covers
  every skill directory, managed or not.
- The server reads ADR files and never writes them; the agent changes the status line. The server reads the tracker and never writes issues. The goal document is written verbatim by `saveGoal` and by the revision and creation agents, and the server reads it to answer `getGoal` and to report `goalRevisionStopped` or `goalCreationStopped`; a creation always writes `<REPO_DIR>/GOAL.md` even when `GOAL_FILE` names another file.
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
bun test
bun run verify:interface
bun run verify:install
bun run verify:update
bun run verify:ui
```

`verify:interface` drives the IDE shell against a seeded fixture host in headless Chrome and
writes its screenshots under `.tmp/interface`. The other `verify:` scripts build fixture releases
under `.devboard/.tmp`, install them into throwaway hosts, and assert the launcher, update, and
reload contracts end to end. They never touch a real host.

`tests/launcher.test.ts` covers the launcher and harness package boundaries: the help output,
the launcher's file list and size, the harness tarball's required and forbidden paths, its size,
and template identity. `lib/inventory.test.ts` covers the publish report. `lib/release.test.ts`
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
covers `getGoal`/`saveGoal`, including verbatim writes, failure responses, and the absence of
agent startup. `server/goal-revision.test.ts` covers guided goal revision: request and
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
reported before the first tracker lookup and to every client, stopping a running lifecycle and
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
hook, refusal off `main`, without `origin`, outside the top level, with an unborn `HEAD`, and
during an active run, a rejecting pre-receive hook retaining the local commit, a commit failure
retaining the staged deletion, mutating-command refusal during a reset, replay to a late client,
and the post-reset empty records, goal text, `getGoal`, and `saveGoal` behavior.
`server/journal.test.ts` covers the dashboard journal: a real stub-agent run writes `activity`,
`question`, `run-start`, and `run-stop` records with `ts`, `repo`, `port`, and `pid`; a write
failure is reported without interrupting the run; rotation keeps every record; and pruning
applies the seven-day limit and the size bound without deleting the live window.
`tests/watchdog.test.ts` covers discovery (de-duplication, harness resolution, self-exclusion,
legacy logs), the inclusive ten-minute window, omp-log attribution and self-exclusion, one
finding per signal, the no-op and zero-instance paths, the duplicate ledger, the stub-agent
prompt (sentinels, window bounds, instances, canonical cwd, worktree), the failed-gate and
scope-block paths with a preserved worktree, dry-run purity, and the singleton lock. All new
fixtures live under `.devboard/.tmp`; no test uses the network or a real model.

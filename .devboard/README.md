# Devboard

Local browser interface for a repository's goal, Flow implementation, and Discover artifacts.
It renders one full-viewport, dark-first administration workspace with an activity bar, a
contextual sidebar, one workspace page per mode, resizable split panes, Monaco editors, xterm
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
|Mode rail|`activity-bar`|Three labeled mode tabs and their Lucide icons|
|Sidebar|`sidebar`|Contextual navigation for the active mode|
|Workspace|`workspace`|The open surface; absorbs all remaining space|
|Status bar|`status-bar`|Connection, project name, lane count, issues state, watchdog, versions, reload|

The status bar stays visible while panes resize, and the document itself never scrolls
vertically or horizontally. Each mode's panel keeps its scroll position, focus, open page, and
unsaved editor text while another mode is shown.

### Mode rail

The 72px rail presents exactly four modes in this order as `role="tab"` controls:
`data-testid="mode-goal"`, `data-testid="mode-issues"`, `data-testid="mode-flow"`, and
`data-testid="mode-discover"`. Each is a 64×52px control with a Lucide icon above a visible 10px
uppercase label (`Goal`, `Issues`, `Flow`, `Discover`), an accessible name that also names the
shortcut, `aria-selected`, and `aria-controls` naming its workspace panel. The labels never
collapse to icon-only and never overflow the tab at the 1024×720 boundary. A fresh profile starts
on Goal. Clicking a tab or pressing Alt+1, Alt+2, Alt+3, or Alt+4 changes only which mounted view
is shown; it never sends a WebSocket frame.

The sidebar has no header: it starts with the active mode's navigation, because the rail already
names the mode and the status bar names the project.

### Sidebar

The sidebar is always visible and has no hide control or collapse shortcut. It is initially 300
CSS px wide, constrained to 200–600 CSS px, and resized by dragging its separator or pressing the
arrow keys with that separator focused. Double-clicking the separator restores the default width.
The width survives a reload.

- **Goal** lists the goal workspace surfaces, a **Skills** entry that discloses every prepared
  skill, the pending ADR records (title, status, next marker, file), and the lifecycle lanes. The
  ADR records group is absent while no record is pending.
- **Flow** lists the workspace surfaces — overview, decision board, steering, and history — the
  session and PR state, widgets, changed files, checkpoints, and blockers. The overview entry
  carries the goal's `unsaved` marker. Blockers open the overview at the blocker they name.
- **Discover** lists the overview and glossary sections, the five skills under their own group,
  and warnings only while at least one exists. The glossary entry carries the published term
  count. A skill carries a `generated` state silently and shows `edited` or `missing` as trailing
  meta, so an exception is visible before the page opens. The Glossary entry is a plain section
  link: it has no disclosure control and no nested per-term menu. An unsaved skill edit belongs
  to the project it was written against: switching to another retained project shows that
  project's own text, and saving there never writes the earlier project's draft.

Selecting an entry opens or focuses its workspace surface. Informational entries open the
surface that holds the same facts. The Flow overview opens with the flow-goal editor, which takes
the full page height; while a goal interview is running the editor collapses to its header and the
interview takes the next block. The overview ends with the implementation activity console, which
also takes a full page height so agent output never shrinks to a thumbnail.

### Workspace page

Each mode shows exactly one page at a time and renders no tab strip. Opening an ADR, a Flow
widget, changed file, or checkpoint, or a Discover skill replaces the visible page; the previous
selection is reachable again from the sidebar or the palette. Close controls inside a page return
to an empty page, and a dirty page closes only after the confirmation dialog restores or discards
the draft.

A reload restores the active mode, each mode's open page, sidebar and split sizes, and theme. All
of that state lives in `localStorage`; none of it is sent to the server.

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
detail page without navigating away. Body and table text is 12–14 CSS px, paths, code, diffs,
terminal output, and IDs are monospace, one-line data rows are at most 32 CSS px tall, and wrapped
data rows stay within 120 CSS px. The shell uses
the full viewport with no application max-width.

### Editors and terminals

Monaco Editor provides the Goal document (`goal-text`), Flow goal (`flow-goal-text`), Flow
decision board (`flow-decisions`), and Discover skill editor (`discover-skill-text`). Each
supports multiline Markdown or plain-text editing, its Save control, Ctrl/Cmd+S, a dirty marker,
and an accessible label; a save sends the editor's exact text. The Goal document page fills the
workspace: the editor takes every remaining pixel and the Revision guidance field is a tall
multiline text area pinned to the page bottom. Flow diffs remain rendered by
`diff2html`; the client never parses unified diff hunks.

xterm.js renders read-only agent output for Goal current activity and history, lane current
activity and history, Flow goal creation, implementation activity, conversation activity, and
Discover activity. Terminals preserve ANSI output, are selectable and copyable, auto-scroll
unless the developer scrolls away, keep a bounded scrollback, and expose their full buffer to
assistive technology.

### Notifications and status bar

Server errors and notices appear in the notification region (`data-testid="notifications"`) with
severity, text, and dismissal, and remain in a history opened from the status bar. Every error and
warning card also carries `File issue`: it files that notification's text and card context as a UI
issue through `/api/feedback` at once, then replaces itself with the issue URL. Notifications
never replace mode content or steal focus, and several arrivals are all retained. Flow blockers
and verification results also remain in their mode context.

The 26px status bar is two groups. The left group states the WebSocket connection, the
project's own name (the last path segment, with a folder mark and the full path in its tooltip),
and the Providers control: the selected provider with the lowest remaining percentage, or
`No provider`, which opens the Providers dialog. The right group states the running lane count,
the issues worker
state with a state dot, the watchdog's last action and age, and the running and installed
versions; each metric carries a 10px uppercase label so its meaning never rests on color. When
`versionState.stale` is true it shows the existing reload control (`reload-devboard`), whose
accessible name and title name both versions; reload behavior is unchanged. A mode states its
status in its sidebar and workspace, never a second time in the status bar, except the issues
worker, which is detached from every dashboard and reports through `issues-indicator`. The theme
toggle and the notification indicator live in the activity bar's action group, not the status
bar.

### Verifying the interface

```bash
cd .devboard
bun run verify:interface
```

The script builds the client, seeds a fixture host under `.devboard/.tmp` with eight ADRs and
real Discover artifacts produced by the stub ACP peer, starts a source dashboard, launches
headless Chrome with a profile under the same tree, and asserts the shell, modes, sidebar,
pages, splits, palette, shortcuts, theme and first paint, layout persistence and reset, the
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
- Records: read from `adrs/` through adrkit on every `listRecords` command and after every run, so
  files added, removed, or resolved while the server runs appear without a restart. Only records
  adrkit accepts are listed. Each record carries the first paragraph of its `Decision` section as
  a short summary.
- State: the dashboard's server-owned state is written atomically to
  `<stateDir>/state/<24-hex hash of REPO_DIR>.json` (default `stateDir` is `<harness>/.tmp`), so it
  survives a backend restart without leaking between repositories that share one harness install.
  See [Durable state](#durable-state).

## Install

The harness is the public npm package `@dsdenes/devboard`. One tarball carries the launcher, the
server, the client sources and built bundle, the prompts, the omp wrappers and extensions, the
templates, and the installer. `install`, `update`, and the running dashboard resolve versions and
artifacts from npm; no local checkout, running dashboard, or release tarball is required. When npm
cannot resolve or serve the artifact and `DEVBOARD_GITEA_URL` is configured, the canonical Gitea
release tarball and its `.sha256` are used for the same version. GitHub carries only a push mirror
of this repository.

```bash
npx @dsdenes/devboard install    # install or refresh this host
npx @dsdenes/devboard update     # install the newest npm version; do not restart
npx @dsdenes/devboard doctor     # one PASS or FAIL line per check
```

The launcher never discovers, reads, copies, or waits on another local Devboard installation or
source checkout; it resolves the npm version and artifact for the target host alone.

`install` writes a real npm prefix at `<host>/.devboard`, replacing `.devboard`,
`.omp/commands`, and `.omp/extensions` symlinks with real directories that hold the installed
package's files. It keeps `.devboard/.tmp`, copies `templates/host-AGENTS.md` to
`<host>/AGENTS.md` when that file is a symlink or absent (an existing regular file is untouched
and reported as drift), adds the three ignored paths to `.gitignore`, and leaves exactly one
dashboard running from the installed package. A reinstall keeps the version and `.tmp`; `update`
never starts, stops, or restarts the dashboard.

`doctor` checks Node 20+, Bun, npm, the git root, npm's version and artifact metadata (or the
configured Gitea fallback and its digest), the installed package, the installed version against
the newest version, `omp` and its authenticated probe, wrapper byte-equality, `AGENTS.md`, the
dashboard's package and HTTP response, a non-symlinked `.devboard`, and a recorded update failure.
Drift in a regular `AGENTS.md` is reported without failing the check; every other mismatch exits
nonzero. Gitea is never required: with no address configured the checks consult npm only.

`--host <path>` targets another repository. `DEVBOARD_RELEASE_DIR` points the launcher and the
server at a local directory of tarballs for offline verification and CI fixtures. `DEVBOARD_NPM`
selects a different npm executable for those fixtures.

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

### Providers and model selection

Provider authentication is a harness capability, not host settings. Exactly two providers exist:

|Provider|Environment variable|Model|
|---|---|---|
|OpenCode Go|`OPENCODE_API_KEY`|`opencode-go/deepseek-v4.1-flash`|
|OpenRouter|`OPENROUTER_API_KEY`|`openrouter/deepseek/deepseek-v4.1-flash-1017`|

The operator registers keys in the **Providers** dialog, reachable from the status-bar control
(`data-testid="providers-indicator"`) and the `settings.providers` palette command. The dialog
supports add, edit, enable/disable, delete with confirmation, refresh, and save. It shows each
key's masked value, status (`ok`, `near limit`, `exhausted`, `invalid`, `unknown`), every quota
window's remaining fraction, and the last check time.

Credentials live in `<stateDir>/providers/credentials.json` (directory `0700`, file `0600`,
atomic replacement). The file survives a dashboard restart and is never removed by
`bun run cleanup` or the watchdog sweep, however old it is. Generated per-peer agent directories
live beside it under `<stateDir>/providers/agents/<selection-id>/`. No key is ever returned by a
command or event, written to the journal or activity log, or placed in a process's argv; the
only value the interface receives is a mask ending in at most the last four characters. The
durable state file under `<stateDir>/state/` carries no key material.

Usage is read from `https://opencode.ai/zen/go/v1/usage` (`rolling`, `weekly`, and `monthly`
percent used) and `https://openrouter.ai/api/v1/key` (`limit_remaining` and `limit`).
`DEVBOARD_OPENCODE_GO_USAGE_BASE_URL` and `DEVBOARD_OPENROUTER_USAGE_BASE_URL` override the base
URLs for tests and offline verification. On-demand reads fetch a key's usage at most once per
60 seconds unless the operator forces a refresh; while at least one dashboard is connected, the
server forces one refresh and pushes a fresh `providersState` every 60 seconds, so the
status-bar indicator never stays stale. With no client connected the periodic refresh makes no
provider call, and the next client's `getProviders` refreshes first.

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

Every agent process — goal work, lifecycle lanes, Flow, issues, Auto Scout, Ask, Discover, goal
drafts, and skills preparation — starts with `PI_CODING_AGENT_DIR` pointing at a generated
directory under `<stateDir>/providers/agents/`. Its `config.yml` pins `default`, `plan`, `smol`,
`slow`, and `task` to the selected model. A Go selection also sets `retry.modelFallback: true`,
`retry.fallbackOn: any`, and a chain from `opencode-go/*` to the OpenRouter fallback; an
OpenRouter selection sets no chain. Every selection also names `ollama`, `lm-studio`,
`llama.cpp`, and `apple` in `disabledProviders`: OMP discovers those implicit local model
servers on every start, a peer can only run the two catalog providers, and the failed probes
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
ADRS_DIR="<host>/adrs" bun run start
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

`.devboard/omp/mcp.json` declares a stdio MCP server named `adrkit` that runs
`bunx @adrkit/mcp --cwd . --dir adrs`. It answers `tools/list` with `search_decisions`,
`get_decision`, `get_decision_context`, and `list_superseded`.

## Durable state

The dashboard keeps the state that drives the page in one file per host repository and restores
it from a new process after a graceful stop, a launcher restart, or a `SIGKILL`. The file is
`<stateDir>/state/<key>.json`, where `key` is the 24-hex SHA-256 prefix of the resolved
`REPO_DIR` (the same key the journal uses) and `stateDir` is the harness state directory,
`<harness>/.tmp` by default and overridable with `STATE_DIR`. A `STATE_DIR` inside the repository
survives an implementation reset unchanged, and the reset records its path in the checkout's
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
failure restores the exact bytes captured before the original run. A Discover crawl re-spawns
`/discover` against the same host, or re-clones the stored remote project first, with its recorded
activity kept as a prefix. Restored activity is kept and new lines append. A pending lane or foreground question is replayed to every connecting client
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

The activity bar carries four client-only modes, `Goal`, `Issues`, `Flow`, and `Discover`
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
The interview is bounded by `goalTimeoutMs` (120 s by default). `<session-dir>/goal.md` is removed
before each interview, so only a file that interview writes can be accepted. A timeout kills the
peer, discards whatever draft it wrote, and reports `flowGoalStopped` with `completed: false`; the
session's accepted goal is left unchanged, exactly as when the interview writes no goal.
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

Every `git`, `gh`, and `glab` child Flow starts carries the `commandTimeoutMs` bound (60 s by
default), and the forge's credential probe is bounded by the same value. A command that outlives
it is killed and reported as a failed push or forge call: the failure is persisted in `prError`,
the pull-request busy flag is cleared, and a later checkpoint or `retryFlowPr` can sync again
without restarting the server.

After a successful merge the server fast-forwards the host's `main` checkout when it is on `main`
and clean, removes the worktree, and deletes the local and remote branch once the branch tip is an
ancestor of `origin/main`. Whatever it could not remove is reported as a leftover and as one
`error`; the session still records the merge, and the leftover names each path or ref so nothing is
silently abandoned.

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

The Discover mode is the fourth client-only view, opened from the activity bar. It exists for an existing host project: one
read-only crawl produces an evidence-backed project sheet, a UbiLang glossary for each detected
bounded context, and five project-specific Agent Skills that every devboard implementation agent in
that host discovers. Switching to Discover, and switching its pages, sends no WebSocket frame
and starts, stops, resets, or clears nothing; all three views stay mounted, so native details,
scroll state, and focus survive. Discover events render only in this view and never touch Goal
Mode's activity, question, or error state.

The Discover sidebar opens pages for `Overview` and `Glossary` without a group heading. Once
Discover artifacts are published it also lists the five skills `Testing Strategy`,
`Naming Conventions`, `Coding Conventions`, `Architecture & Boundaries`, and `Glossary` under
**Skills** (`data-testid="discover-tab"` with `data-tab` values `overview`, `glossary`,
`testing-strategy`, `naming-conventions`, `coding-conventions`, `architecture-boundaries`, and
`glossary-skill`); with no published artifacts the **Skills** group and its header do not render.
The sidebar has no header, so its first entry is its mode's navigation. The active panel carries
`data-testid="discover-panel"` and the same `data-tab`. While a crawl is active, the `Overview`
entry carries a `running` badge (`data-testid="discover-running"`), matching the Issues overview;
the badge disappears when the run stops.
Warnings appears as its own group with a count only while at least one warning exists; the sidebar
keeps no freshness group and no recent-notice list.

Every Discover page shares one frame: an optional uppercase eyebrow, one `h1`, a subtitle, an
optional meta row, and a right-aligned action group. The Overview frame holds the repository as
`owner/name` from its GitHub remote (falling back to the directory name when no remote names one;
the full path stays in the tooltip), the discovery date, and the single
filled run action. Staleness is not repeated on the sheet: the activity bar and the status bar
report it. While a run exists, every Discover page carries a run tag above its notice stack: a
status dot, `Discover run in progress`, the age, the run identifier as a code chip, the latest
activity line, and Stop. The tag is the only run surface: the Overview frame adds no second run
panel and no separate activity terminal. A queued question region follows while a question waits.
The sheet follows: Platform, Delivery, and Stack in a bounded rail on the left, Commands and
Testing in the main column on the right, and Bounded contexts below them. The manual-testing strip
is the last region of the page, so a source checkout never pushes it above the project identity. An
error, an interrupted-run notice, and a stop notice render above the page in one notice stack.

The Glossary row is a plain section link: it has no disclosure control and no nested submenu, so
individual terms are never repeated as sidebar menu items. A term opens from its row on the
Glossary page.

With no published artifacts the Overview page shows the header's first-run explanation and a
`Discover project` button (`data-testid="discover-start"`); with artifacts it shows `Re-discover`.
The button is disabled when the socket is not open, while a Discover run is active,
or while Goal or Flow work is active, and its title names the reason. It never starts on page
load, reconnect, mode switch, or page switch. Selecting it sends `{ "type": "discoverProject" }`;
the server broadcasts `discoverStarted` and starts exactly one ACP peer whose prompt is exactly
`/discover <staging-dir>`, whose working directory is the active target root, and whose staging
directory is `<target>/.omp/discover/staging/<run-id>/`. A second start while one runs is refused
with one `discoverError` and spawns no peer. A start requires no `GOAL.md`, no prepared skill, a
clean tree, or a forge account; it is accepted on a host with a dirty tree and no goal document.

The run is server-owned: closing the browser or switching views does not stop it. The view shows
the run tag (`data-testid="discover-run-tag"`) while a run is active, and a reconnect receives
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
a non-empty `reason`) for tooling, but the Glossary page does not use them. `getDiscover` asks for
the current snapshot and is answered with `discoverState`. The server
broadcasts `discoverState`, `discoverStarted`, `discoverActivity`, `discoverQuestion`,
`discoverStopped`, and `discoverError`; it never sends `activity`, `question`, `error`,
`runStarted`, or `runStopped` for Discover. `discoverState` carries the active and interrupt flags,
staleness, warnings, the busy reason, the last read error, the manifest, freshness, sheet,
repository links for installed packages, glossaries, per-concept usage and examples measured from
the host's documentation and source, `glossarySignificance` keyed by bounded context and then
concept id with `{ score, reason }` values, decisions, and the five skills with baseline text, live
text, hashes, and state.
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
`.omp/discover/decisions.json`, `.omp/discover/significance.json`,
`.omp/discover/glossary/<bounded-context>.glossary.yaml`,
`.omp/discover/skills/<skill>/SKILL.md` for the generated baselines, and the live, editable
`.omp/skills/<skill>/SKILL.md`. Staging mirrors the crawl's relative layout without `manifest.json`
or `decisions.json`, and the staged sheet omits freshness. The manifest carries a schema version,
the discovery fingerprint, the publication time, the run id, the sheet's structural digest, one
structural digest per glossary, the five skill names, each live skill's baseline and current hash,
each skill's edited or missing state, and artifact paths relative to the host; it contains no
secrets and no absolute path. A manifest written by this code carries
`paths.significance: ".omp/discover/significance.json"`; a manifest without that path predates the
significance sidecar and is read as legacy, with no error.

`sheet.json` is the canonical data sheet, with top-level keys in the fixed order `schemaVersion`,
`definition`, `stack`, `deployment`, `environments`, `commands`, `branching`, `testing`,
`architecture`, `ci`, `runtime`, `dependencyMap`, and `delivery`. It has a freshness header naming
the project, the short commit, the dirty flag, the discovery time, and the stored fingerprint. The
Overview page is a project sheet, not a card grid. A masthead
(`data-testid="discover-freshness"`) carries the project name and the
discovery date. The commit, the dirty flag, and the staleness flag stay in the sheet and the state
payload but render no header badge. Below the masthead the sheet is one bounded two-column spine:
`Platform`, `Delivery`, and `Stack` in a left rail, and Commands, Testing, Quality gates, and
Bounded contexts in the main column on the right. Every section carries
`data-testid="discover-card"` and `data-field`; the commands, testing, and quality-gate panels are
raised surfaces and the remaining sections are flat, separated by hairlines. Below 1240px viewport
the columns collapse into one in reading order.
Tables grow with the page; neither a panel nor a card shrinks below its rows, and none scrolls
inside the page. Every non-`unknown` leaf
carries at least one sorted, unique repository-relative evidence path, symbol anchor, or safe git
fact and a confidence of `observed`, `declared`, `inferred`, or `unknown`; `unknown` carries empty
evidence and a short reason. Confidence labels, evidence paths, the `Not observed` ledger, the
repeated dependency map, and the static lead and note prose are not rendered; the stored facts and
the sheet's confidence and evidence stay unchanged. The definition is exactly one sentence of at
most 240 characters; every value and list entry is a single line of at most 160 characters. The
sheet covers the short platform stack (languages, runtimes, package managers, frameworks, and
major tools, not individual dependencies), customer-facing deployment (artifact class, artifact,
target, and pipeline sources), every environment (at least `production`, whose purpose states how
changes reach it), exact main commands (with `unknown` for an unobserved command), branching
strategy and model, test levels and pyramid, architecture contexts and their directed dependencies
plus boundaries, CI provider, triggers, jobs, and quality gates, and the three mandatory sections:
runtime inventory, entry-point and dependency map, and delivery and versioning. It never guesses,
invents an additional environment, copies README prose, or records a configuration value; a claim
it cannot ground is `unknown`.

Main commands render as a two-column `Task`/`Command` table of the observed commands, `$`-prefixed,
with no header row, under an `N of 8 commands found` count. That count is a disclosure
(`data-testid="discover-command-coverage"`): activating it lists every one of the eight command
slots, and a slot the crawl did not find renders a muted `not found` placeholder whose title
carries the unknown reason. A `tryOut` command is listed only when it is a hands-on entry point
that no other recorded command aliases. A command the host manifest declares as a script is shown
as its invocation — `npm test` for `scripts.test`, `npm run <name>` for any other script — instead
of the program the script expands to; the recorded program is the chip's tooltip. Every command,
path, package, and boundary value uses the same inline code chip (`.code-chip`); no surface has a
second inline-code presentation. Testing shows the test, level, and
happy-path totals and the whole-suite command (`data-testid="discover-suite-command"`), then a
`Level`/`Tests`/`Happy path`/`Command` table (`data-testid="discover-pyramid"`). Happy path is the
part of a level's count that exercises the primary success path, recorded as an exact count from
`0` to the level's total; the summary percentage appears only when every listed level reports one.
`Command` is the narrowest declared invocation for that level. Only a level that carries a test is
listed and counted; a recorded level with no test case is omitted, so a sheet cannot claim a
second level while its table holds none. Every listed level states an exact test count, never
`count unknown`. No pyramid graphic is drawn. Quality gates render as a `Quality gate`/`What it
checks` table (`data-testid="discover-quality-gates"`): one row per required CI gate, its name, and
one short line saying what it verifies. A gate recorded without a check states `No check was
recorded.`, and the gates are not repeated among the Delivery facts. Runtime, deployment, CI, and
branching use compact `dt`/`dd` facts whose list values are comma-separated.
Architecture renders under the heading `Bounded contexts` as context rows showing the name,
responsibility, and entry points, followed by external-boundary and shared-kernel chips and a
rendered Mermaid dependency graph. The repository path of a bounded context is not rendered. The
graph draws one node per bounded context and one arrow for every `architecture.dependencies` edge,
pointing from the context that depends to the context it reaches; it is drawn with `flowchart LR`
through Mermaid at render time, and a sheet without recorded edges draws no graph.
External boundaries name only external systems — a remote API or service, a message broker, a
database, or an identity provider the host integrates with across its own process and artifact.
Language and runtime built-ins describe internal architecture, so `node:child_process`,
`node:worker_threads`, and other concurrency primitives are never boundaries; a host that integrates
with no external system shows `None detected.` in that block instead of an invented entry or
`unknown`.
`Stack` renders one full-width chip band after the two columns; a chip whose package is installed
under `node_modules/` becomes a link to the repository its manifest declares, and every other chip
stays plain text. Environments is `unknown` here and is not listed. The delivery section, the
deployment pipeline sources, and the runtime `versions` fact stay hidden because they repeat other
facts. A sheet with no observed test level and a glossary with no matching term keep an explicit
empty state.

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

A successful run publishes exactly five skills under `.omp/skills/`: `discover-testing-strategy`,
`discover-naming-conventions`, `discover-coding-conventions`,
`discover-architecture-boundaries`, and `discover-glossary`. Each is a directory containing
`SKILL.md` whose frontmatter has `name` equal to the directory, a non-empty `description` of at most
1024 characters, `metadata.devboard-managed: "true"`, `metadata.devboard-family: "discover"`, and
`metadata.devboard-skill` naming its role. The bodies are project-specific and directive: one
imperative bullet per rule, and no bullet names a source, test, manifest, or CI path — an exact
command may still contain one. A bullet never says where a rule was observed: no evidence clause,
file name, directory name, or path outside an exact command, so the skill carries policy and the
sheet carries provenance. Testing strategy states levels, pyramid, commands, fixture roles,
coverage expectations, and how to add a test; naming conventions state canonical terms, casing, and
rejected aliases; coding conventions state patterns, error handling, typing, async, logging,
dependencies, formatting, and prohibited constructs; architecture and boundaries state contexts,
entry points, dependency direction, persistence, integrations, and prohibited cross-boundary
imports; the glossary skill names the canonical glossary directory, the confirmed and rejected
rules, and the proposal process. From the host
root, a new `omp` session lists the five (`omp skill list`) and loads their bodies as skills, so
every implementation agent in that host discovers the set with no extra configuration.

Each skill has a page that is one full-height Monaco Markdown editor for the whole `SKILL.md`
(`data-testid="discover-skill-text"`), with no rendered preview and no split pane. The page header
holds only the skill's page title. The editor panel header names the skill's relative path,
`<skill>/SKILL.md`, with the skill name emphasized and the file name muted; a second 11px line
states the draft (`No unsaved changes`, `Unsaved changes`, or `Live file missing`). The header
also holds `discover-skill-save`, disabled until the draft differs from the live text, and, while
the live text differs from the generated version or the file is missing,
`discover-skill-restore`. A `discover-skill-dirty` marker replaces the clean state line while the
draft has unsaved changes; the page renders no state badge and no purpose line, because the
sidebar already flags `edited` or `missing`.
`saveDiscoverSkill` writes the submitted bytes verbatim and updates the manifest's current hash and
edited state; it is refused with one
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
panel lists both families with their family and Discover state, and every prepare-family row
carries a Delete control that confirms before removing that one skill. Prepare Skills replaces only its
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
`.omp/discover/`, `.omp/skills/`, VCS internals, and ignored files. Only regular files are read:
a symlink contributes its target string and a FIFO, device, socket, or other special entry a type
marker, so the fingerprint never opens one; a regular file's content streams through the hash in
fixed-size chunks, so a large file cannot exhaust memory. Each digest and the aggregate are cached
by the file listing plus size, timestamps, and inode, so an unchanged host is not re-read and a
reconnect or refresh costs no file reads. The manifest stores the fingerprint, and `stale` is true
only when the current fingerprint is readable and differs. The cache holds digests only; every
accepted start re-crawls.

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
and an immediate restart ends the recorded child before it can publish. The replacement re-spawns
the crawl against the same target with a fresh staging directory, so nothing from the killed crawl
is published but the run itself survives the restart.
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
`a/b-c` and `a-b/c` — always get different directories. Each directory keeps the bytes the crawl
published — `.omp/discover/` and `.omp/skills/` — beside `project.json`, which records `url`,
`owner`, `repo`, and the ISO `completedAt` time. A run's checkout is a transient
`.staging-<run-id>` directory beside those projects; it never survives the run. While a run is live
it owns a claim at `.runs/<checkout-name>.json` naming its process, and the claim and the `.runs/`
directory leave with the checkout.

A submit broadcasts `discoverState` with `cloning = { url }` before spawning anything, then runs
exactly one child: `git clone --depth 1 --single-branch --no-tags -- <url> .staging-<run-id>` with
the retained root as its working directory, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`,
`NO_COLOR=1`, and a 300-second timeout. On success the checkout becomes the crawl root and exactly
one crawl runs against it. Publication writes into the checkout's `.omp`; when the crawl succeeds,
the two published trees are copied into `<owner>~<repo>/`, `project.json` is rewritten with the
submitted URL and the completion time, and the checkout is removed. The active target moves to the
new project only after its bytes are retained, so a failed clone or a failed crawl leaves the
previous target, its bytes, its entry, and its completion time untouched and reports exactly one
`discoverError`. A second `discoverRemote`, `discoverProject`, `switchDiscoverRemote`,
`removeDiscoverRemote`, or `clearDiscoverRemote` while `cloning` is non-null is refused with one
`discoverError`, as it is while a Discover run or other Goal/Flow work is active. A clone is never
resumed.

With a remote target every Discover read and write uses the retained directory: the Overview,
staleness, warnings, skill saves and restores, glossary decisions, and the manifest all come from
`<owner>~<repo>/.omp`. A crawl is the only path that needs a checkout; starting Discover on a
retained target — `discoverProject`, or `discoverRemote` with its URL — first clones the project
again, runs exactly one crawl, replaces the snapshot on success, and removes the checkout. Remote
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
it only while `<owner>~<repo>` holds a readable `project.json` and both `.omp` trees, without a
clone or a re-crawl; otherwise it starts on the host target, drops that one stored target, keeps
every other retained entry, and sends one `discoverError` naming the missing project to the next
client. Startup removes every `.staging-*` directory and any leftover directory containing `.git`
before a recorded run resumes, so the resumed crawl starts from a fresh checkout. The one exception
is a transient another live dashboard still claims: two dashboards may serve the same repository
with one `STATE_DIR`, and a starting dashboard never deletes a checkout a running one owns. A
restart during a remote crawl ends the recorded child and keeps its retained snapshot; the
replacement re-clones the project the stored run named — not whichever target is displayed — runs
one crawl, and replaces the snapshot only on success. A stopped dashboard removes its own checkout
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

While `remoteAvailable` is true the Overview renders a target strip as its first region, above the
project header and the sheet or the empty state: a retained-project dropdown
(`data-testid="discover-remote-select"`) whose options are the retained URLs, newest first, with the
active project selected and no host option; one row per retained project with a remove control
(`data-testid="discover-remote-remove"`, carrying the URL in `data-url`); an input
(`data-testid="discover-remote-url"`) labelled for a GitHub repository URL with the placeholder
`https://github.com/owner/repo`; a submit control (`data-testid="discover-remote-start"`) labelled
`Discover from URL`; and a clear control (`data-testid="discover-remote-clear"`) only while the
target is remote. The strip is secondary in weight yet first in reading order, so an operator sees
the active target before anything it affects. A source checkout with nothing published still learns
the gate: the server replays one `discoverState` on connect when `remoteAvailable` is true, even
with no artifacts and no run. The submit control is disabled while the socket is closed, `cloning`
is non-null, a run is active, or `discoverState.busy` is set, and its `title` names the reason; it
is also disabled for empty or whitespace-only input. Submitting sends exactly one frame with the
trimmed URL and starts nothing else; selecting an option sends exactly one `switchDiscoverRemote`
and starts nothing else; removing sends exactly one `removeDiscoverRemote`; clearing sends exactly
one `clearDiscoverRemote`. Rendering the strip on load, reconnect, mode switch, or page switch sends
no frame. While cloning, the strip shows the cloning URL and the activity area shows no run; errors
reach the Discover error and notification surfaces only.

`server/discover-remote.test.ts` proves retention after a successful crawl with the checkout
removed, restore and rendering without a clone, newest-first ordering and one entry per lowercased
`owner/repo`, switching with zero clone invocations across a restart, one clone and one crawl on
re-discovery, unchanged bytes after a failed clone or crawl, clear keeping every project, removal
of exactly one directory with a restart, busy refusals, the missing-retained-directory fallback, the
gate refusing every remote command without touching the retained root, a byte-identical host
`.omp`, and startup hygiene that keeps a live run's checkout when a second dashboard starts on the
same state directory. `verify:interface` drives the built UI through a retained render after
restart, the dropdown's two entries and selection, removal of one entry, and the gate-off host with
no remote control.

Operator smoke procedure, which needs network and a model endpoint and is therefore not a pass gate:

```bash
cd .devboard
ADRS_DIR=../adrs REPO_DIR=.. bun run start
```

Open Discover, enter `https://github.com/octocat/Hello-World`, and confirm the cloning state, a
completed crawl, the checkout gone from `.devboard/.tmp/discover-remote/`, the retained project at
`.devboard/.tmp/discover-remote/octocat~hello-world/` with its `.omp/discover`, `.omp/skills`, and
`project.json`, its sheet and glossaries, and a skill save landing under the retained
`.omp/skills/`.
Restart the server, reload, and confirm the same project is active with its artifacts and no
missing-clone error. Discover a second repository, switch between the two from the dropdown, and
confirm no clone appears. Remove one entry and confirm only its directory disappears. Hash `.omp`
from the repository root before and after; the two hashes match.

## Publish a change

Merging into `main` and pushing to the canonical Gitea remote triggers
`.gitea/workflows/devboard-release.yml`, which runs on the repository's registered Gitea
`act_runner` — never a hosted runner, and never a fallback — and builds the client, runs the
harness suite and typecheck, packs the complete public package, publishes
`@dsdenes/devboard@<version>` to npmjs, and creates the Gitea release `v<version>` with notes and
the same tarball plus its `.sha256` as a fallback. The version is `0.1.<commit-count>` over the
full history; a rerun on the same commit leaves the existing npm version and release assets
untouched. Nothing is published under `@dsdenes/devboard-harness`.

A release takes the `latest` dist-tag only when its version is newer than every version already
published; otherwise it publishes under the `next` tag. npm refuses to move `latest` backwards,
so this keeps an out-of-order release publishable without rewriting the tag. A runner that
executes release jobs concurrently must also point `DEVBOARD_RELEASE_LOCK` at a path its jobs
share: the release step then serialises the npm publish and release creation through that lock,
so the next job sees the previous version before it chooses its tag. Without the variable the
step is unchanged and assumes one release at a time.

After the push, verify from the integration checkout:

```bash
cd .devboard
bun run publish
```

`bun run publish` refuses a worktree, a branch other than `main`, or a checkout ahead of or
diverged from its canonical remote; fetches and fast-forwards `main` without discarding
uncommitted work; installs dependencies and rebuilds `dist/`; waits for the release workflow of
`HEAD`; verifies the Gitea release assets and `npm view @dsdenes/devboard@<version> version`;
pushes the `github` mirror remote's `main` and the release tags, then proves `main` is the
published commit or a descendant that still contains it (another agent may merge while the
release workflow runs); and reports every running dashboard's running and installed version. It never
restarts a dashboard and never writes into a host. `--wait-timeout N` bounds the workflow and
propagation wait (default 1800 seconds).

Installed dashboards update themselves: each checks the newest npm version at startup and every
60,000 ms (`DEVBOARD_UPDATE_INTERVAL_MS` overrides it), installs the npm artifact through a
staging prefix, and keeps serving its loaded code. If npm cannot serve the artifact and
`DEVBOARD_GITEA_URL` is configured, the same version's Gitea tarball is verified against its
`.sha256` and installed instead. The npm child always runs in
that staging directory, and the dashboard starts from the host root rather than the replaceable
package directory, so replacing the package never leaves a child with a deleted working
directory. `versionState` reports `running`, `installed`, `latest`, and `stale`; the reload
control appears while `stale` is true and restarts the server from the installed package. A
dashboard serving the canonical source checkout reports `0.1.<commit-count>` on both sides, the
version its `main` commit releases as, rather than the checked-in `0.1.0` placeholder.

A check that cannot use the feed — an offline host, an unreachable Gitea API, a DNS or proxy
failure, a refused or reset connection, a timeout, an API rate limit, or an answer that is not a
readable release description (a proxy page, a truncated body, an unexpected payload) — leaves the
previous package and server intact, writes an `activity` record naming the skipped check, and
retries with exponential backoff (`DEVBOARD_UPDATE_BACKOFF_MAX_MS` caps it); it is context for
the operator, never an `update-error` finding. A registry that advertises a version but does not
serve that version's own tarball yet (npm answers 404 or 410) is the same kind of external,
temporary refusal: the install is skipped with an `activity` record and retried with the backoff.
A check that reaches the feed and fails, a release without a tag, a missing dependency tarball, a
checksum mismatch, an authentication failure, or any other failed npm install writes `update-error`
and is retried the same way.

|Variable|Default|Purpose|
|---|---|---|
|`HOST`|`127.0.0.1`|Listen address.|
|`PORT`|`8080`|Listen port.|
|`DEVBOARD_ALLOWED_HOSTS`|unset|Comma-separated extra hostnames the dashboard serves in a Host header. A wildcard bind (`0.0.0.0` or `::`) serves only loopback aliases unless names are listed; a reverse proxy's public name belongs here.|
|`ADRS_DIR`|`/repo/adrs`|Directory holding the ADR files.|
|`REPO_DIR`|parent of `ADRS_DIR`|Agent working directory and default goal location.|
|`GOAL_FILE`|`<REPO_DIR>/GOAL.md`|Goal document read on load and replaced on save.|
|`STATIC_DIR`|`dist`|Built client directory.|
|`AGENT_COMMAND`|`omp acp`|ACP peer command, split on whitespace. `server/fixtures/stub-agent.ts` is a deterministic substitute for tests and local verification.|
|`STATE_DIR`|`<harness>/.tmp`|State and journal directory; an installed dashboard passes `<host>/.devboard/.tmp`. An in-repo path survives a reset and is excluded from its commit; the repository root is refused.|
|`DEVBOARD_OPENCODE_GO_USAGE_BASE_URL`|`https://opencode.ai/zen/go`|OpenCode Go usage base; overridden by tests and offline verification.|
|`DEVBOARD_OPENROUTER_USAGE_BASE_URL`|`https://openrouter.ai/api`|OpenRouter usage base; overridden by tests and offline verification.|
|`DEVBOARD_UPDATE_INTERVAL_MS`|`60000`|Automatic update check interval.|
|`DEVBOARD_UPDATE_BACKOFF_MAX_MS`|`3600000`|Ceiling for the exponential retry delay after a failed check or install.|
|`DEVBOARD_RELEASE_DIR`|unset|Local release directory for offline verification; unset reads the newest Gitea release over the public HTTP API.|
|`DEVBOARD_RELEASE_LOCK`|unset|Lock path shared by a runner's jobs; the release step serialises its npm publish and release creation through it. Set it when one runner executes releases concurrently.|
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

Auto Scout and Watchdog are the first two instances of one background-agent contract. A typed
registry in `server/agents/registry.ts` declares each descriptor's id, label, description, scope,
lifecycle vocabulary, cadence field and defaults, nullable limits schema, start/stop commands,
issue projection, sync projection, and detail panel. The shared page, the shared filed-issues
table, and the Issues sidebar are built from that registry; adding a third continuous agent means
writing its engine, its adapter, and one registry entry.

Both agents publish the same lifecycle: `stopped`, `starting`, `running`, `stopping`, `failed`.
`starting` appears before a spawned worker exists, `running` once its state is readable, and
`stopping` from the moment Stop is accepted until the worker exits. A stopped agent is never
restarted by a dashboard restart, a page open, or a tab restore. A live worker owned by another
dashboard's `STATE_DIR` reads `running` with `owned: false`; that dashboard cannot Stop it, and
Start is a no-op with a notice.

Both pages share `data-testid="agent-page"` and `data-agent`, the header `agent-header`, the
lifecycle badge `agent-lifecycle`, the sync badge `agent-sync`, `agent-sync-at`,
`agent-last-run`, `agent-next-run`, exactly one of `agent-start`/`agent-stop`, `agent-cadence`,
`agent-save-cadence`, `agent-limit-hour`, `agent-limit-pending`, `agent-save-limits`,
`agent-issues-count`, `agent-issues`, and `agent-detail`. Alerts use one position:
`agent-error`, `agent-sync-error`, `agent-cadence-error`, and `agent-limits-error`, each with
`role="alert"`. Start/Stop is the only filled primary control. The header row carries the page
identity, the lifecycle badge, the sync badge with its last-read clock, and Start/Stop. Its
settings footer carries two labeled groups: `Cadence` (the Every field, the last-run and next-run
clocks, and Save cadence) and `Filing limits` (Per hour, Open issues, and Save limits); the groups
wrap as units, so no field separates from its save control. The sidebar has three groups in
order: `Issues surfaces` (Overview), `Background agents`
(`data-testid="sidebar-background-agents"`, heading `Background agents`, entries
`open-issues-scout` then `open-issues-watchdog`, badges `agent-state-<id>`, counts
`agent-count-<id>`), and `Issues work` (Issues, Draft goals).

### Transport

Browser-to-backend state and controls use the WebSocket from
`adrs/0003-browser-server-transport-and-api.md`. Commands are `getAgents`, `getAgent`,
`startAgent`, `stopAgent`, `setAgentLimits`, `setAgentCadence`, and the timer gate's
`disableAgentTimer`; each carries `id`. The prompt surface adds `getAgentPrompt`,
`saveAgentPrompt`, and `sendAgentPromptChat`, each carrying `id`. The server answers `agentsState`
(both agents), `agentState` (one), `agentPromptState` (one agent's prompt section), streams Auto
Scout activity as `agentActivity`, streams one prompt chat as `agentPromptChat`, and refuses an
unknown id with an error naming it before spawning anything. `scoutState`, `scoutActivity`, `startScout`,
`stopScout`, `setScoutLimits`, and `GET /api/watchdog` are gone. The footer indicator still reads
the same Watchdog snapshot through the agent store.

### Prompt

Directly below `agent-header`, before the alert region and `agent-main`, every background-agent
page renders one prompt section `data-testid="agent-prompt"`. It is a read-only view in an
installed host and never writes on a page open, tab restore, reconnect, or reload.

The Auto Scout section contains:

- `agent-prompt-command`, the invocation the worker passes:
  `/scout-recommendations <REPO_DIR>/.devboard/.tmp/scout/scans/<scan-id>`.
- `agent-prompt-text`, the complete bytes of the effective prompt file
  `<REPO_DIR>/.devboard/prompts/scout-recommendations.md`, character for character, in a
  scrollable monospace region with no truncation, ellipsis, or reformatting.
- `agent-prompt-request`, the request the next scan would write, as formatted JSON with the
  `buildRequest` keys `version`, `scanId`, `repository`, `repositoryPath`, `requested`,
  `categories`, `excludedRoots`, `knownTitles`, `draftGoalHeadings`, `significanceThreshold`, and
  `createdAt`. `requested` comes from the persisted limits and the current board's capacity;
  `knownTitles` merges the Auto Scout rows, every open issue title, and the draft goal headings;
  `draftGoalHeadings` comes from `.devboard/goal-proposals/`; `repositoryPath` is the running
  `REPO_DIR`. `scanId` and `createdAt` are `null` because the worker assigns them when the scan
  starts; every other value equals the `request.json` that scan writes.

The Watchdog section contains `agent-prompt-absent`, naming that Watchdog runs no agent and has no
prompt, and no other prompt test id. A prompt command for `watchdog` is refused with that same
statement and has no effect.

When `isHarnessSourceCheckout(REPO_DIR)` is true, the Auto Scout section also renders
`agent-prompt-editor` (initialized from the file's bytes), `agent-prompt-chat` with
`agent-prompt-chat-log`, `agent-prompt-message`, and `agent-prompt-send`, and
`agent-prompt-save`/`agent-prompt-reset`. In every other host those four controls are absent and
`saveAgentPrompt` or `sendAgentPromptChat` is refused with an error naming that the action requires
a harness source checkout; no file changes.

`agent-prompt-save` writes the editor's exact UTF-8 text to
`.devboard/prompts/scout-recommendations.md` under the served checkout, adds nothing, strips
nothing, and writes no other file; success shows `agent-prompt-notice` and a refreshed
`agent-prompt-text`, and failure shows `agent-prompt-error` with the file unchanged. Only that
click writes the file. `agent-prompt-reset` discards unsaved editor text and restores the current
file bytes without writing. A chat turn posts over the WebSocket, streams the reply into
`agent-prompt-chat-log`, and puts a proposed complete prompt in the editor without any copy; it
writes no file, creates no scan, files no issue, and changes no Auto Scout state. A failed turn
shows `agent-prompt-chat-error` and leaves the editor and file untouched. The chat agent reads
`prompts/agent-prompt-chat.md` and returns the replacement between the line-anchored `<prompt-file>` and `</prompt-file>` markers,
so Markdown fences inside the prompt survive intact.

### Cadence and limits

`agent-cadence` accepts an integer from 1 through 1440 minutes; `agent-save-cadence` persists it
atomically and a running worker applies it without restart. Auto Scout defaults to 1 minute and
never starts a scan sooner than the interval after the previous scan start; Watchdog defaults to
10 minutes, starts its first cycle immediately on Start, and uses the interval as its evidence
window. `agent-last-run` and `agent-next-run` show both.

`agent-limit-hour` and `agent-limit-pending` are empty (unlimited) or an integer from 1 through
100; an empty field never renders as `0`. Auto Scout defaults to 10 per rolling hour and 5 open;
Watchdog defaults to both empty. The persisted values survive reload and restart and apply to a
running worker. Auto Scout keeps its rolling-hour and open-issue enforcement. Watchdog files at
most the hourly cap of new issues and at most the pending cap of its own open issues, counts open
state from the last successful projection (`projection.json`), keeps excess fingerprints in
`pendingFiling` instead of dropping them, files nothing new while a cap is set and the projection
is not `ok`, and never caps comments. With both caps empty its cycle behaves exactly as before.

### Filed issues

Both pages render one `agent-issues` table with columns Title, Category, Filed, State, Shipped.
Rows are `agent-issue` with `data-url`, `data-state`, and `data-version`, sorted by `filedAt`
descending and then URL ascending. Cells are `agent-issue-title` (an anchor),
`agent-issue-category`, `agent-issue-filed` (a `<time>`), `agent-issue-state`
(`pending`/`implemented`/`unknown`), and `agent-issue-version` (`—` when absent). With no rows,
`agent-issues-empty` renders the same inbox composition on both pages, naming the agent.
`agent-issues-count` counts the rows. Auto Scout maps its GitHub title and creation time;
Watchdog keeps `[watchdog] <category>: <line>`.

### Detail panels

`agent-detail` is declared by the descriptor. Auto Scout renders `scout-activity`, streamed as
`agentActivity`. Watchdog renders its retained cycle history (`watchdog-cycles`, `watchdog-cycle`,
`watchdog-cycle-at/-window/-action/-findings/-reason`, `watchdog-cycles-empty`), capped at the
newest 100 run directories.

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
already `filed:<url>` is never filed again. No cycle closes an issue.

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
- the run directory of the cycle performing the sweep, and a live `devboard-<pid>.lock`.

- any `lock` file whose content records a live `LockOwner`, such as the checkout-anchored
  `.tmp/scout/lock` a running Auto Scout holds. A lock whose owner is gone is swept, and the
  rest of `.tmp/scout/` — stale scans and issue bodies — follows the ordinary age rule.

Run the sweep by hand from `.devboard`:

```bash
bun run cleanup -- --dry-run --root <root>
bun run cleanup -- --once --root <root>
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
`verify:agents` drives both pages through headless Chrome.

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

The poll is the GitHub issues endpoint through the operator's `gh` credential every 10 seconds,
conditional on the previous `ETag` (`If-None-Match`). A `304` is no change; `403`/`429` honor
`Retry-After` or `X-RateLimit-Reset`. Each read has a 20-second deadline: a stalled `gh` is killed,
the poll records the timeout in `poll.error`, and the next poll runs on schedule instead of
leaving the loop blocked on the abandoned read. Pull requests returned by the endpoint are
excluded, and every issue's labels are part of the poll result. Every open issue in the queue
carries `handled`, the run id that last handled it, and `agentRunId` while an agent works it. An
issue that already has a running agent never receives a second peer, so a poll while four peers
run starts none of them again. An issue first seen while three peers run gets its own peer on the
next poll without pausing, restarting, or shortening the others. A handled issue is never
retriggered while it stays open; a closed issue leaves the ledger, so a reopened one is eligible
again. A poll with no unhandled open issue starts no peer and publishes `idle`.

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
`<REPO_DIR>`. It changes only that issue's implementation, tests, and documentation; it may read
other issues and code but never edits, comments on, closes, or reopens another issue. When the
issue declares an open prerequisite (`depends on`, `blocked by`, or a task-list issue reference),
it writes `blocked: #<prerequisite>` as the first stderr line, exits nonzero, leaves the issue open
and unhandled, and never implements the prerequisite in another agent's place. It is
non-interactive: no `question` tool, no confirmation, no interactive editor, no login prompt. It
fetches the canonical integration line, integrates concurrent changes, resolves every conflict
itself, reruns every check the integration invalidates, and publishes directly to that line with
bounded retry when a push is rejected; it never creates a pull request or merge request and never
force-pushes. It closes the issue only after verifying the pushed revision is on the canonical
line and the required checks pass, and comments on that issue with the revision and the
verification evidence. A proven duplicate, invalid, or already-fixed issue is closed with evidence
and without committing unrelated work. A successful agent removes only the worktree and branch it
created; a failed or blocked agent leaves its worktree in place and reports its path.

The `goal` label keeps its goal-mode implementation contract: every goal-labeled issue runs
`/implement-goal-issue <number>` concurrently with the rest. The command follows the origin's
forge: GitHub reads and closes the issue through `gh` under the forge-auth wrapper, and Gitea
reads it through the API (`GET /api/v1/repos/<owner/repo>/issues/<number>`) and closes it with an
API `PATCH` through the same wrapper. A GitLab goal issue is refused with that reason.

### Per-agent state, lifecycle, and history

Each agent has its own run directory, `run.json`, `activity.json`, first-stderr line, question,
ACP child record, and retry gate keyed by issue number. No agent shares a run record or question
slot with another. The published state carries `agents`, one entry per running issue with `runId`,
`issueNumber`, `startedAt`, `question`, and `acp`; the queue carries each issue's `handled`, last
handling `runId`, and `agentRunId`; and `cooldowns` maps an issue number to its ISO 8601 retry
time. A failed agent finishes its run as `failed` with its first stderr line, leaves its issue
open and unhandled, and writes only its own cooldown. A clean ACP turn is not proof of work: a
refused slash command still ends the turn normally, so before a run can succeed the worker asks the
tracker for that issue's state. Only an issue the tracker now reports closed finishes as
`succeeded`, records only its issue as handled, and does not touch another issue; one that is still
open, or whose state cannot be read, finishes as `failed` with a cooldown and stays unhandled. The
five-minute
cooldown remains: an issue in cooldown is retried when it expires, and other issues keep running
and start normally.

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
cwd so Stop or a fresh Start can terminate a proven orphan. The first worker to find no repo-keyed
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
`data-testid="issues-agents-asking"` naming how many need an answer. With no active agent it
renders `data-testid="issues-agents-empty"` and an `Open Overview` control
`data-testid="issues-agents-overview"` instead of the grid.

The grid `data-testid="issues-agents"` holds one card per running agent, sorted by issue number
ascending. Each card has `data-testid="issues-agent"`, `data-issue`, `data-run`, `data-status`, and
`data-asked` while its agent waits for an answer; its head shows the issue number linked to its
tracker URL and the `Focus` control, and it does not repeat the fleet's status or waiting state as
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
issue URL from the queue in a new tab) next to a control that selects the agent's output.
The running-agent panel header carries an aggregate `data-testid="issues-overview-asking"` warning
badge (`<n> needs answer` or `<n> need answers`) only while at least one agent waits; the fleet
count is not repeated in that header because the Automation panel states it.
Each row also carries `data-testid="issues-close-issue"` with `data-issue`; it closes that issue on
the tracker as `not planned`, so an issue the operator does not want implemented leaves the next
poll without stopping the agent already working it. A refused or failed closure leaves the issue
open and reports the reason as an error notification; a successful one reports
`Closed issue #<number>.` and disables the control until the queue drops the issue.
The right column renders only the selected agent's output in
`data-testid="issues-overview-output"` with `data-run`, its stream in
`data-testid="issues-overview-activity"`, and its question in
`data-testid="issues-overview-question"`. The first agent is selected by default, the row's select
control switches the output, and the pane falls back to the first live agent when the selected run
ends; the overview list selects instead of opening a tab. The queue keeps every open issue, its
`goal` badge, and its handled state, and shows `data-run` and a running marker for an issue with an
active agent. The Runs page lists every run with its status and issue,
and a run's detail shows only that run's activity. The status bar's issues indicator reports the
lifecycle and the running-agent count in its title and still opens Issues mode.

## Draft goals and proposed goals

The Issues sidebar carries `Draft goals` after `Issues`, with `data-command="open.issues.drafts"`
and `data-testid="open-issues-drafts"`. It trails the number of listed drafts, its accessible
name names the Issues mode and the `Alt+2` shortcut, and the command palette lists it under the
same command id. Opening it renders `data-testid="issues-drafts"`: every regular `.md` file
directly under `<REPO_DIR>/.devboard/goal-proposals/`, sorted by filename, each with
`data-testid="issues-draft"` and `data-path` holding the repository-relative path, its filename,
and its first Markdown heading. An empty directory shows `No drafts exist.`.

The list header carries a `New goal` control (`data-testid="issues-draft-new"`,
`data-command="issues.draft.new"`); the command palette lists the same id, opens the Draft goals
page, and opens the popover. Activating the control opens
`data-testid="issues-draft-new-popover"` under the header and writes nothing. The popover holds
one instructions field (`issues-draft-new-input`), a submit control (`issues-draft-new-submit`),
and Cancel (`issues-draft-new-cancel`); Escape and Cancel close it without writing a draft or
starting a peer. One submit posts `{ "report": <instructions> }` with no captured page context to
`POST /api/goal-proposals`, so exactly one draft lands with the heading, the line
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
A row whose elaboration waits for an answer carries `data-question="true"`; answering clears it.
The body reads the proposal before the
`## Captured UI context` marker, then the activity stream in `issues-draft-activity` once a run
exists; the captured UI context itself is not shown. A pending elaboration question
(`issues-draft-question`) renders above the proposal, with `issues-draft-choice`,
`issues-draft-answer-input`, and `issues-draft-answer-submit`. Selecting another draft switches the
detail to that path's own state, activity, and question, and reselecting the first restores its
transcript and still-pending question. The detail refreshes when the page opens, after the report
panel writes a draft through `POST /api/goal-proposals`, after an elaboration finishes or stops,
and when a listed draft disappears. The page polls the list every two seconds while it is mounted,
so an external deletion is visible without a reload, and the report panel's write broadcast
reaches an open page immediately. A browser reload restores the Draft goals page and the selected
path; when the file no longer exists, the page opens the list.

The read path accepts only `.devboard/goal-proposals/<name>.md`: an absolute path, `..`, a nested
path, a directory, a missing file, or a symlink whose real path leaves the drafts directory is
refused with a visible error, and nothing outside the directory is read. The list never follows
symlinks.

Every draft may elaborate at the same time; there is no concurrency cap beyond the repository's
own draft files. Starting a draft spawns exactly one ACP peer with `AGENT_COMMAND` in `REPO_DIR`,
opens one session, and sends exactly `/goal-draft <repository-relative path>`. Each path has at
most one live peer: a start for a path already running is refused with
`This draft is being elaborated.` and starts no second peer. While a draft runs, only its own row
shows the disabled start control, whose title is `This draft is being elaborated.`; every other
draft stays startable. Each peer's activity
streams only into its own run's `issues-draft-activity`, its `ask` question renders only for that
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

The Open issues list shows every open issue with its `goal` badge and its handled state. Every
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
the worktree and branch, and closes the issue only after the push, through the same forge-auth
wrapper. On Gitea it fetches the issue through the API and closes it with an API `PATCH`; GitHub
keeps `gh issue view` and `gh issue close` under the wrapper.

Pause lets every active peer finish, then reports `paused` and starts no new peer or poll.
Resume polls immediately. Stop closes every peer, records every active run as `stopped`, leaves
every issue unhandled, releases the lock, and writes no cooldown. A successful run records only
its issue as handled in the ledger once the tracker reports it closed; an open issue after a clean
turn, or a failed state lookup, records `failed` and gates only that issue for five minutes,
leaving it open and unhandled. A failed run records its first stderr line. An issue closed by its
agent leaves the queue on the next poll.

## Auto Scout

Auto Scout is the `scout` descriptor in the shared background-agent contract. The Issues sidebar
entry `open-issues-scout` opens the shared `agent-page` with `data-agent="scout"`; opening,
selecting, restoring, or reloading a tab starts nothing. The page shows the shared lifecycle,
sync, cadence, limits, filed-issues table, and detail panel described above, plus
`scout-activity` for the current or newest scan. The page also shows `agent-error` for the last
error and `agent-sync-error` for a failed forge read.

There is no review path. While a worker runs, a scan whose items score at least 4 files each
accepted item directly as a GitHub issue in the host `origin`, in the same scan cycle, with no
dashboard command, click, approval, or draft. `approveScout`, `draftScoutGoal`, and `rejectScout`
are not accepted commands. Stop keeps the filed rows and the limits; the next Start reads the
forge and scans again.

Auto Scout's persisted settings live at
`<STATE_DIR>/scout/<journalKey(REPO_DIR)>/settings.json` and carry `maxPerHour`, `maxPending`,
and `intervalMinutes`. Empty limits remove that constraint. `maxPerHour` counts every Auto Scout
issue whose creation time is inside a rolling 60-minute window, in any state; `maxPending` counts
every open `scout` issue. One scan requests at most the smaller room, or 100 when both are
unlimited. A zero batch starts no scan; the next attempt is the earlier of the next 60-second read
and the moment the oldest hourly entry expires. A scan that files fewer items than requested is a
normal shortfall, recorded in scan activity, never a failure. Immediately before filing, the
worker reads every `scout` issue again; a failed read files nothing, keeps the last known rows,
and blocks filing until a read succeeds. The 60-second read and its 30-second bound are unchanged.

### Significance and provenance

Every recommendation carries an integer `significance` from 1 to 5 and a non-empty
`significanceReason`. Items scoring below 4 are dropped before filing and recorded in scan
activity. Each filed issue carries the exact `scout` label, no title prefix, and a body with
category, summary, impact, significance, evidence, proposed change, files, and acceptance
criteria. Detection, validation, dedupe, fingerprinting, titles, bodies, labels, ledger
dispositions, and existing issue URLs are unchanged by the shared control plane.

A scan never files a title whose normalized form matches any existing Auto Scout issue in any
state, any open issue title, or any draft goal heading. A duplicate is dropped, recorded in
activity, and consumes no cap slot.

An open issue is `pending`; a closed issue is `implemented` regardless of `stateReason`; a
reopened issue returns to `pending` on the next read. For an implemented issue the worker resolves
the commit that closed it — the timeline's closing commit when present, otherwise the last 7–40
character hex SHA in the newest comment that contains one — to one unambiguous full commit through
the checkout or GitHub. It then selects the earliest published GitHub Release tag whose history
contains that commit, ordered by `publishedAt` and breaking ties by tag name. The row shows `—`
when no commit resolves or no published release contains it, and a release published later fills a
blank version on the next read.

### Periodic check

While started, the worker reads every `scout` issue and every published release every 60 seconds,
and immediately on Start; the table, states, and versions reflect a change within one interval. One
periodic read, including every `gh` child it starts, is bounded to 30 seconds; a read that does not
finish records a sync error and releases the worker, so the next interval reads again. A failed
read keeps the last known rows, shows the reason in `agent-sync-error`, and keeps the last success
time in `agent-sync-at`; the reason clears on the next successful read. Filing stays blocked until
a read succeeds. A GitHub rate limit (the `gh` text naming a primary or secondary limit, abuse
detection, or HTTP 429) is a failed read like any other: it keeps the rows and blocks filing, and
its reason stays in the sync banner. Because the operator's credential is shared with every other
process on the host and the limit clears itself, it never raises the dashboard-wide error
notification.

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
the captured context to `POST /api/feedback`, the server files the issue through the configured
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
agent, or a rejected prompt shows the error in the panel, keeps the question and earlier answers,
and accepts the next question. `Ask` never calls `POST /api/feedback` and creates no issue.

Filing or proposing from a panel that has answered questions carries the visible Ask conversation
into the issue or draft as a `## Ask conversation` block between the request and
`## Captured UI context`, labelled `You:` and `Agent:` per turn. The conversation is bounded to 40
turns, 4000 characters per turn, and 12000 characters in total; when it exceeds that, the newest
whole turns are kept and the oldest dropped. A panel without a conversation produces no block, and
a conversation is never resumed from storage.

`Goal` turns the composer text into a raw proposed goal instead of an issue. With non-whitespace
text it posts `report`, the Ask conversation when the panel has one, and the same captured element
context to `POST /api/goal-proposals`; the server writes one Markdown draft under
`<REPO_DIR>/.devboard/goal-proposals/` and answers
`201 { "path": ".devboard/goal-proposals/<file>.md" }`. The directory is deliberately separate
from the final goal specs in `.devboard/goals/`: a draft is unprocessed input, and this action
never writes a goal document, `GOAL.md`, or an ADR, never files an issue, and never runs `gh`.
The file name is chosen by one bounded naming turn: an ACP peer starts with `AGENT_COMMAND` in
`REPO_DIR`, receives the operator report marked as data with a read-only instruction, and must
answer with only a lowercase kebab-case slug, at most six hyphen-separated words, `[a-z0-9-]`, and
at most 64 characters. A start failure, an exited peer, a question, a 15-second timeout, or an
unusable answer falls back to the report's first non-empty line, lowercased, with every run of
non-alphanumeric characters replaced by `-`, leading and trailing `-` removed, and at most six
hyphen-separated words, falling back to `ui-goal`; an existing name earns `-2`, `-3`, … through an
exclusive create, so the first draft is never overwritten. The body opens with
`# Proposed goal: <first line, whitespace collapsed, at most 200 characters>`, then the operator's
text verbatim, the `## Ask conversation` block when the panel has one, and the
`## Captured UI context` block an issue report carries. It carries no notice line or other prose
the operator did not write. A successful click closes the panel,
stays in report selection mode with an empty composer, and shows the
`Goal proposed: <path>` toast as plain text with no link; a failed write keeps the panel open
with the server's error and leaves no draft. The drafts are ignored by git.

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
selected UI element and redesign it because it does not look good. Use the global OMP UI/UX
standard (the ui-ux skill) and this repository's DESIGN.md and design/tokens.json as the normative
design system.` Both bodies end with the same `## Captured UI context` block: route, URL, selected
element, viewport, capture time, visible text, and DOM excerpt.

The report title is `[ui] ` plus the first line of the report, at most 200 characters; its body is
the verbatim report followed by the same captured context, so the ticket stays authoritative
without a model in the loop.

Every request carries an `action` of `report`, `remove`, or `redesign`; an absent `action` means
`report`, the only action that requires report text, and any other value is refused with HTTP 400
before the Gitea request. Harness-owned reporting uses only the Gitea API: `DEVBOARD_GITEA_URL`
names the instance, `GITEA_TOKEN` (or `DEVBOARD_GITEA_TOKEN`) authenticates it, and
`DEVBOARD_RELEASE_REPO` selects the repository (default `dsdenes/devboard`), whatever host project
the interface is serving. Nothing is created in the host's own tracker, and no `github.com`
repository is used for filing. Starting the dashboard from the canonical `.devboard` checkout
resolves the HTTP origin itself when the `origin` remote is a Gitea SSH address on this machine
and neither variable is set: it probes the local listening ports for `GET /api/v1/version` and
uses the lowest matching loopback port. An explicit variable always wins, an HTTP(S) origin needs
no discovery, and an installed host never probes. Without a configured or discovered origin the
endpoint answers HTTP 503 naming `DEVBOARD_GITEA_URL` and performs no request. A refused or
failing request is reported in the filing toast and creates nothing. The endpoint accepts only
same-origin `POST` requests, bounds the body to 64 KB, and gives the request 60 seconds.

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
{ "type": "answerGoalDraft", "path": ".devboard/goal-proposals/example.md", "id": 4, "value": "The whole goal" }

{ "type": "getAgents" }
{ "type": "getAgent", "id": "scout" }
{ "type": "startAgent", "id": "scout" }
{ "type": "stopAgent", "id": "scout" }
{ "type": "setAgentLimits", "id": "scout", "maxPerHour": 10, "maxPending": 5 }
{ "type": "setAgentCadence", "id": "scout", "minutes": 1 }
{ "type": "disableAgentTimer", "id": "watchdog" }
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
{ "type": "deleteSkill", "name": "test-strategy" }
{ "type": "resetImplementation" }
{ "type": "answer", "id": 1, "value": "Gamma" }
{ "type": "ask", "conversationId": "…", "question": "What does this label mean?", "context": { … } }
{ "type": "closeAsk", "conversationId": "…" }
{ "type": "getProviders" }
{ "type": "saveProvider", "id": "…", "provider": "opencode-go", "label": "Work", "key": "…" }
{ "type": "deleteProvider", "id": "…" }
{ "type": "setProviderEnabled", "id": "…", "enabled": false }
{ "type": "refreshProviders" }
```

- `getGoal` reads the goal document from disk and answers with its complete contents; an
  absent document answers with empty text, which shows `Create goal` and keeps the lifecycle
  start disabled.
- `getProject` answers with the page heading label. `path` is `REPO_DIR` relative to the user's
  home directory when the repository lies inside it, and the absolute path otherwise.
- `getVersion` answers with `versionState`: `running` is the harness package version the
  backend loaded, `installed` is the version its prefix holds now, `latest` is the newest
  release an update check has seen, and `stale` is true only when `running` and `installed` are
  readable and differ. A dashboard that serves the canonical source checkout reads neither side
  from the checked-in manifest: it reports `0.1.<commit-count>` over the full history, the same
  version a release packs, so an unpacked checkout never claims `0.1.0`. A client that connects,
  and the page every few seconds, asks for it; a stale answer makes the reload control appear
  with both versions in its title.
- `getProviders` answers with `providersState`: every subscription with its masked key, status,
  quota windows, remaining fraction, last check time, and error; the current `selection` (or
  `null`), the refusal reason, and the fixed rule `rotates at 1% remaining`. `saveProvider`
  validates a new or changed key first: HTTP 401/403 answers `providerError` and changes nothing,
  while an unreachable endpoint or 5xx saves the subscription with status `unknown`. Editing a
  label without a key never revalidates. `deleteProvider` and `setProviderEnabled` persist the
  store without touching a running peer. `refreshProviders` bypasses the 60-second usage cache.
  Every mutation broadcasts a fresh `providersState`; failures answer `providerError`. While at
  least one client is connected, the server forces a refresh and broadcasts a fresh
  `providersState` every 60 seconds; an idle server makes no provider call.
- `getIssues` answers with `issuesState`, the worker snapshot plus `present` and `attached`:
  lifecycle, enabled, paused, repository, poll times, queue entries with `labels`, `handled`,
  `runId`, and `agentRunId`, run summaries, the running `agents` (run id, issue number, startedAt,
  question, ACP child), the per-issue `cooldowns` map, errors, and the harness version the worker
  loaded. A missing state and no live lock answer `present: false`, `attached: false`, and
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
  is sent as its own `issuesDraftState` snapshot while its peer runs.

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
  an unknown id is refused with an error naming it and spawns nothing. `startAgent` runs the
  agent's preflight and spawns or attaches; `stopAgent` writes one stop command and persists
  `enabled: false`; `setAgentLimits` accepts `{ maxPerHour, maxPending }` where each is empty or
  1–100 and writes `settings.json`; `setAgentCadence` accepts `{ minutes }` from 1 through 1440;
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
- `saveGoal` replaces the goal document with `text` exactly as submitted and broadcasts a `goal`
  frame carrying that text to every connected client; the saving client's own frame is its
  confirmation. A write failure leaves the file unchanged and answers with an `error`. It is
  accepted while the lifecycle is paused and refused while the lifecycle is advancing.
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
  runs, `saveGoal`, `startRun`, `startLifecycle`, `pauseLifecycle`, `resumeLifecycle`,
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
  `reviseGoal` and `saveGoal` are refused only while the lifecycle is
  advancing.
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
bun run verify:providers
bun run verify:install
bun run verify:update
bun run verify:ui
bun run verify:issues
bun run verify:scout
```

`verify:interface` drives the IDE shell against a seeded fixture host in headless Chrome and
writes its screenshots under `.tmp/interface`. The other `verify:` scripts build fixture releases
under `.devboard/.tmp`, install them into throwaway hosts, and assert the launcher, update, and
reload contracts end to end. They never touch a real host.

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
leaves the table and a released lock. It writes only under `.devboard/.tmp`.
`bun run verify:agents` builds the client, seeds both agents, and drives headless Chrome through
the Background agents sidebar section, the identical core test ids on both pages, Start ->
starting -> running and Stop -> stopping -> stopped, cadence and limit validation and
persistence, the Watchdog cap, the shared table columns, freshness without a reload, no mutating
command on reload, the timer-blocked state and one-click disable against a stub `systemctl`, and
the footer indicator with no console error. It also proves the prompt section: both pages render
`agent-prompt` directly after `agent-header`; Auto Scout shows the complete instruction text and
the next-request JSON; Watchdog shows `agent-prompt-absent`; an installed host is read-only and
refuses a save with an error while its prompt file stays byte-identical; a source-checkout fixture
renders the editor, chat, save, and reset, one chat turn streams a reply and changes the editor
with the file untouched, Save makes the file byte-equal to the editor and a reload renders those
bytes, Reset restores the file bytes, and a seeded scan's `request.json` matches the preview
except `scanId` and `createdAt`.

`server/scout.test.ts` covers recommendation identity and the body's `## Category`, result
validation (over-count, malformed item, multi-line title, path escape, excluded tree, duplicate
id, out-of-range span, uncited file, shortfall, missing score, out-of-range score, missing
reason), the version-2 request, the shipped-version rules (earliest release, tie by tag,
timeline commit, newest comment SHA, open issue, no release), settings and state migration,
the bridge's limits and absent decision path, the Stop/limits command surface, the Start preflight
refusals, and the activity delta.
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
history pruning that keeps every running directory, preflight for both wrappers, repo-scoped state
and lock isolation, atomic and damaged state, ledger migration, the activity bounds, and the
conditional tracker. `tests/cleanup.test.ts` proves the watchdog preserves repo-scoped issues state,
the repo-anchored lock, and Flow session records that Flow restore still reads, while sweeping
legacy orchestrator run files. Every fixture stays under `.devboard/.tmp`.
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
and the post-reset empty records, goal text, `getGoal`, and `saveGoal` behavior.
`server/journal.test.ts` covers the dashboard journal: a real stub-agent run writes `activity`,
`question`, `run-start`, and `run-stop` records with `ts`, `repo`, `port`, and `pid`; a write
failure is reported without interrupting the run; rotation keeps every record; and pruning
applies the seven-day limit and the size bound without deleting the live window.
`tests/watchdog.test.ts` covers discovery (de-duplication, harness resolution, self-exclusion,
legacy logs), the inclusive ten-minute window, omp-log attribution and self-exclusion, the exact
evidence mapping (prose never produces a finding), host-independent fingerprints, filing and
commenting against a stub `gh`, per-filing and per-comment ledger persistence, pending retries
after a failed call, duplicate windows, the version 1 ledger migration, and the absence of any
commit, merge, push, or publish.
`tests/watchdog-api.test.ts` covers the adapter projection, the newest-cycle history, the shared
issue row order and fields, open/closed state mapping, the `ok`/`error`/`stale` transitions
against a stubbed GitHub reader and clock, the never-waits contract, the removed GET endpoint,
and the WebSocket `agentState` reply. `tests/agent-registry.test.ts` covers the registry, the
synthetic third descriptor, shared issue sorting, and unknown-id refusal.
`tests/agent-watchdog-runtime.test.ts` covers the detached worker's first cycle, Stop during a
slow filing cycle, a SIGTERM that lets the cycle finish, cadence application without restart, the
lifecycle transitions, foreign ownership, preflight refusals, and the timer gate. All new
fixtures live under `.devboard/.tmp`; no test uses the network or a real model.

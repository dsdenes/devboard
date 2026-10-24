# Devboard ADR interface

Local browser interface for the records in `adrs/`. The header `ADRs` control opens every record
in an overlay; each record title is a dropdown that expands to the first paragraph of its
`Decision` section, a brief summary of what was decided. The overlay distinguishes records
awaiting a decision (`Status: Proposed`) from resolved records, marks the pending record an agent
run would take up first, and starts an agent on that record or on one the developer selects. The
page heading names the project by its directory path relative to the user's home directory,
falling back to the absolute path when the repository lies outside it. A pending badge appears in
the header only while at least one record is `Proposed`, and the header `Resolve ADRs` control
appears only then; it resolves the pending sequence. When the harness checkout named by the
project's `.devboard` link names a commit other than the one the backend started from, the header
shows a reload icon; selecting it restarts the backend from that checkout and reloads the page.

It also shows the repository's current goal in a `Current goal` section. Until a goal is set the
editor is expanded. Once the goal document contains non-whitespace text, the editor, `Save goal`
control, and revision controls collapse into a `Goal document` dropdown, while the heading keeps
the skills control and `Recreate goal` visible. The developer can edit the text and
select `Save goal`; the server writes the submitted text verbatim to the goal document, and every
page load reads that file rather than browser state.

Below the editor, a `Revision guidance` field and `Revise goal` control ask an agent to modify,
rewrite, or recreate the goal. The guidance is optional; the agent may instead establish the
direction through interview questions. Its ACP session updates stream into the same live
activity log, questions use the same options, consequence explanations, recommended marker, and
free-form answer field, and when the revision ends the textarea is replaced with the text the
agent wrote to the goal document. A revision
is unavailable while a run is active or the lifecycle is advancing, but remains available
while the lifecycle is paused. ADR starts likewise remain available while the lifecycle is
paused, and selecting one while it advances pauses the lifecycle first. Only one foreground
agent runs at a time, so a revision and a manual ADR sequence exclude each other.

The goal section always shows a goal-creation control: `Create goal` while the document has no
non-whitespace text and `Recreate goal` otherwise. It stays selectable whenever the connection is
open, including while the goal document already has content and while a creation,
revision, or run is active. Selecting it asks the server to start the installed `/goal-outcome`
skill in one ACP peer, in the background; its activity and interview questions stream into the
same live log and question UI, and the goal section shows `Creating the goal` while it runs. The
developer answers the skill's questions; the skill interviews them and writes the goal document.
The flow never starts on page load or reconnect. When the goal document is empty, whitespace-only,
or absent, the control reads `Create goal`; otherwise it reads `Recreate goal`.

Selecting `Create goal` always starts a fresh creation. The server replaces an existing goal when
the new creation writes non-empty text, and it stops whatever would contend with the new peer: an
in-flight creation or revision is cancelled with a failed `goalCreationStopped` or
`goalRevisionStopped`, and an advancing ADR run or lifecycle is stopped and reported idle before
creation begins. A paused lifecycle keeps its lanes suspended in their tabs while the creation
runs. When the peer ends, the server reads `<REPO_DIR>/GOAL.md` and the textarea shows
those bytes, so `Recreate goal` becomes available; `Start lifecycle` becomes available once the
goal is ready and at least one managed skill is installed. A creation that ends with no
non-empty `GOAL.md` is reported as an error: the server sends an `error` and a failed
`goalCreationStopped`, and the textarea and goal state keep their previous content. The server
owns the creation run, so closing the browser does not stop it, and a client that connects during
it receives the start, every recorded activity line, and the pending question. While a creation
runs, starting a run or the lifecycle, resuming a paused lifecycle, and revising the goal are
each refused; creation itself always restarts.

While a run is active the interface names the record being resolved, or says `Implementing` when
the lifecycle peer is implementing an epic and `Generating` while it creates one, shows the
agent's latest ACP session update as the current action, folds earlier updates into a collapsed
history, and presents each interview question with its options, each labeled with the consequence
of choosing it and with the recommended one marked, plus a free-form answer field. One start
resolves every pending record in ascending file-name order: after each run the server re-reads
`adrs/`, and the sequence ends when no pending record remains or when the finished record is
still `Proposed` (or has been removed). The chain runs in the server, so it continues if the
browser disconnects.

The page also shows a pass number plus `Open epics` and `Running lanes` counts. It shows no
single lifecycle stage, because epic generation can run in parallel with implementation; the
counts and the lane tabs describe the run instead.
The pass is part of the durable per-repository state (see
[Durable state](#durable-state)) and is restored when the backend restarts, so an interrupted
run's pass is still shown afterwards; an explicit reset sets it back to 1. The lifecycle starts
only from a settled goal and a prepared skill set: `Start implementation` stays disabled until
the goal document contains at least one non-whitespace character and at
least one managed skill is installed in `<REPO_DIR>/.omp/skills/`, which the skills overlay lists.
The server enforces the same rules: a start is refused with an `error` when the goal is not
settled, when the skills directory cannot be read, or when no managed skill is installed.
One button in the page header controls the lifecycle: it reads `Start implementation` while idle
and turns red with `Stop implementation` while a run is active.
Selecting `Start implementation` reports the run as active at the `epic` stage with no work as
soon as the server accepts the command, before it queries the origin tracker; the header control
therefore reads `Stop implementation` while that query runs. Selecting `Stop implementation`
closes every lane peer, ends the loop, and reports the idle `goal` stage with the pass already
reached; a stop never leaves the run suspended, and a new start is accepted only after the
stopped loop has finished unwinding.

A lifecycle run is a continuously refilling parallel pipeline. The server reads every open epic,
not only the first, and starts one implementation lane per open epic at once, with no fixed
concurrency cap: five open epics start five peers and five worktrees. Each lane receives exactly
one epic as `/implement-next-epic <ref>` and never selects a different one; the prompt requires
the lane to create its own worktree and branch, implement the epic, merge that branch into `main`
itself, push `main`, fetch and integrate the latest `main` and retry if the merge or push fails,
never force-push, and close the epic only after the merge and worktree removal succeed. Lanes
finish, merge, and push at independent times; the server imposes no merge schedule.

When no epic is open, the run starts one `/epic-next` peer. Epic generation is a zero-or-more
operation: one pass decides how many mutually independent epics the goal currently admits, files
that many, and skips any candidate that duplicates or overlaps an already-open epic instead of
halting. Every epic a pass files starts its own implementation lane immediately. When any lane
closes its epic, the server requests a generation pass immediately, even while other lanes still
implement; requests that arrive during an active pass coalesce into at most one follow-up pass,
and two epic-generation peers never run at once. A pass that files nothing leaves the remaining
work to the other lanes, to retries, or to ADR resolution.

A lane that ends with its epic still open is marked `retrying` and retried after a backoff and
immediately when `main` advances; retrying never creates a second concurrent lane for the same
epic. A lane whose peer prints a line beginning `DEVBOARD-BLOCKED:` is `parked`: its tab reports
the blocker and it is retried only when `main` advances. Parking one epic never delays another
lane. With no lane active after a generation pass that files nothing, only parked epics remaining
means the lifecycle sends an `error` naming every parked epic, returns to the idle `goal` stage,
and leaves those epics open; a new start clears the parked set and attempts them again. When no
epic is open, a generation pass files nothing, and no ADR is still `Proposed`, the run reports
`finished`; pending ADRs are resolved first with `/adr-resolve` in file-name order.

The page renders one tab per active agent lane under `Open epics`/`Running lanes`: epic
generation, each implementation epic, and ADR resolution. Each tab carries its epic or record
identity and an attempt number when the epic was retried. Its left edge is colored by lane kind
and state: purple for epic generation, teal for ADR resolution, green for a running
implementation, amber while one is paused, retrying, or parked, red when it failed, and gray
once it closed. The tab carries no status text. A closed or failed lane leaves the active list
after 30 seconds. Selecting a tab opens a fixed-height, scrolling panel that shows only that
lane's current action, history, status, and pending question. The status label is uppercased and
colored like the tab; the action and every history entry render as sanitized Markdown with styled
headings, lists, code, and links, so agent output is structured instead of one wall of text. Two
peers streaming at once never mix their lines. The lifecycle advances while a run is active, so
the goal editor and the lifecycle start control are disabled, but the ADR start controls remain
available: selecting one interrupts every lane at its interrupted stage, starts the manual record
sequence, and resumes the lifecycle when that sequence ends. A client that connects or reloads
receives the current stage, pass, counts, tab list, and every live lane's recorded activity and
pending question. An epic's work state carries the tracker page, and the page renders
`Epic #<n>` as a link to that issue. Once a run reports `finished`, the server keeps
that state for its lifetime and replays it, together with the lanes still retained, to every client
that connects or reloads, so the interface still shows the final pass and any recent tabs until a
new run starts; a backend restart restores the same state. An aborted run likewise replays the
idle goal stage with
no work, not paused, and the pass it had reached, so the goal becomes editable and another
lifecycle run can start.

An epic is an open issue carrying the label `epic` (ignoring case) or the
`<!-- devboard-epic -->` marker in its body; the server reads every such issue with read-only
`gh` or `glab` queries. Every tracker operation first resolves the forge identity against the
repository itself: it lists every account authenticated for the origin host, rejects tokens that
are invalid or lack access to that project, and prefers a write-capable account owned by the
repository owner, then the active account, then any other write-capable account. An ambient
`GH_TOKEN`/`GITHUB_TOKEN` is used only when it passes the same check, so a stale or wrong-user
token cannot shadow a usable account. The selected token travels in the child environment, never
in an argument; the global `gh` active account is never switched, so parallel lanes and
dashboards cannot race. Epic generation, implementation lanes, and the server's tracker reads
call the same resolver, and the lane prompt routes its tracker writes through
`.devboard/scripts/forge-auth.ts`. A repository with no write-capable authenticated account stops
before an agent writes instead of surfacing a 401 or 403. Forge reads may expose a peer's tracker
write a moment after the peer exits, so the server re-reads the tracker for a bounded settle
window per lane before trusting an answer that still shows the pre-peer state.

The goal section also offers `Prepare Skills` whenever the goal document contains non-whitespace
text. Selecting it sends one `prepareSkills` command, which starts one ACP peer with the installed
`/prepare-skills` command and no other prompt. The harness prompt reads only `<REPO_DIR>/GOAL.md`
as project-specific input, uses it only to select which standards and pattern families are
relevant, and never treats it as an implementation brief; it researches relevant public
standards, general best practices, software-architecture patterns, and testing patterns on the
web, and authors project-agnostic Agent Skills under `<REPO_DIR>/.omp/skills/`. A prepared skill
states policy another project could adopt and carries none of this host's names, paths, files,
modules, symbols, packages, dependencies, technology choices, data formats, API shapes, or
concrete design decisions. The agent decides how many skills to prepare and what each covers;
there is no category taxonomy, no required topic, and no fixed count, and no category metadata is
required or validated.
Activity and interview questions stream into the existing log and question UI, and the goal
section shows `Preparing skills` while the peer runs. The server validates the result: every
managed skill must be a directory containing `SKILL.md` with a matching name, a non-empty
description of at most 1024 characters, and `metadata.devboard-managed: "true"`, and the managed
set must contain at least one skill. The final pass compares every installed skill, including
hand-authored ones, and succeeds only when no pair gives incompatible instructions. On success
the goal section's control reads `Show skills (<count>)` and opens an overlay that lists each
prepared skill with its name and description, reports `No contradictions`, and offers
`Prepare skills again`; the control reads `Prepare Skills` while no skill is installed. A later
run, reload, reconnect, or server restart shows the set read from disk. A run replaces only the
skills carrying the managed marker: an unmanaged skill is never
overwritten or deleted, and a generated name that collides with one fails the run with an `error`
naming it. Any failure sends an `error` and a failed `skillsPreparationStopped`, restores the
previous skills directory byte for byte, and leaves the last Skills panel state visible. While
preparation runs, starting a run or the lifecycle, resuming a paused lifecycle, revising or
saving the goal, creating a goal, and a second preparation are each refused. The control never
starts on page load or reconnect.

The page header holds a red `Reset implementation` control. It is
disabled only while the WebSocket is not open or another reset is active, so it can be used at
any time, including while a run, lifecycle run, goal creation, goal revision, or skills
preparation is active. The first click
only arms it: no frame is sent, and a panel under the header shows the exact keep set, notes that
active work stops first, and offers `Confirm reset` and `Cancel` controls. A reload, a reconnect,
a disconnect, or any other command disarms it. The second click sends exactly
`{ "type": "resetImplementation" }`.
The server performs the reset, so a browser disconnect does not interrupt it; a client that
connects during one receives `implementationResetStarted`, and a second reset is refused.

The keep set is exact: `.devboard`, `.omp`, `AGENTS.md`, `.gitignore`, `GOAL.md`, plus the direct
child named by `GOAL_FILE` when that differs. `.git` and `.worktree` are internal: the server
never descends into or deletes them, and they never enter the commit. Every other top-level
entry is removed, including tracked, untracked, and ignored entries; a symlink is removed as a
link without following it. Before deleting anything the server requires that `REPO_DIR` is the
repository top level, that `HEAD` names a commit, that the current branch is exactly `main`,
and that `origin` exists; any failed check is refused with one `error` and leaves the filesystem,
git state, and active work unchanged. After those checks pass the reset takes over: an active
run is closed and reports `runStopped`, every lifecycle lane is closed and its tab is removed, a
lifecycle also reports the idle `goal` stage, goal creation and revision report their stopped
events, an in-flight skills
preparation is cancelled and restores the previous skills directory, and an in-flight lifecycle
or preparation start is invalidated so it spawns no peer after the reset accepted. Stopped work
is not resumed. The server stages with `git add -A`, removes `.worktree`,
`.devboard/node_modules`, and `.devboard/dist` from the index, and commits with `git commit
--no-verify -m "chore: reset implementation"`. It never amends, rewrites history, force-pushes,
or stages ignored files. With no staged change it reuses the current `HEAD`. Success pushes
`origin main` with terminal prompts disabled and broadcasts `implementationResetStopped` with
the commit, then the idle `goal` lifecycle state, an empty `records` list, and the unchanged
goal text; the local and remote `main` then name the same commit. A push failure broadcasts the
git stderr in an `error` and the same event with `completed: false` and the local commit, leaving
the commit and the deleted tree in place; a commit failure reports its stderr and the failed
event without a commit, leaving the staged deletion. `GOAL.md` may be absent, empty, or
whitespace-only; reset preserves that state and never creates or edits the document. Reset never
starts on load or reconnect; the reset itself spawns no ACP peer, emits no activity events, and
writes no `adrs/` file.

## Stack

- Backend: TypeScript on Bun, serving the built client and one WebSocket at `/ws`. Each run spawns one `omp acp` subprocess over stdio.
- Client: Svelte built with Vite.
- Records: read from `adrs/` on every `listRecords` command and after every run, so files added,
  removed, or resolved while the server runs appear without a restart. Each record carries the
  first paragraph of its `Decision` section as a short summary.
- State: the dashboard's server-owned state is written atomically to
  `<stateDir>/state/<24-hex hash of REPO_DIR>.json` (default `stateDir` is `<harness>/.tmp`), so it
  survives a backend restart without leaking between repositories that share one harness install.
  See [Durable state](#durable-state).

## Install

`install.sh` installs the agent wrappers under `omp/` into a host project:

```bash
./install.sh /path/to/host
./install.sh --force /path/to/host
cd /path/to/host/.devboard && ./install.sh
```

The host must already contain a `.devboard/` directory. Every file under `omp/` is copied to the
same relative path under `<host>/.omp/`; matching files are left alone, unrelated host files are
never removed, and a differing file stops the run unless `--force` is given. Without a host path,
the script uses `git rev-parse --show-toplevel` of the working directory.

### Set up a host from the canonical checkout

`setup-devboard.sh` installs the harness for a host without copying it, then starts the
interface:

```bash
~/devboard/.devboard/setup-devboard.sh [--force] [--no-ui] [--port N] [host-path]
```

The host defaults to the working directory. `<host>/.devboard`, `<host>/.omp/commands`, and
`<host>/.omp/extensions` become symlinks to the canonical checkout at `$DEVBOARD_HOME`
(default `~/devboard`), and the same entries are added to the host `.gitignore`. A real
directory at a link path stops the run unless `--force` is given. `--no-ui` installs the links
only; otherwise the script rebuilds the client and starts the interface in the background,
picking the first free port from 8080 unless `--port` or `PORT` names one, and prints its URL.
Rerunning it for a host that is already served reports the running URL instead of starting a
second server.

The global `/setup-devboard` command runs this script against the invoking session's working
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
ADRS_DIR="<host>/adrs" bun run start
```

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
accepted `whenIdle` restart. Browser-only state (selected lane, draft text, banners, overlays,
connection status) and full ACP transcripts, raw stderr, and secrets stay out of the file.

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

## Publish a change

A running dashboard keeps the server code it loaded at startup and serves whatever `dist/`
contains, so merging source is not enough. After a change is on `main` and pushed, run this from
the integration checkout — the checkout every host's `.devboard` symlink names:

```bash
cd .devboard
bun run publish
```

`bun run publish` verifies the checkout is the main worktree on `main`, fetches and fast-forwards
`main` to its canonical remote without discarding uncommitted work, installs dependencies,
rebuilds `dist/`, then finds every running dashboard whose server runs from this checkout or
serves its `dist` and restarts it. That covers every host whose `.devboard` points at this
checkout; nothing is written into a host. Each restarted dashboard is checked for
`versionState.stale === false`.

A dashboard with active work (run, lifecycle lane, goal creation or revision, skills
preparation, or reset) is not killed: it answers `upgradePending` and restarts itself as soon as
that work ends, after which the browser reloads. `--wait` blocks until deferred dashboards
restart; `--wait-timeout N` bounds that wait (default 1800 seconds). `--no-restart` rebuilds
only, and `--allow-worktree` permits a verification build from a worktree, where no dashboard is
served.

The script refuses to run from a worktree, from a branch other than `main`, when local `main`
is ahead of or diverged from the remote, and when uncommitted changes would be overwritten by
the fast-forward; it names the blocking paths instead of touching them.

|Variable|Default|Purpose|
|---|---|---|
|`HOST`|`127.0.0.1`|Listen address.|
|`PORT`|`8080`|Listen port.|
|`ADRS_DIR`|`/repo/adrs`|Directory holding the ADR files.|
|`REPO_DIR`|parent of `ADRS_DIR`|Agent working directory and default goal location.|
|`GOAL_FILE`|`<REPO_DIR>/GOAL.md`|Goal document read on load and replaced on save.|
|`STATIC_DIR`|`dist`|Built client directory.|
|`AGENT_COMMAND`|`omp acp`|ACP peer command, split on whitespace. `server/fixtures/stub-agent.ts` is a deterministic substitute for tests and local verification.|

## Harness watchdog

A machine-level systemd user timer runs the watchdog independently of every dashboard: at
minutes 0, 10, 20, 30, 40, and 50 of every hour (`OnCalendar=*:0/10`, `Persistent=true`), the
`devboard-watchdog.service` oneshot runs `bun run watchdog -- --once` from the canonical harness.
It survives logout (`Linger=yes`) and never starts, stops, or restarts a dashboard itself.

Each cycle reads the ten minutes before cycle start, both ends inclusive, from:

- every live dashboard's JSONL journal, `<serving harness>/.tmp/journal/<24-hex>.jsonl`, whose
  key is the first 24 hex characters of `sha256(REPO_DIR)`. Each record carries `ts` (UTC ISO
  8601), `repo`, `port`, `pid`, `kind`, and `text`; kinds are `activity`, `question`,
  `run-start`, `run-stop`, `lane-start`, `lane-stop`, `lifecycle`, `acp-stderr`, and
  `server-error`. A live journal rotates at 8 MiB instead of truncating.
- omp's own warnings and errors under `~/.omp/logs/omp.*.log`, attributed to an instance only
  through that pid's working directory or process ancestry.

Retention is bounded: the watchdog deletes rotated journal files older than seven days at cycle
start and enforces a 1 GiB total for `.tmp/journal`, deleting the oldest complete files first. A
file still holding records inside the live window always wins over that bound, so the current
cycle never loses evidence.

Discovery scans `/proc` for every process running `server/index.ts` that supplies `REPO_DIR` and
`PORT`, de-duplicates by `(REPO_DIR, PORT)`, resolves the serving harness from `STATIC_DIR` or
the process working directory, and excludes the watchdog and its descendants. Instances from
other harness checkouts are covered too; an instance whose harness has no journal is reported
`uninstrumented` and its legacy `.tmp/devboard-<cksum>.log` is read when present.

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
worktree; a push or publish failure leaves the pushed revision in place and exits nonzero. A
pre-existing uncommitted change is recorded and blocks merge, push, and publish; it is never
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
the operator's authenticated `gh` CLI, then returns its URL.

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
- `getVersion` answers with `versionState`: `running` is the commit the backend started from,
  `current` is the commit the project's `.devboard` link names now, and `stale` is true only
  when both are readable and differ. A client that connects, and the page every few seconds,
  asks for it; a stale answer makes the reload control appear.
- `restartServer` broadcasts `serverRestarting`, then hands the process to its launcher, which
  stops the listener, starts the current host harness, and exits. It is refused with an `error`
  when no launcher is configured or while a restart is already in progress. A client that sees
  `serverRestarting` waits for the replacement to answer and reloads the page. With
  `"whenIdle": true`, a dashboard with active work answers `upgradePending` instead and
  restarts itself as soon as that work ends; an idle dashboard restarts immediately. This is the
  command `bun run publish` uses.
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
```

`tests/install.test.ts` covers the install script: a fresh install, an idempotent rerun that
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

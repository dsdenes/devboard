## Objective

In this repository's devboard harness — the Bun server in `.devboard/server/`, the Svelte client in
`.devboard/client/`, the agent prompts and wrappers under `.devboard/prompts/` and `.devboard/omp/`,
the deterministic tests, and `.devboard/README.md` — add Flow Mode as a second dashboard mode beside
the existing Goal Mode. The page gains a top-level Goal/Flow switch whose two views never interfere:
switching changes only what is visible, never starts, stops, pauses, or clears either mode. Flow Mode
creates a session-local goal through its own command instead of writing `GOAL.md`, runs exactly one
implementation agent in an isolated worktree, and streams a live, always-current set of color-coded
change widgets. Each widget names the concept that changed, shows its affected files and a
side-by-side diff, can be accepted or refused, and can open a read-only conversation whose conclusion
steers the implementation. The developer also gets an append-only steering feed, a single editable
decision board the implementation agent reads at every checkpoint, a changed-file map, a checkpoint
timeline, verification status, and open questions and blockers. The session branch becomes a draft
PR (or MR) for the host forge as soon as the first checkpoint is pushed; a manual action turns it
live, and one manual Merge action merges it with a merge commit and cleans up. Goal Mode keeps its
current behavior, Flow Mode never creates GitHub issues or epics and never writes `GOAL.md`,
`adrs/`, or the host checkout, and only one mode may have active work at a time.

## Success criteria

- The top of the page shows a `Goal` / `Flow` switch as a `role="tablist"` with buttons carrying
  `data-testid="mode-goal"` and `data-testid="mode-flow"`, `aria-selected` on the active one, and
  Goal selected on a fresh load. Activating a button sends no WebSocket frame, starts no agent, and
  stops, pauses, resets, or clears nothing in either mode. Both views stay mounted so native details,
  scroll state, and focus in the inactive view are preserved when the developer switches back.
- Goal Mode is unchanged whenever no Flow work exists. Its existing controls, goal editor, goal
  creation and revision, skills preparation, lifecycle, lanes, manual ADR sequence, reset, commands,
  events, and payloads keep their current behavior and tests. Flow events never write Goal Mode's
  `activity` or `question` state, and Flow errors render inside the Flow view instead of replacing the
  Goal Mode error banner.
- Only one mode may have active work on a repository. While Goal Mode has an active lifecycle, manual
  ADR run or sequence, goal creation, goal revision, skills preparation, or reset, every Flow start
  command is refused with one error naming the active work and spawns no peer. While Flow has an
  active goal creation, implementation, analyst, or widget conversation, the Goal Mode start
  controls and commands for lifecycle, manual ADR, goal creation, goal revision, and skills
  preparation are refused with one error naming Flow Mode and spawn no peer. View switching remains
  available. `restartServer` with `whenIdle: true` treats active Flow work as active work and
  answers `upgradePending` rather than restarting.
- `resetImplementation` is refused with one error while a Flow session exists whose worktree or PR
  is not merged, because resetting the host would destroy reviewed work and leave a remote PR open.
  A merged Flow session does not block reset. Existing reset behavior is unchanged in every state
  without an unmerged Flow session.
- The server never creates a GitHub issue or epic for Flow and never calls the epic tracker. Tests
  with a recording forge and a recording `gh`/`glab` see no `issue`, `search issues`, `label list`,
  or tracker query. Flow never writes `adrs/` and never writes, replaces, or deletes the file named
  by `GOAL_FILE`; a hash of `GOAL.md` is identical before and after every Flow interaction.
- A Flow session stores its state under the configured harness `stateDir`, in a directory keyed by
  the existing 24-hex `journalKey(REPO_DIR)` and one session id, using names such as
  `flow/<key>/<session-id>/goal.md`, `decisions.md`, `steering.jsonl`, `steering-ack.jsonl`,
  `checkpoints.jsonl`, `verification.json`, `changes.json`, `accepted.json`, `blockers.jsonl`, and
  `session.json`. The default state directory remains `<harness>/.tmp`; no Flow file is written
  outside the repository root, into the host's tracked files, or into the implementation worktree.
  Two repositories sharing one state directory never read or overwrite each other's Flow state.
- `createFlowGoal` starts exactly one ACP peer whose prompt is `/flow-goal <session-dir>` and whose
  cwd is `REPO_DIR`. The installed prompt and command wrapper are a Flow-specific fork of the goal
  interview: they write only `<session-dir>/goal.md`, refuse to write `GOAL.md`, and never touch
  `adrs/`. The server broadcasts `flowGoalStarted`, streams `flowActivity` and `flowQuestion`, and
  answers through `flowAnswer`. A client that connects during the creation receives the session,
  the started marker, every recorded activity line, and the pending question before its own replies.
- A creation that ends with a non-whitespace `goal.md` broadcasts
  `flowGoalStopped {completed: true, text: <exact bytes>}`. An absent, empty, whitespace-only, or
  unreadable `goal.md` broadcasts one `flowError` and `flowGoalStopped {completed: false}` without
  text, leaves `GOAL.md` unchanged, and leaves the session available for another attempt. Creation
  never starts on page load, reconnect, or mode switch.
- The Flow goal editor renders the session goal and saves it verbatim through `saveFlowGoal`. Saving
  is refused while the implementation is running, accepted while it is stopped, and never writes
  `GOAL.md`. `Recreate flow goal` starts a fresh `/flow-goal` peer and replaces `goal.md` only after
  the peer writes non-whitespace text; the previous goal stays on a failed attempt.
- `startFlowImplementation` requires a non-empty session goal, no running Flow implementation, no
  active Goal Mode work, and no reset. It creates or reuses exactly one worktree at
  `<repo>/.worktree/flow-<session-id>` on branch `flow/<session-id>` from the latest fetched
  `origin/main`, falling back to local `main`, and refuses with an error when neither exists. It
  then spawns exactly one ACP peer whose prompt is `/flow-implement <session-dir>` and whose cwd is
  that worktree. Beginning another start while one runs is refused; no code-writing peer is ever
  spawned twice. A stopped session can be started again in the same worktree and continues from its
  existing state.
- The implementation prompt requires the agent to work only in its worktree, commit a checkpoint
  after each coherent unit, never merge or push, never create an issue or epic, read new
  `steering.jsonl` and `decisions.md` before each checkpoint, append consumed steering ids to
  `steering-ack.jsonl`, append a checkpoint entry, record verification, and report a blocker with a
  line beginning `DEVBOARD-BLOCKED:` when it cannot continue. The server owns branch pushes and the
  PR; the agent never force-pushes and never writes to the host checkout or the harness.
- Only the implementation peer writes code. The goal-creation, change-analyst, and widget-conversation
  peers are instructed to be read-only, and the server never applies edits from them. A deterministic
  test proves the worktree diff hash is unchanged by a widget conversation and by an analyst run.
  Widget conversations and analysts may run while the implementation runs and never pause it.
- `stopFlowImplementation` closes the implementation peer, broadcasts `flowStopped`, and keeps the
  worktree, session files, widgets, accepted state, checkpoints, verification, and PR metadata for
  review. It spawns no replacement peer. The Flow view shows `Stopped` and enables Start again.
- After the first checkpoint commit, the server pushes `flow/<session-id>` to `origin` without force
  and creates exactly one draft PR (GitHub) or draft MR (GitLab) against `main` for the host forge,
  using the existing forge classification and write-capable account resolution. Every later
  checkpoint commit is pushed without force and updates the PR. The PR title comes from the session
  goal; its body contains the goal and the current decision board. A failed push or PR creation
  broadcasts one `flowError` with the command's stderr, keeps the session and worktree, and leaves
  the PR actions disabled until a retry succeeds.
- The Flow view shows the forge, PR number, link, and state (`none`, `draft`, `live`, `merged`,
  `closed`, `error`). A `Retry PR` control is available after an error. The server retries PR setup
  after the next checkpoint push and on an explicit retry command. No placeholder or invented PR
  URL is ever shown.
- `markFlowPrReady` is refused unless the implementation is stopped, a PR exists, it is a draft, and
  the Flow worktree is clean. It calls the forge's ready operation, refreshes the PR state, and
  broadcasts the live state and link. `mergeFlowPr` is refused unless the implementation is stopped,
  the PR is live and open, the worktree is clean, and no Goal Mode work is active. It uses the
  forge's merge-commit method, never squash or rebase, and never force-pushes. A merge failure,
  conflict, pending check, or dirty worktree broadcasts one `flowError`, keeps the PR, worktree, and
  session intact, and performs no cleanup.
- A successful `mergeFlowPr` verifies the PR is merged, fetches `origin`, and fast-forwards the host
  checkout's local `main` only when that checkout is on `main` and clean. It then removes the Flow
  worktree without forcing over uncommitted work, verifies the branch tip is an ancestor of
  `origin/main`, deletes the local and remote `flow/<session-id>` branch, and marks the session
  `merged`. If the local checkout cannot be fast-forwarded or the worktree cannot be removed
  cleanly, the merge still stands and the view reports the exact leftover path and branch; no local
  work is discarded. A merged session disables Start, Ready, and Merge and retains its files and PR
  link for audit.
- The change watcher diffs the implementation worktree against the session base revision, including
  tracked changes and untracked non-ignored files. It runs on the first implementation start, after
  every checkpoint, and on a debounced timer while the session has a worktree; a diff hash that did
  not change starts no analyst. At most one analyst peer runs at once, and changes during its run
  coalesce into at most one follow-up. The server broadcasts a complete `flowFiles` snapshot and a
  complete `flowWidgets` snapshot, never an append-only widget delta. The client replaces both lists
  on every snapshot and on reconnect.
- The server sends the analyst a `/flow-change <session-dir>` prompt with the current diff, the
  session goal, the decision board, and the previous widget list. The analyst is read-only, writes
  its result under the session directory, and never edits the worktree. Its result is validated:
  every widget has a category from the fixed set, a non-empty concept, summary, and rationale, and a
  non-empty list of changed file paths; no widget names a file that is not in the current diff; and
  every changed file is named by at least one widget. An uncovered file gets a fallback `structure`
  widget. If the analyst fails, times out, or returns invalid output, the server broadcasts one
  `flowError` and emits fallback `structure` widgets for every changed file so the snapshot still
  covers the whole diff. No changed file is silently absent.
- The fixed widget categories are `contract`, `entity`, `naming`, `data`, `dependency`,
  `irreversible`, and `structure`. Each widget carries `data-category`, shows the category label,
  and uses a distinct color token for a left border and badge; light and dark variants are defined
  and no two categories share a token. Color is never the only cue.
- A widget's identity is a stable signature over its category, sorted changed file paths, and the
  normalized current diff of those files. The analyst's concept text is display metadata and a
  concept rename without a code change keeps the accepted state. The accepted set persists in
  `accepted.json`. A widget is marked accepted only while its signature is present in the current
  snapshot. If the code or file set changes, the old widget disappears and a new unaccepted widget
  appears; if the change is reverted or the file stops differing, the widget disappears. No accepted
  widget survives when its signature is absent, and the client never keeps a stale accepted card.
- Each widget renders with `data-testid="flow-widget"`, `data-widget-id`, and
  `data-accepted="true|false"`. The check control toggles acceptance without blocking the
  implementation and persists the signature. Clicking the widget body opens
  `data-testid="flow-widget-detail"`, which shows the category, concept, summary, rationale, and only
  the files tied to that widget. Each file opens a `data-testid="flow-diff"` view rendered by a
  maintained third-party diff-rendering library (for example `diff2html`), with side-by-side code,
  file headers, line numbers, and added/removed line colors. The client does not parse unified diff
  hunks itself. The focused diff contains only that widget's files, not the whole session diff.
- A `Refuse` action opens a confirmation with an optional reason. Confirming appends one steering
  note with source `widget:<id>` asking the implementation to abandon that change and implement
  another solution. The widget remains visible until its signature changes or disappears, and the
  implementation is never stopped or paused by the refusal.
- A widget conversation opens exactly one read-only ACP peer with `/flow-widget <session-dir>
  <widget-id>`, the widget context, its files and diff, the session goal, and the decision board.
  The panel streams `flowConversationActivity` and `flowConversationQuestion`, accepts multiple
  developer messages, queues a message sent while the peer is answering, and answers its questions
  through `flowAnswer` with the conversation target. The peer never writes code. Closing the panel
  stops the peer. A client that reconnects while a conversation is open receives its recorded
  messages, activity, and pending question.
- The conversation panel ends with a developer-editable conclusion and a
  `Send conclusion to implementation` action. Sending appends the conclusion under a timestamped,
  source-named section of `decisions.md` and appends one steering note with source
  `widget-chat:<widget-id>`. The main implementation agent reads both at its next checkpoint. If the
  widget's signature has disappeared, the panel marks the change as no longer current but still lets
  the developer send the conclusion as steering.
- The Flow view has a steering input and a list of steering notes. `sendFlowSteering` appends one
  JSON line to `steering.jsonl` with an id, timestamp, source `developer`, text, and `new` status,
  and broadcasts the complete note list. The implementation is never stopped, paused, or restarted
  by adding a note. A deterministic test adds a note while the stub implementation is mid-run,
  observes the stub read it before its next checkpoint, and observes the resulting code change in
  the next widget snapshot. The server marks a note `read` after the implementation appends its id
  to `steering-ack.jsonl`, broadcasts the updated list, and retains the note for audit.
- The decision board is one Markdown file, `decisions.md`, rendered in the Flow view as an editable
  textarea with a Save control. A developer save writes the submitted text verbatim, broadcasts the
  new text, and is authoritative. Agent conclusions and agent-proposed decisions are appended by the
  server under timestamped, source-named sections and never replace developer text; a concurrent
  developer save and agent append preserve both. The implementation, change-analyst, and
  widget-conversation prompts receive the board, and a test proves the implementation stub reads it
  at a checkpoint.
- The Flow view shows a changed-file map built from the same diff as the widgets: every changed file
  with path, status (`added`, `modified`, `deleted`, `renamed`), insertion and deletion counts, and
  `data-testid="flow-file"`. Selecting a file opens the same `flow-diff` renderer for that file.
  The map is complete even when several widgets share a file.
- The Flow view shows a checkpoint timeline. Each `data-testid="flow-checkpoint"` carries a
  timestamp, one-line summary, changed-file count, short commit id, and verification badge. Entries
  come from the implementation's `checkpoints.jsonl`; when a new commit has no entry, the server adds
  a fallback entry from the commit subject and changed files so every checkpoint commit appears. The
  complete timeline is persisted and replayed.
- The Flow view shows the latest verification as `data-testid="flow-verification"`: the command, a
  `passed`, `failed`, or `not-run` status, a timestamp, and a bounded output tail. The implementation
  prompt requires the agent to record relevant test, lint, or build results after each checkpoint;
  the server never guesses the host's test command and never runs one itself. A failed verification
  is visibly distinct and persists with its checkpoint.
- The Flow view shows open questions and blockers. An implementation elicitation becomes a
  `flowQuestion` with its options and free-form answer, answerable through `flowAnswer`; it survives
  reconnect until answered. A `DEVBOARD-BLOCKED:` activity line, or an explicit blocker recorded by
  the implementation, becomes a `data-testid="flow-blocker"` entry with text and timestamp. The
  developer can dismiss a blocker; the complete list persists and is broadcast. A new run does not
  silently clear an undismissed blocker.
- Session state persists across a server restart. A replacement server loads the newest non-merged
  session for `REPO_DIR` and restores the session id, base revision, worktree and branch, goal,
  decisions, steering notes and acks, accepted signatures, widgets, changed files, checkpoints,
  verification, blockers, and PR metadata. A run that was live becomes `stopped` with one notice
  naming the restart; the replacement spawns no implementation, analyst, or conversation peer
  automatically. The worktree remains, widgets are recomputed from it, Start resumes the session,
  and a client that connects after the restart receives the restored snapshot before its own
  replies. No live ACP peer is auto-resumed.
- `createFlowGoal` when a non-merged session exists reuses that session and replaces only its goal
  after a successful interview. After a session is merged, `createFlowGoal` starts a new session id
  with a new base revision and a new worktree; the merged session's files and PR link remain
  readable. At most one non-merged Flow session exists per repository at a time.
- `.devboard/prompts/flow-goal.md`, `flow-implement.md`, `flow-change.md`, and `flow-widget.md` and
  their `.devboard/omp/commands/` wrappers exist, are project-agnostic, contain no host name,
  absolute path, or repository identifier, and the wrapper delegates to the matching prompt. The
  wrapper files are installed into the host `.omp/commands/` with `.devboard/install.sh`, and the
  installed copies match the canonical files byte for byte.
- `cd .devboard && bun test` exits 0 with zero failures, `cd .devboard && bun run build` exits 0,
  and the new focused tests cover the mode switch, Flow goal creation, start/stop, mode
  exclusivity, worktree and branch creation, PR lifecycle, widget reconciliation, accepted-state
  disappearance, diff rendering inputs, steering and acknowledgements, decision-board concurrency,
  checkpoints, verification, questions and blockers, persistence, and portability. No new test uses
  `tmpdir()` or writes outside the repository root.
- `.devboard/README.md` documents the two modes and the switch, the Flow commands and events, the
  session state location and keying, the widget categories and colors, the acceptance and stale
  disappearance rules, the steering and decision-board contracts, the worktree and PR/MR lifecycle,
  the merge and cleanup behavior, the restart behavior, and the explicit absence of issues, epics,
  `GOAL.md` writes, and `adrs/` writes. The documented behavior matches the implementation.
- The change is developed in `.worktree/flow-mode/`, merged into `main`, pushed to the canonical
  upstream, and verified by `git ls-remote` naming the integrated commit. After the push, the
  integration checkout is advanced without discarding its uncommitted work, `.devboard/install.sh`
  updates the installed wrappers, and `cd .devboard && bun run publish` exits 0 with every running
  dashboard reporting `versionState.stale === false` or the explicitly deferred one.

## Verification

All edits, tests, builds, fixtures, and browser acceptance for the change run inside
`<repo root>/.worktree/flow-mode/`, never in the opened checkout. Temporary hosts, bare remotes,
and fixture state stay under that worktree or `.devboard/.tmp`, never under `/tmp`, a home
directory, or a parent. The worktree is merged into `main`, `origin/main` receives the integration
commit, the installed wrappers are refreshed, and `bun run publish` succeeds before the worktree is
removed.

- Run the focused deterministic contract from the worktree:

  ```sh
  cd <repo root>/.worktree/flow-mode/.devboard
  bun install
  bun test server/flow.test.ts
  bun test server/flow-pr.test.ts
  bun test
  bun run build
  ```

  `server/flow.test.ts` drives `createApp` over WebSocket with the deterministic ACP stub and an
  injected fake forge. It asserts: the mode switch sends no command and neither mode's state
  changes; Goal Mode events and activity/question arrays are untouched by Flow events; Flow-active
  and Goal-active refusals; `/flow-goal` and the unchanged `GOAL.md`; `/flow-implement` with one
  spawn, the correct worktree cwd, branch, base, and no issue/tracker calls; restart reuse of the
  worktree; the complete `flowWidgets` and `flowFiles` snapshots; analyst coverage and fallback;
  category attributes and distinct tokens; acceptance persisting while the signature is present and
  disappearing when the diff changes or reverts; a new unaccepted widget after a changed hunk;
  widget detail requesting only its files; the third-party diff renderer input; refusal steering;
  read-only conversation with a queued message, a conclusion written to the decision board and
  steering, and an unchanged worktree diff; steering read/ack across a checkpoint; decision-board
  save and concurrent append; checkpoint fallback and verification badges; questions, answers, and
  blocker dismissal; persistence across a graceful restart with no auto-respawn and a manual
  resume; per-repository isolation under one state directory; and reset refusal with an unmerged
  session.

  `server/flow-pr.test.ts` uses an injected forge and a recording executor. It asserts: no PR
  before the first checkpoint; one draft PR after the first push; later checkpoint pushes without
  force; PR body goal and decisions; manual ready refused while running or dirty and accepted when
  stopped, clean, and draft; merge refused for draft, dirty, conflicted, or running state; a merge
  commit request, never squash or rebase; PR merged and verified; local main fast-forward only on a
  clean `main`; worktree removal, branch ancestry check, local and remote branch deletion, and
  session `merged`; cleanup failure reporting without discarding a dirty worktree or local commits;
  unsupported forge, missing auth, push rejection, and forge failure producing one `flowError`, no
  fake PR, a retry that succeeds, and no issue or tracker command; GitHub and GitLab command shapes;
  and no token in argv.

- Prove the prompt and wrapper contract directly:

  ```sh
  cd <repo root>/.worktree/flow-mode
  test -s .devboard/prompts/flow-goal.md
  test -s .devboard/prompts/flow-implement.md
  test -s .devboard/prompts/flow-change.md
  test -s .devboard/prompts/flow-widget.md
  test -s .devboard/omp/commands/flow-goal.md
  test -s .devboard/omp/commands/flow-implement.md
  test -s .devboard/omp/commands/flow-change.md
  test -s .devboard/omp/commands/flow-widget.md
  grep -q 'prompts/flow-goal.md' .devboard/omp/commands/flow-goal.md
  grep -q 'prompts/flow-implement.md' .devboard/omp/commands/flow-implement.md
  grep -q 'prompts/flow-change.md' .devboard/omp/commands/flow-change.md
  grep -q 'prompts/flow-widget.md' .devboard/omp/commands/flow-widget.md
  ! grep -RniE 'GOAL\.md' .devboard/prompts/flow-goal.md
  ```

  Read the four prompts once and confirm the goal prompt writes only the session goal, the
  implementation prompt enforces worktree-only edits, checkpoint commits, steering and decision
  reads, no merge or push, no issues or epics, verification, and blockers, the analyst prompt is
  read-only and writes structured JSON, and the widget prompt is read-only and receives the widget
  context.

- Prove the diff dependency and renderer contract:

  ```sh
  cd <repo root>/.worktree/flow-mode/.devboard
  bun pm ls | grep -Ei 'diff2html|diff-view|svelte-diff'
  ! grep -RniE 'function .*hunk|parseHunk|split.*@@' client/*.svelte client/*.ts
  ```

  The client imports the maintained renderer and renders `data-testid="flow-diff"`; it does not
  contain a hand-written unified-diff hunk parser.

- Browser acceptance against a fixture host and a local bare `origin`, using the deterministic
  stub agent and the injected fake forge. Start the server from the worktree with `REPO_DIR`,
  `ADRS_DIR`, `GOAL_FILE`, `STATIC_DIR`, `PORT`, and `AGENT_COMMAND` pointing at the fixture, the
  stub, and the fake forge. The fixture host is a real git repository on `main` with a base commit,
  a small source tree, a `GOAL.md` sentinel, and an `adrs/` sentinel; the bare `origin` is inside
  the worktree.

  Open `http://127.0.0.1:<port>/` and verify:

  - Goal is selected; both switch buttons are present. Switch to Flow and back; confirm no
    `start`, `create`, `answer`, or PR command appears in the stub or forge logs and Goal Mode's
    editor and controls are unchanged.
  - In Flow, select `Create flow goal`; confirm one `/flow-goal` spawn, the session directory, the
    interview question, and no `GOAL.md` change (`sha256sum` before and after). Answer; confirm the
    goal text and an enabled `Start implementation`.
  - Select `Start implementation`; confirm exactly one `/flow-implement` spawn, the worktree path
    and branch, live activity, and a first checkpoint commit. Confirm no `gh issue` or tracker call.
  - Confirm widgets appear for the changed files with different `data-category` values and distinct
    colored borders. Accept one; confirm `data-accepted="true"` and that it stays visible while its
    diff is unchanged. Ask the stub to rewrite that hunk; confirm the accepted card disappears and a
    new unaccepted card appears. Revert it; confirm the card disappears.
  - Open a widget; confirm only its files and a side-by-side `flow-diff` with line numbers and
    added/removed colors. Open the changed-file map and confirm the same files and per-file diffs.
  - Save a decision-board edit; confirm it is written verbatim. Open a widget conversation, send a
    message, answer its question, and send a conclusion; confirm the decision board gains a
    timestamped section and a steering note appears. Confirm the implementation stub reads both at
    its next checkpoint and that the worktree diff was not changed by the conversation.
  - Add a steering note while the stub is mid-run; confirm the implementation is not stopped, the
    note appears immediately, the stub reads it before its next checkpoint, the next code change
    reflects it, and the note flips to `read`.
  - Confirm the checkpoint timeline shows the commit summary, files, short id, and verification
    badge; confirm a failed verification is visually distinct. Confirm a pending question is
    answerable and a `DEVBOARD-BLOCKED:` line creates a blocker that can be dismissed.
  - Confirm the draft PR/MR link appears after the first checkpoint and the state is `draft`; make
    another checkpoint and confirm the branch is pushed without force and the PR is updated. Stop;
    select `Mark ready`; confirm the state is `live`. Start the implementation again and confirm
    Ready and Merge are refused while it runs.
  - Stop, select `Merge`, and confirm the fake forge records a merge-commit request, the session
    shows merged, the worktree is gone, the local and remote `flow/<session-id>` branches are gone,
    the bare `origin` main contains the merge, and no uncommitted work was discarded. Confirm Start,
    Ready, and Merge are disabled for the merged session.
  - Restart the server in the middle of a session; reconnect and confirm the session, goal,
    decisions, steering notes, accepted signatures, widgets, files, checkpoints, verification,
    blockers, and PR metadata are restored, the run shows `stopped`, no peer was spawned
    automatically, and Start resumes in the same worktree.
  - With a Flow session unmerged, send `resetImplementation` and confirm one `error` and no
    deletion. With a merged session, confirm reset is allowed.
  - Switch to Goal Mode while Flow is stopped; confirm the Goal editor, controls, and existing
    behavior are unchanged and no Flow error replaced the Goal error banner.

- Verify the PR adapter against a recording executor for both forges, and against a local bare
  remote for cleanup. The tests assert the exact operations (draft create, ready, merge commit,
  branch deletion) and that no token appears in argv. No test contacts a real forge, no test pushes
  to the real `origin`, and no test creates a real issue, epic, PR, or MR.

- Verify persistence and isolation directly: with `stateDir` under the fixture, confirm the session
  directory exists under `flow/<24-hex key>/<session-id>/`, a second fixture repository has a
  different key and cannot see the first session, and `git status --short` in the host checkout
  shows no Flow state file. After a graceful stop and a fresh `createApp`, confirm the restored
  snapshot and that the stub log gained no new spawn until Start was sent.

- Confirm the changed-file set, portability, and containment before merging:

  ```sh
  cd <repo root>/.worktree/flow-mode
  git status --short
  git diff --name-only main
  ! grep -rnE '/home/|/tmp/|dsdenes|devboard\.git' .devboard/server .devboard/client \
    .devboard/prompts .devboard/omp .devboard/tests
  find .devboard -type f \( -name '*.ts' -o -name '*.md' -o -name '*.svelte' -o -name '*.css' \) \
    -print0 | xargs -0 awk 'length > 768 { print FILENAME ":" FNR; failed=1 } END { exit failed }'
  sha256sum GOAL.md adrs/*
  ```

  The changed paths are only those named under Boundaries; the `GOAL.md` and `adrs/` hashes match
  the values before the work; no new test uses `tmpdir()`; and no file is written outside the
  repository root.

- Merge the worktree into `main`, push, and verify the integration:

  ```sh
  cd <repo root>
  git log -1 --format=%H main
  git ls-remote origin refs/heads/main
  git status --short --branch
  ./.devboard/install.sh --force "$(git rev-parse --show-toplevel)"
  cmp .devboard/omp/commands/flow-goal.md .omp/commands/flow-goal.md
  cmp .devboard/omp/commands/flow-implement.md .omp/commands/flow-implement.md
  cmp .devboard/omp/commands/flow-change.md .omp/commands/flow-change.md
  cmp .devboard/omp/commands/flow-widget.md .omp/commands/flow-widget.md
  cd .devboard && bun run publish
  ```

  The two SHAs are equal, `main` is not ahead of `origin/main`, the installed wrappers match, and
  `publish` exits 0 with every dashboard reporting `versionState.stale === false` or the explicitly
  deferred one. Remove the worktree and branch only after these checks.

## Boundaries

Harness mode only. Work in `<repo root>/.worktree/flow-mode/`; merge that worktree directly into
`main`, push `origin main`, verify the remote tip, refresh the installed wrappers, run
`bun run publish`, then delete the worktree and its branch. Never edit the opened checkout except
through that merge, the wrapper install, and the publish refresh. Do not create files outside the
repository root.

Allowed files:

- `.devboard/server/app.ts` and `.devboard/server/index.ts`, for wiring the Flow controller,
  protocol commands, connection replay, mode-exclusive guards, `workActive()`, reset refusal, and
  `AppOptions` injection. Existing Goal Mode handlers and payloads are not rewritten.
- `.devboard/server/flow.ts` (new): session state, goal/implementation lifecycle, worktree and
  branch handling, diff watcher, widget reconciliation, steering and decision board, checkpoints,
  verification, questions and blockers, and persistence.
- `.devboard/server/forge-pr.ts` (new): GitHub/GitLab draft/live/merge adapter, reusing
  `classifyRemote` and `resolveForgeAuth`, with an injectable executor and forge interface.
- `.devboard/server/flow.test.ts` and `.devboard/server/flow-pr.test.ts` (new).
- `.devboard/server/fixtures/stub-agent.ts` for deterministic Flow goal, implementation, analyst,
  widget conversation, checkpoint, steering-read, verification, and blocker modes; a new
  `.devboard/server/fixtures/stub-forge.ts` for the fake forge. Existing stub behavior is unchanged.
- `.devboard/client/App.svelte`, `.devboard/client/FlowMode.svelte` (new), and
  `.devboard/client/app.css` for the mode switch, separate Flow view, widgets, detail diff, file
  map, timeline, verification, questions, blockers, steering, decision board, and PR controls.
  Goal Mode's markup and behavior are preserved when Flow is inactive.
- `.devboard/prompts/flow-goal.md`, `flow-implement.md`, `flow-change.md`, and `flow-widget.md`
  (new), plus their thin wrappers under `.devboard/omp/commands/`.
- `.devboard/package.json` and `.devboard/bun.lock` only to add the maintained diff-rendering
  dependency and its types.
- `.devboard/README.md`.
- `.devboard/goals/flow-mode.md` (this specification).
- `.omp/commands/` only through `.devboard/install.sh`; never hand-edit the installed copy.

Leave untouched: `.devboard/prompts/goal-outcome.md`, `epic-next.md`, `prepare-skills.md`, and
`adr-resolve.md`; `.devboard/extensions/`; `.devboard/server/tracker.ts`, `records.ts`, `goal.ts`,
`journal.ts`, `acp.ts`, `feedback.ts`, and `version.ts`; `.devboard/install.sh`;
`.devboard/setup-devboard.sh`; `.devboard/Dockerfile`; `.devboard/.dockerignore`;
`.devboard/index.html`; `.devboard/vite.config.ts`; `.devboard/svelte.config.js`;
`.devboard/tsconfig.json`; all other files under `.devboard/goals/`; `AGENTS.md`; `GOAL.md`;
`adrs/`; `.omp/` except through the installer; `.gitignore`; `.worktree/persist-state/`; and every
existing host implementation file.

Do not add any dependency other than the maintained diff renderer. Do not copy, merge, or depend on
the unmerged `.worktree/persist-state/` work. Do not change existing Goal Mode command names, event
names, payload shapes, lifecycle stages, lane semantics, pass semantics, goal creation/revision
semantics, skills preparation, ADR records, reset keep set, or publish behavior. The only Goal Mode
behavior additions are the Flow-active refusals, the `workActive()` inclusion, and the reset refusal
for an unmerged Flow session.

Do not create GitHub or GitLab issues or epics from Flow. Do not read the epic tracker for Flow. Do
not write `adrs/` or `GOAL.md`. Do not write the host checkout. Do not force-push, squash, rebase,
amend, or rewrite history. Do not merge or clean up a dirty Flow worktree. Do not apply edits made by
the analyst or widget-conversation peer. Do not auto-resume a live Flow peer after a server restart.
Do not use `tmpdir()`, `/tmp`, home directories, or any path outside the repository root for tests,
fixtures, state, worktrees, or logs. Do not contact a real forge from verification; use the injected
fake, a recording executor, and a local bare remote. Do not push the Flow session branch to the real
`origin` during verification.

## Stop conditions

There is no attempt cap and no token, time, or cost budget. Continue until every success criterion
is verified against the current state, rerunning the focused tests, the full suite, the build, the
browser acceptance, and the persistence checks as needed.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky or
irreversible operation outside the fixture hosts and the final merge-and-push, a missing
prerequisite, or a blocked external dependency. Examples: the worktree cannot be created because
the repository has no `main` and no `origin/main` or an unusable git state; `bun`, `bun test`, or
`bun run build` fails for a reason outside this goal; the integration merge conflicts with `main`
in a way that needs a human decision; `origin` is unreachable or rejects the final push; the
browser runtime is unavailable for the acceptance check; or the installed wrapper copy cannot be
refreshed without overwriting an unrelated host file. A missing `gh`/`glab` binary is not a halt:
the adapter contract is verified with the injected fake and the recording executor, and the real
path is inspected for the required operations.

Do not halt for a failing test, a flaky debounce, a forge flag mismatch, an analyst retry, a PR
retry, a cleanup retry, the number of checkpoints, model latency, or the number of fix-and-rerun
passes. Diagnose, fix, rerun the checks the fix invalidates, integrate any new remote commit,
resolve conflicts, and push again.

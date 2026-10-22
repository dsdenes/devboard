## Objective

In this repository's devboard harness — the Svelte client in `.devboard/client/App.svelte` and the
Bun server in `.devboard/server/app.ts` — add a `Reset Implementation` control. After a two-step
in-page confirmation, the server deletes every top-level entry in the host checkout identified by
`REPO_DIR` except the harness and contract keep set, commits the resulting state on `main`, and
pushes that commit to `origin/main`. Only the harness (`.devboard/`), the installed harness copy
and agent contract (`.omp/`, `AGENTS.md`, `.gitignore`), and the goal document (`GOAL.md`, or the
configured top-level goal file) survive, together with the internal `.git/` and `.worktree/`. The
server keeps running, the goal bytes stay unchanged, and the interface reports the reset commit.

The keep set is exact: `.devboard`, `.omp`, `AGENTS.md`, `.gitignore`, `GOAL.md`, plus the direct
child named by `GOAL_FILE` when that differs from `GOAL.md`. `.git` and `.worktree` are internal
and preserved but are not part of the committed keep set.

## Success criteria

- The page renders a `Reset Implementation` control with `data-testid="reset-implementation"`.
  It is disabled while the WebSocket is not open and while any run, run sequence, lifecycle run,
  goal creation, goal revision, skills preparation, or another reset is active.
- The first click arms the control without sending any WebSocket frame. The page then shows the
  exact keep set (`.devboard`, `.omp`, `AGENTS.md`, `.gitignore`, `GOAL.md`, with `.git` and
  `.worktree` named as internal) and a `Confirm reset` control with
  `data-testid="confirm-reset"`. A reload, a reconnect, a disconnect, or any other command
  disarms it. The second click sends exactly `{ "type": "resetImplementation" }`.
- The server parses `resetImplementation`, broadcasts `{ "type": "implementationResetStarted" }`,
  and performs the reset in the server so a browser disconnect does not interrupt it. A client
  that connects during a reset receives `implementationResetStarted` before its own command
  replies. A second `resetImplementation` while one is running is refused with an `error`.
- Before deleting anything, the server checks that `REPO_DIR` is the repository top level
  (`git rev-parse --show-toplevel` equals `REPO_DIR`), that `git rev-parse --verify HEAD`
  succeeds, that `git symbolic-ref --short HEAD` is exactly `main`, and that
  `git remote get-url origin` succeeds. Any failed check, and any active run, lifecycle,
  creation, revision, skills preparation, or reset, is refused with one `error` and leaves the
  filesystem and git state unchanged.
- On acceptance the server removes every direct child of `REPO_DIR` whose name is not in the keep
  set, including tracked, untracked, and ignored entries. It does not descend into keep-set
  entries, `.git`, or `.worktree`, and it removes a symlink as a link without following it. A
  sentinel file under `.worktree/` survives. Keep-set files keep their exact bytes.
- The reset stages with `git add -A` plus explicit exclusions and commits with
  `git commit --no-verify -m "chore: reset implementation"`. The commit contains the tracked
  implementation deletions and tracks previously untracked keep-set content, including
  `GOAL.md`. It contains no path under `.git/`, `.worktree/`, `.devboard/node_modules/`, or
  `.devboard/dist/`, even when `.gitignore` is absent, and it performs no amend and no history
  rewrite. If `git diff --cached --quiet` reports no change, the server reuses the current
  `HEAD` commit instead of failing.
- After the commit the server runs `git push origin main` with `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=true`, and `NO_COLOR=1`. Success requires exit code 0 and broadcasts
  `{ "type": "implementationResetStopped", "completed": true, "commit": "<40-hex sha>" }`.
  The local `main` SHA and the remote `origin/main` SHA are equal afterwards.
- A push failure broadcasts an `error` containing git's stderr and
  `{ "type": "implementationResetStopped", "completed": false, "commit": "<40-hex sha>" }`. It
  leaves the local reset commit and the deleted tree in place, leaves the remote `main`
  unchanged, and performs no rollback. A commit failure likewise leaves the staged, deleted tree
  in place, reports git's stderr, and broadcasts the failed event without `commit`. A failure
  before deletion, including every precondition, leaves the tree untouched.
- While a reset is running, every mutating or starting command (`saveGoal`, `startRun`,
  `startLifecycle`, `pauseLifecycle`, `resumeLifecycle`, `reviseGoal`, `createGoal`,
  `prepareSkills`, `answer`, and a second `resetImplementation`) is refused with an `error`.
  `listRecords`, `getGoal`, and `getSkills` may still answer.
- After a successful reset the server stays alive and broadcasts, in order:
  `implementationResetStopped`, `lifecycleState` at stage `goal` with pass `1`, `work: null`,
  `paused: false`, `records` with an empty list and `next: null`, and `goal` with the unchanged
  goal text (empty text when the document is absent). `getGoal` and `saveGoal` still work, and a
  later `listRecords` after reconnect still answers empty rather than an error when `adrs/` is
  absent.
- `GOAL.md` may be absent, empty, or whitespace-only; reset is allowed in all three states and
  preserves that state exactly. It never creates or edits the goal document.
- New deterministic tests in `.devboard/server/reset-implementation.test.ts` cover: the command
  and started/stopped events; both confirmation steps and no frame on the first click; deletion
  of tracked, untracked, and ignored entries; keep-set bytes and `.worktree` sentinel survival;
  symlink removal without following; refusal on a non-`main` branch, missing `origin`, a
  non-toplevel `REPO_DIR`, an unborn `HEAD`, a failing pre-commit hook, and an active run; the
  exact commit subject and tree; the staging exclusions with no `.gitignore`; empty-change
  idempotence; a local bare `origin` receiving the commit; a rejecting pre-receive hook producing
  the failed event with the local commit retained; and the post-reset empty-records and goal
  behavior.
- `.devboard/README.md` documents the control and its two-step confirmation, the exact keep set,
  the `resetImplementation` command, `implementationResetStarted` /
  `implementationResetStopped`, the `main` and `origin` preconditions, the push-failure behavior,
  the allowed empty goal, and that reset never starts on load or reconnect.
- `cd .devboard && bun test server/reset-implementation.test.ts` exits 0 with zero failures;
  `cd .devboard && bun test` exits 0 with zero failures; `cd .devboard && bun run build` exits 0.
- The real `omp acp` agent is not involved: reset spawns no peer, emits no `runStarted`,
  `runStopped`, `activity`, or `question` event, and writes no `adrs/` file.
- Existing goal editing, run, lifecycle, goal creation, goal revision, and skills preparation
  behavior is unchanged when no reset is requested.

## Verification

All edits, tests, and builds run in `.worktree/reset-implementation/`; merge that worktree into
`main`, delete the worktree and its branch, and run the browser acceptance against the merged
checkout. Temporary git hosts, bare remotes, and hook scripts live only under
`<repo root>/.worktree/reset-implementation/`, never outside the repository root.

- In the worktree, prove the deterministic contract:

  ```sh
  cd <repo root>/.worktree/reset-implementation/.devboard
  bun test server/reset-implementation.test.ts
  bun test
  bun run build
  ```

  The focused test creates a host git repository on `main` with a local bare `origin`, tracked
  and untracked implementation files, an ignored file, a `.worktree` sentinel, keep-set
  sentinels, and a symlink to an in-repo victim. It sends the WebSocket commands directly and
  asserts every success criterion, including the exact commit subject and remote tree.

- Browser acceptance against a temporary host, not the real repository:

  ```sh
  host="<repo root>/.worktree/reset-implementation/verify-host"
  remote="<repo root>/.worktree/reset-implementation/verify-origin.git"
  mkdir -p "$host" "$remote"
  git -C "$host" init -q -b main
  git -C "$host" config user.name "Devboard Test"
  git -C "$host" config user.email "devboard@example.invalid"
  git init -q --bare "$remote"
  git -C "$host" remote add origin "$remote"
  printf '.worktree/\nignored/\n' > "$host/.gitignore"
  printf '# Goal\n\nKeep this.\n' > "$host/GOAL.md"
  printf 'contract\n' > "$host/AGENTS.md"
  mkdir -p "$host/.devboard" "$host/.omp" "$host/packages" "$host/.worktree" \
    "$host/ignored" "$host/adrs"
  printf 'harness\n' > "$host/.devboard/sentinel.txt"
  printf 'wrappers\n' > "$host/.omp/sentinel.txt"
  printf 'implementation\n' > "$host/packages/code.ts"
  printf 'untracked\n' > "$host/untracked.ts"
  printf 'ignored\n' > "$host/ignored/cache.bin"
  printf 'alive\n' > "$host/.worktree/sentinel.txt"
  printf '# Old\n\n- Status: Accepted\n' > "$host/adrs/0001-old.md"
  git -C "$host" add -A
  git -C "$host" commit -qm "base"
  git -C "$host" push -q origin main
  cd <repo root>/.worktree/reset-implementation/.devboard
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" \
    STATIC_DIR="$PWD/dist" PORT=18182 bun run start
  ```

  Open `http://127.0.0.1:18182/`. Confirm `Reset Implementation` is visible, click it once, and
  confirm no WebSocket frame is sent and `Confirm reset` appears with the keep-set text. Click
  `Confirm reset`; confirm the success status names a commit, the page shows 0 resolved and 0
  pending, and no error appears. Reload: the control is disarmed, no reset is sent, and the goal
  text is unchanged.

  Then assert the host and remote:

  ```sh
  git -C "$host" status --porcelain
  git -C "$host" log -1 --pretty=%s
  git -C "$host" rev-parse main
  git --git-dir="$remote" rev-parse main
  git --git-dir="$remote" ls-tree -r --name-only main
  test -f "$host/.worktree/sentinel.txt"
  test ! -e "$host/packages"
  test ! -e "$host/untracked.ts"
  test ! -e "$host/ignored"
  test ! -e "$host/adrs"
  cmp "$host/GOAL.md" <(printf '# Goal\n\nKeep this.\n')
  ```

  `git status --porcelain` is empty; the log subject is `chore: reset implementation`; the two
  SHAs are equal; the tree lists only `AGENTS.md`, `.devboard/sentinel.txt`, `.gitignore`,
  `.omp/sentinel.txt`, and `GOAL.md`; and every `test` line exits 0.

- Push-failure acceptance in a second temporary host whose bare `origin` has an executable
  `hooks/pre-receive` that exits 1. Confirm the page shows an error containing the hook's
  rejection, `implementationResetStopped` has `completed: false` and the local commit SHA, the
  local host is still reset and committed, and
  `git --git-dir="$remote" rev-parse main` still names the base commit.

- Before merging, confirm the changed paths are only the allowed set:
  `git diff --name-only main` and `git status --porcelain` list no path outside Boundaries; the
  existing `.worktree/show-edit-and-save-the-current/` is untouched; and this exits 0:

  ```sh
  cd .devboard
  ! grep -nE '/home/|dsdenes|devboard\.git' server/app.ts client/App.svelte \
    server/reset-implementation.test.ts
  ```

- Do not press the reset control against the real repository checkout or the real `origin` at any
  point. All destructive acceptance runs use the temporary hosts and bare remotes above.

## Boundaries

Harness mode only. Every edit, build, and automated test happens inside
`<repo root>/.worktree/reset-implementation/`; merge that worktree directly into `main`, then
delete the worktree and its branch. Never edit the opened checkout except by that merge.

Allowed files:

- `.devboard/server/app.ts`
- `.devboard/server/records.ts` (only to answer an empty list when the record directory is absent)
- `.devboard/server/records.test.ts` (only for that absent-directory behavior)
- `.devboard/client/App.svelte`
- `.devboard/client/app.css` (only styles for the reset control and warning)
- `.devboard/server/reset-implementation.test.ts` (new)
- `.devboard/server/fixtures/stub-agent.ts` (only if a deterministic slow run is needed)
- `.devboard/README.md`
- `.devboard/goals/reset-implementation.md` (this specification)

Allowed operations outside the worktree: restarting the local interface with the merged code and
running the temporary-host browser acceptance, whose writes stay under
`<repo root>/.worktree/reset-implementation/`. The acceptance may create local bare remotes and
hooks under that directory. The merged checkout's real `origin` is never pushed to during
verification.

Leave untouched: `.devboard/prompts/`, `.devboard/omp/`, `.devboard/extensions/`,
`.devboard/install.sh`, `.devboard/package.json`, `.devboard/bun.lock`, `.devboard/Dockerfile`,
`.devboard/.dockerignore`, `.devboard/index.html`, `.devboard/vite.config.ts`,
`.devboard/svelte.config.js`, `.devboard/tsconfig.json`, all other files under
`.devboard/goals/`, `AGENTS.md`, `adrs/`, `.omp/`, `.github/`, `.gitignore`, and
`.worktree/show-edit-and-save-the-current/`.

Do not add dependencies. Do not change the keep set at runtime without an explicit code constant
whose value is exactly the set above plus the configured top-level goal file. Do not delete
`.git` or `.worktree`, do not follow symlinks out of the repository, do not force-push, amend, or
rewrite history, and do not stage ignored files. Do not auto-run reset on load, reconnect, or
startup. Do not spawn an ACP peer for reset. Do not weaken any existing refusal or single-agent
rule.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation beyond the approved temporary-host resets, a missing prerequisite, or a
blocked external dependency. Examples: the implementation checkout is not on `main`; git identity
or `origin` is missing in the temporary host; `bun`, the existing dependencies, `bun test`, or
`bun run build` fails for a reason outside this goal; the merge conflicts with `main` in a way that
needs a human decision; or a step would require pushing to or deleting from the real repository.

Do not halt for effort, question count, test cycles, model latency, or the number of fix-and-rerun
passes.

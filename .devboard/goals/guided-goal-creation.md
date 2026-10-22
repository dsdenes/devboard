## Objective

This repository's devboard harness — the browser interface in `.devboard/client/App.svelte`
served by `.devboard/server/app.ts` — gains a guided goal-creation flow for the case where the
host goal is not set. While the goal document is empty, the interface shows a `Create goal`
control; activating it starts the installed `/goal-outcome` skill in one ACP peer owned by the
server, in the background, and relays the skill's activity and interview questions into the
existing activity and question UI. When the skill finishes, the goal editor shows the text the
skill wrote to `<repoDir>/GOAL.md`, so the developer can review it and start the lifecycle. The
flow never starts on page load or reconnect, and a non-empty goal hides the control.

## Success criteria

- While the goal shown by `getGoal` is empty or whitespace-only, the goal section renders a
  `Create goal` button with `data-testid="create-goal"`. Loading, reloading, or reconnecting a
  client with an empty goal does not send `createGoal` and does not spawn an agent.
- The button is enabled only when a goal revision would be allowed and no creation is active; it
  is disabled while an ADR run, a lifecycle advance, a revision, or a creation is in progress.
  It is absent whenever the goal shown by `getGoal` contains non-whitespace text.
- Clicking `Create goal` sends `{ "type": "createGoal" }`; the server broadcasts
  `{ "type": "goalCreationStarted" }` and starts exactly one ACP peer whose prompt is
  `/goal-outcome`. No other agent is spawned for that click.
- Activity and questions from the creation peer are broadcast as the existing `activity` and
  `question` events, and the interface shows a `Creating the goal` section with
  `data-testid="goal-creation-active"`. The first answer is forwarded to the peer exactly as it
  is for a revision; a second answer with the same id is refused.
- The creation run is server-owned: closing the browser does not stop it, and a client that
  connects during it receives `goalCreationStarted`, every activity line recorded so far, and
  the pending question before that client's own command replies.
- When the peer ends, the server reads `<repoDir>/GOAL.md` and broadcasts
  `{ "type": "goalCreationStopped", "completed": true, "text": "<exact file bytes>" }`. The
  textarea shows that text, `[data-testid="goal-state"]` reports `Goal ready`, the
  `create-goal` button is gone, and `[data-testid="start-lifecycle"]` is enabled.
- If `<repoDir>/GOAL.md` cannot be read after the peer ends, the server broadcasts an `error`
  and `{ "type": "goalCreationStopped", "completed": false }` without `text`; the goal editor is
  unchanged and the `Create goal` control remains available.
- The server refuses `createGoal` with one `error` and spawns no peer when `<repoDir>/GOAL.md`
  contains non-whitespace, when that file exists but cannot be read, when a lifecycle run is
  advancing, when an ADR run or sequence is active, when a goal revision is active, or when
  another creation is active. An absent or empty `<repoDir>/GOAL.md` is accepted, including
  while the lifecycle is paused.
- While a creation is active, `startRun`, `startLifecycle`, `resumeLifecycle`, `reviseGoal`, and
  a second `createGoal` are each refused with an `error` and spawn no peer. `getGoal` and
  `saveGoal` keep their existing behavior. If the lifecycle is paused when the creation ends,
  the server replays the suspended `runStarted`, recorded activity, and pending question.
- A creation emits no `runStarted` or `runStopped` and does not read or write `adrs/`.
- With `GOAL_FILE` pointing at a different file, `createGoal` still invokes `/goal-outcome`, the
  completion still reads `<repoDir>/GOAL.md`, and neither the creation flow nor its completion
  overwrites or replaces the configured `GOAL_FILE`. `getGoal` and `saveGoal` continue to use
  `GOAL_FILE`, so a later `getGoal` returns that file's contents. The button's visibility
  follows the `getGoal` text, while the server's start check follows `<repoDir>/GOAL.md`; in the
  default configuration both are the same file.
- The existing revision flow is unchanged: with a set goal, `Revise goal`, the `reviseGoal`
  command, the `goalRevisionStarted`/`goalRevisionStopped` events, and the generic revision
  prompt behave as before, and `reviseGoal` never sends `/goal-outcome`.
- The changed production files are project-agnostic: the creation target is derived from
  `repoDir` through `defaultGoalPath`, and `.devboard/server/app.ts` and
  `.devboard/client/App.svelte` contain no absolute path, host name, or repository identifier.
- `.devboard/README.md` documents the `Create goal` control, the `createGoal` command, the
  `goalCreationStarted` and `goalCreationStopped` events, the `/goal-outcome` invocation, the
  empty-goal condition, the server-side/background behavior, the single-agent refusals, and the
  `<repoDir>/GOAL.md` target.
- `cd .devboard && bun test` exits 0 with zero failures, including new tests in
  `.devboard/server/goal-creation.test.ts` covering the creation start, prompt, activity,
  question/answer, completion text, failures, refusals, reconnect replay, no ADR writes, and the
  custom `GOAL_FILE` behavior. `cd .devboard && bun run build` exits 0.
- `.devboard/prompts/goal-outcome.md`, `.devboard/omp/commands/goal-outcome.md`,
  `.devboard/prompts/goal-spec.md`, `AGENTS.md`, `adrs/`, `.omp/`, and the repository root's
  existing `GOAL.md` are unchanged by the development work. No dependency is added to
  `.devboard/package.json` or `.devboard/bun.lock`.

## Verification

Run the automated checks from the worktree before merging, then the browser check against the
built interface. Runtime checks use a temporary host directory; they never write the repository's
`GOAL.md`.

- `cd .devboard && bun test server/goal-creation.test.ts` exits 0 with zero failures. This covers
  the `createGoal` command, the `/goal-outcome` prompt, `goalCreationStarted`, activity,
  question/answer, completion text read from `<repoDir>/GOAL.md`, unreadable-goal failure,
  every refusal, reconnect replay, the absence of run events, the unchanged ADR directory, and
  the custom `GOAL_FILE` behavior.
- `cd .devboard && bun test` exits 0 with zero failures, proving the existing revision, run,
  lifecycle, app, and install tests still pass.
- `cd .devboard && bun run build` exits 0 and writes `.devboard/dist/index.html`.
- Browser smoke with the stub agent:

  ```bash
  tmp=$(mktemp -d)
  mkdir -p "$tmp/adrs"
  : > "$tmp/GOAL.md"
  cd .devboard
  stub="$PWD/server/fixtures/stub-agent.ts"
  ADRS_DIR="$tmp/adrs" GOAL_FILE="$tmp/GOAL.md" PORT=18080 \
    AGENT_COMMAND="bun $stub --create-goal --goal=$tmp/GOAL.md --log=$tmp/agent.log" \
    bun run start
  ```

  Open `http://127.0.0.1:18080/`.
  - Confirm `[data-testid="goal-state"]` reads `Goal not set` and
    `[data-testid="create-goal"]` is visible.
  - Wait two seconds without clicking and confirm `! grep -q '^spawn' "$tmp/agent.log"`: page
    load spawned nothing and sent no `createGoal`.
  - Click `Create goal`; confirm `[data-testid="goal-creation-active"]`, an activity line, and
    `[data-testid="question"]` appear, and `grep -q '^prompt /goal-outcome$'
    "$tmp/agent.log"` succeeds.
  - Answer the question; confirm `[data-testid="goal-text"]` equals the text the stub wrote to
    `$tmp/GOAL.md`, `goal-state` reads `Goal ready`, `create-goal` is absent, and
    `[data-testid="start-lifecycle"]` is enabled.
  - Reload the page; confirm `create-goal` stays absent because `$tmp/GOAL.md` is non-empty.
  - Clear `$tmp/GOAL.md`, restart the server, click `Create goal`, close the tab before
    answering, and open a new tab. Confirm `goal-creation-active`, the recorded activity, and
    the pending question are replayed and the answer completes the run.
  - With `$tmp/GOAL.md` non-empty after a completed run, send
    `{"type":"createGoal"}` over `/ws` from the browser console and confirm one `error` event
    and no new `^spawn` line in `$tmp/agent.log`.
  - Create an empty file with `: > "$tmp/custom.md"` and restart with
    `GOAL_FILE="$tmp/custom.md"` and an empty `$tmp/GOAL.md`. Click `Create goal`; confirm the
    completion text comes from `$tmp/GOAL.md`,
    `$tmp/custom.md` is unchanged, and a reload returns the empty `$tmp/custom.md` from
    `getGoal`, so `Goal not set` and the button return.
- Boundary checks in the worktree, before merging:
  - `git diff --exit-code main -- .devboard/prompts/goal-outcome.md
    .devboard/omp/commands/goal-outcome.md .devboard/prompts/goal-spec.md AGENTS.md adrs .omp`
    exits 0.
  - `sha256sum GOAL.md` in the opened checkout prints the same digest before the work and after
    all checks. `main` does not track `GOAL.md`, so
    `.worktree/guided-goal-creation/GOAL.md` does not exist. The runtime smoke writes only
    `$tmp/GOAL.md`.
  - `git diff --exit-code main -- .devboard/package.json .devboard/bun.lock` exits 0.
  - `cd .devboard && ! grep -nE '/home/|/repo/|dsdenes' server/app.ts client/App.svelte` exits 0.
  - `git diff --name-only main` lists only files inside the allowed set in Boundaries. The
    repository's existing `.worktree/show-edit-and-save-the-current/` is untouched.

## Boundaries

Harness mode only: every edit, build, and test run happens inside `.devboard/` in an isolated
worktree at `.worktree/guided-goal-creation/`. Merge that worktree directly into `main`, then
delete the worktree and its branch. Do not edit the opened checkout. Do not add `.worktree/` to
git or touch the existing `.worktree/show-edit-and-save-the-current/`.

Allowed files:

- `.devboard/client/App.svelte`
- `.devboard/server/app.ts`
- `.devboard/server/goal-creation.test.ts` (new)
- `.devboard/server/fixtures/stub-agent.ts` (only to add a deterministic creation mode that logs
  the prompt, asks one question, and writes the temporary goal file)
- `.devboard/README.md`
- `.devboard/goals/guided-goal-creation.md` (this specification)

Leave untouched: `.devboard/prompts/goal-outcome.md`, `.devboard/omp/commands/goal-outcome.md`,
`.devboard/prompts/goal-spec.md`, `.devboard/prompts/epic-next.md`,
`.devboard/prompts/adr-resolve.md`, all other files under `.devboard/omp/` and
`.devboard/extensions/`, `.devboard/install.sh`, `.devboard/package.json`,
`.devboard/bun.lock`, `.devboard/Dockerfile`, `.devboard/.dockerignore`, `.devboard/index.html`,
`.devboard/vite.config.ts`, `.devboard/svelte.config.js`, `.devboard/tsconfig.json`, the other
files under `.devboard/goals/`, `AGENTS.md`, `GOAL.md`, `adrs/`, `.omp/`, `.github/`, and
`.gitignore`.

Do not add dependencies. Do not change lifecycle stages, the existing `getGoal`/`saveGoal`
semantics, or the existing `goalRevisionStarted`/`goalRevisionStopped` event shapes. Do not
auto-start creation on load, reconnect, or goal deletion. Do not add a fallback that sends the
prompt file contents when the slash command is unavailable. Do not add an optional brief field;
the skill interviews the developer. Do not copy or rewrite the skill; the server invokes the
installed `/goal-outcome` command, which in turn reads `.devboard/prompts/goal-outcome.md`.

The single-agent rule is preserved: one ADR run, lifecycle run, revision, or creation at a time,
with a paused lifecycle treated as the existing revision flow treats it. The creation target is
always `<repoDir>/GOAL.md`; `GOAL_FILE` remains the path for `getGoal` and `saveGoal`.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity that this goal and the repository cannot resolve, a
risky or irreversible operation, a missing prerequisite, or a blocked external dependency.
Examples: `.devboard/prompts/goal-outcome.md` or `.omp/commands/goal-outcome.md` is missing at
runtime; the ACP peer rejects `/goal-outcome`; `bun` or the existing dependencies cannot run;
`cd .devboard && bun test` or `cd .devboard && bun run build` fails for a reason outside this
goal; or merging the worktree would conflict with `main` in a way that needs a human decision.
Do not halt for effort, question count, test cycles, or the number of fix-and-rerun passes.

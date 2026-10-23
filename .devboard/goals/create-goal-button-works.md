## Objective

In this repository's devboard harness interface — the Svelte client in `.devboard/client/App.svelte`
served by `.devboard/server/app.ts` — clicking `Create goal` while the repository goal is empty
runs the installed `/goal-outcome` skill in the real `omp acp` agent, interviews the developer
through the existing question UI, and ends with the repository's `GOAL.md` written and shown in
the goal editor. A creation that ends without a non-empty goal is reported as a failure, and the
real skill path, not the deterministic stub, is the acceptance path.

## Success criteria

- The interface launched from `.devboard` with no `AGENT_COMMAND` override uses the existing
  `omp acp` default. With an empty, whitespace-only, or absent `GOAL.md`, the goal section shows
  an enabled `Create goal` control (`data-testid="create-goal"`).
- Loading, reloading, or reconnecting a client never sends `createGoal` and never starts an
  agent. A non-empty goal hides the control.
- Clicking `Create goal` sends `{ "type": "createGoal" }`, the server broadcasts
  `goalCreationStarted`, and exactly one `omp acp` peer is started for that click. The interface
  shows `data-testid="goal-creation-active"`, at least one activity line, and at least one
  question asked by the real `/goal-outcome` skill.
- Each real question is rendered in `[data-testid="question"]`, and answering it through the
  existing choice or free-form field forwards the answer once and lets the peer continue. A
  second answer with the same id is refused with an `error`.
- When the real peer ends after the developer answers its questions, the server broadcasts
  `{ "type": "goalCreationStopped", "completed": true, "text": "<bytes>" }` where `<bytes>` is
  exactly the content of `<repo root>/GOAL.md`. That file contains non-whitespace text, the
  textarea shows the same text, the control reads `Recreate goal`, and
  `[data-testid="start-lifecycle"]` is enabled.
- If the peer ends while `<repo root>/GOAL.md` is absent, empty, or whitespace-only, the server
  broadcasts an `error` and `{ "type": "goalCreationStopped", "completed": false }` without
  `text`. The interface shows that error, leaves the textarea and goal state unchanged, and keeps
  `Create goal` available. This replaces the current silent success with empty text.
- A creation emits no `runStarted` or `runStopped`, and it neither reads nor writes `adrs/`.
- Closing the browser does not stop a real creation. A client that connects during it receives
  `goalCreationStarted`, every activity line recorded so far, and the pending real question
  before its own command replies; answering there completes the run.
- While a creation is active, `startRun`, `startLifecycle`, `resumeLifecycle`, `reviseGoal`, and
  a second `createGoal` are each refused with an `error` and spawn no peer. The creation is
  accepted while the lifecycle is paused, and its completion replays the suspended lifecycle
  conversation.
- The existing revision flow is unchanged: `Revise goal`, `reviseGoal`,
  `goalRevisionStarted`/`goalRevisionStopped`, and the generic revision prompt behave as before,
  and `reviseGoal` never sends `/goal-outcome`.
- `.devboard/server/app.ts` and `.devboard/client/App.svelte` contain no absolute path, host
  name, or repository identifier; the creation target remains `<repo root>/GOAL.md` derived from
  `repoDir`, while `getGoal` and `saveGoal` keep using `GOAL_FILE`.
- `.devboard/README.md` documents the real-agent default, the `Create goal` control, the
  `createGoal` command, the `goalCreationStarted`/`goalCreationStopped` events, the
  `/goal-outcome` invocation, the empty-goal condition, server-side/background behavior, the
  single-agent refusals, and that a completion with no non-empty `GOAL.md` is an error.
- `cd .devboard && bun test` exits 0 with zero failures, including tests in
  `.devboard/server/goal-creation.test.ts` for the real prompt, the empty-result failure, every
  refusal, reconnect replay, and no ADR access. `cd .devboard && bun run build` exits 0.
- The deterministic empty-result browser check, the real-skill browser acceptance, and the full
  test suite against the merged `main` state all pass.
- `.devboard/prompts/goal-outcome.md`, `.devboard/omp/commands/goal-outcome.md`,
  `.devboard/prompts/goal-spec.md`, `AGENTS.md`, `adrs/`, `.omp/`, and the other goal files are
  unchanged by the development work. No dependency is added to `.devboard/package.json` or
  `.devboard/bun.lock`.

## Verification

All implementation edits, builds, and automated tests run in an isolated worktree at
`<repo root>/.worktree/create-goal-button-works/`; merge that worktree directly into `main`,
delete the worktree and its branch, and run the browser acceptance against the merged
`<repo root>` checkout.

- In the worktree: `cd .devboard && bun test server/goal-creation.test.ts` exits 0 with zero
  failures, covering the `/goal-outcome` prompt, the new empty-result failure, every refusal,
  reconnect replay, single-agent refusals, and no `adrs/` writes.
- In the worktree: `cd .devboard && bun test` exits 0 with zero failures; `cd .devboard && bun run build`
  exits 0 and writes `.devboard/dist/index.html`.
- Empty-result browser check (deterministic stub, temporary host inside the worktree):

  ```bash
  tmp="<repo root>/.worktree/create-goal-button-works/verify-host"
  mkdir -p "$tmp/adrs"
  : > "$tmp/GOAL.md"
  cd .devboard
  ADRS_DIR="$tmp/adrs" REPO_DIR="$tmp" GOAL_FILE="$tmp/GOAL.md" PORT=18081 \
    AGENT_COMMAND="bun $PWD/server/fixtures/stub-agent.ts --create-goal --no-create-goal-write" \
    bun run start
  ```

  Open `http://127.0.0.1:18081/`, click `Create goal`, answer the stub question, and confirm an
  error appears, `[data-testid="create-goal"]` still reads `Create goal` and is
  present and enabled, `goal-creation-active` is gone, and `$tmp/GOAL.md` is unchanged.
- Real-skill browser acceptance against the merged checkout, with the repository's real
  `GOAL.md` as the deliberate write target:

  ```bash
  cd .devboard
  test ! -s ../GOAL.md   # the target must be empty before the run
  ADRS_DIR="$PWD/../adrs" REPO_DIR="$PWD/.." GOAL_FILE="$PWD/../GOAL.md" \
    PORT=8090 bun run start
  ```

  `AGENT_COMMAND` MUST be unset so the default `omp acp` is used. Open
  `http://127.0.0.1:8090/` and confirm a visible enabled `Create goal`.
  Wait two seconds and confirm no `omp acp` child of the server exists before the click. Click
  `Create goal`; confirm `goal-creation-active`, an activity line, and at least one question
  appear, and that the server has exactly one `omp acp` child (`pgrep -P <server pid> -f "omp acp"`
  prints one pid). Answer every question through the UI until the peer ends. Then confirm the
  server event order, that `<repo root>/GOAL.md` is non-empty, that the textarea equals its exact
  bytes, the control reads `Recreate goal`, and `start-lifecycle` is enabled. Reload the page
  and confirm the control still reads `Recreate goal`.
- Single-agent and reconnect real-skill check: restart the server with `GOAL.md` cleared, click
  `Create goal`, close the tab before answering, open a new tab, confirm
  `goal-creation-active`, the recorded activity, and the pending question are replayed, and
  answer there to complete the run.
- Before merging: `git diff --exit-code main -- .devboard/prompts/goal-outcome.md
  .devboard/omp/commands/goal-outcome.md .devboard/prompts/goal-spec.md AGENTS.md adrs .omp`
  exits 0; `git diff --exit-code main -- .devboard/package.json .devboard/bun.lock` exits 0;
  `cd .devboard && ! grep -nE '/home/|/repo/|dsdenes' server/app.ts client/App.svelte` exits 0;
  `git diff --name-only main` lists only files in the allowed set.
- The only intentional host-data change is the real interview's replacement of
  `<repo root>/GOAL.md`; capture its bytes before and after and confirm the change happened only
  through the browser acceptance run.

## Boundaries

Harness mode only. Every edit, build, and automated test happens inside `.devboard/` in
`<repo root>/.worktree/create-goal-button-works/`; merge that worktree directly into `main`,
then delete the worktree and its branch. Never edit the opened checkout except by that merge and
the real acceptance run's write to `<repo root>/GOAL.md`.

Allowed files:

- `.devboard/server/app.ts`
- `.devboard/client/App.svelte`
- `.devboard/server/goal-creation.test.ts`
- `.devboard/server/fixtures/stub-agent.ts` (only to add a deterministic creation mode that can
  end without writing the goal, for the empty-result check)
- `.devboard/README.md`
- `.devboard/goals/create-goal-button-works.md` (this specification)

Allowed operations outside the worktree: restarting the local interface with the merged code and
running the real `/goal-outcome` acceptance, which may replace `<repo root>/GOAL.md` with the
interviewed goal.

Leave untouched: `.devboard/prompts/goal-outcome.md`, `.devboard/omp/commands/goal-outcome.md`,
`.devboard/prompts/goal-spec.md`, `.devboard/prompts/epic-next.md`,
`.devboard/prompts/adr-resolve.md`, all other files under `.devboard/omp/` and
`.devboard/extensions/`, `.devboard/install.sh`, `.devboard/package.json`, `.devboard/bun.lock`,
`.devboard/Dockerfile`, `.devboard/.dockerignore`, `.devboard/index.html`,
`.devboard/vite.config.ts`, `.devboard/svelte.config.js`, `.devboard/tsconfig.json`, the other
files under `.devboard/goals/`, `AGENTS.md`, `adrs/`, `.omp/`, `.github/`, and `.gitignore`.
Do not touch `.worktree/show-edit-and-save-the-current/`.

Do not add dependencies. Do not change lifecycle stages or the existing `getGoal`/`saveGoal`
semantics. Do not auto-start creation on load, reconnect, or goal deletion. Do not fall back to
sending prompt file contents when `/goal-outcome` is unavailable. Do not copy or rewrite the
skill; the server invokes the installed command.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation beyond the approved `GOAL.md` replacement, a missing prerequisite, or a
blocked external dependency. Examples: `omp acp` cannot start or authenticate, the installed
`/goal-outcome` command is missing or rejected by the peer, the repository `GOAL.md` is already
non-empty when the real acceptance would begin (replacing it then needs explicit approval),
`bun` or existing dependencies cannot run, `bun test` or `bun run build` fails for a reason
outside this goal, or the merge conflicts with `main` in a way that needs a human decision.

Do not halt for effort, question count, test cycles, model latency, or the number of
fix-and-rerun passes.

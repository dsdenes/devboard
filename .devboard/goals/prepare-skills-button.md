## Objective

In this repository's devboard harness interface — the Svelte client in
`.devboard/client/App.svelte` served by `.devboard/server/app.ts` — the goal section offers a
`Prepare Skills` control whenever `<repo root>/GOAL.md` contains non-whitespace text. Selecting it
starts one agent run that uses `GOAL.md` as its only project-specific input, researches current
best practices on the web, and turns them into project-local Agent Skills under
`<repo root>/.omp/skills/<name>/SKILL.md`, focused on software architecture, code organization,
and testing. The run ends with a review of every installed skill that resolves contradictions in
the skills it manages; the interface then shows a Skills panel listing each prepared skill and
`No contradictions`. Selecting the control again replaces only the skills this feature created.

## Success criteria

- With a non-whitespace `GOAL.md` and no active run, lifecycle, goal creation, goal revision, or
  skills preparation, the goal section shows an enabled `Prepare Skills` control
  (`data-testid="prepare-skills"`). It is disabled or refused with an `error` when the goal is
  absent, empty, or whitespace-only, and loading or reconnecting a client never starts a run.
- Clicking the control sends `{ "type": "prepareSkills" }`; the server broadcasts
  `skillsPreparationStarted` and starts exactly one ACP peer whose first prompt is exactly
  `/prepare-skills`. The interface shows `data-testid="skills-preparation-active"`, streams the
  peer's activity into the existing activity log, and renders any interview question in the
  existing question UI.
- The installed `/prepare-skills` command reads `.devboard/prompts/prepare-skills.md`. That
  prompt names `GOAL.md` as the only project-specific input, requires web research before
  authoring, forbids surveying source, ADRs, or configuration, and requires writing skills only
  under the project skill root.
- A successful run leaves at least one managed skill in each of the three categories:
  architecture, code organization, and testing. Every skill is a directory containing
  `SKILL.md` whose frontmatter has a `name` matching the directory, a non-empty `description`,
  `metadata.devboard-managed: "true"`, and a `metadata.devboard-category` of `architecture`,
  `code-organization`, or `testing`. Every `SKILL.md` passes the Agent Skills layout,
  name-format, and description-length rules enforced by the harness test.
- From `<repo root>`, `omp read skill://<name>` returns the `SKILL.md` body for every prepared
  skill, proving that a new agent session in the project discovers the set without extra
  configuration.
- The final pass compares every skill in `<repo root>/.omp/skills/`, not only managed skills.
  It rewrites managed skills until no pair gives incompatible instructions. A successful
  completion reports an empty contradiction list and `No contradictions`; a conflict that would
  require changing an unmanaged skill ends with an `error` naming that skill, leaves the
  unmanaged file byte-identical, and does not report success.
- Completion broadcasts `skillsPreparationStopped` with `completed: true`, the skill list
  (`name`, `description`, `category`), and an empty contradiction list. The Skills panel
  (`data-testid="skills-panel"`) lists every skill with its category and description and shows
  `No contradictions`; reloading, reconnecting, or restarting the server shows the same current
  set read from disk.
- A second run replaces only skills carrying the managed marker. A hand-authored skill placed in
  `.omp/skills/` without that marker survives byte-identical, and generated skills never overwrite
  or delete it. A managed name that collides with an unmanaged skill ends the run with an `error`
  naming the collision instead of overwriting it.
- A failed run — peer error, invalid skill output, unresolvable unmanaged conflict, or unreadable
  goal — ends with `skillsPreparationStopped { completed: false }` and an `error`, leaves the
  previously managed skills unchanged, and leaves the previous Skills panel state visible.
- While skills preparation is active, `startRun`, `startLifecycle`, `resumeLifecycle`,
  `reviseGoal`, `saveGoal`, `createGoal`, and a second `prepareSkills` are each refused with an
  `error` and spawn no peer. `prepareSkills` is accepted only when no run, lifecycle (paused or
  advancing), creation, or revision is active.
- The run never writes `GOAL.md` or anything under `adrs/`, and it installs no third-party skill:
  `npx skills` may be used only to inspect or adapt public skill content, and the final managed
  set is authored locally.
- `.devboard/omp/commands/prepare-skills.md` is the canonical wrapper and
  `.omp/commands/prepare-skills.md` is its byte-identical installed copy. No other file under
  `.omp/` changes.
- `.devboard/README.md` documents the control, the `prepareSkills` command, the
  `skillsPreparationStarted`/`skillsPreparationStopped` events, the Skills panel, the
  `.omp/skills/` target, managed-only replacement, all-skill contradiction review, and the
  GOAL.md precondition.
- `cd .devboard && bun test` exits 0 with zero failures, `cd .devboard && bun run build` exits 0,
  and the existing goal creation, goal revision, lifecycle, pause/resume, ADR run, and install
  behavior still pass their tests.

## Verification

All implementation edits, automated tests, and builds run in an isolated worktree at
`<repo root>/.worktree/prepare-skills-button/`. Merge that worktree directly into `main`, delete
the worktree and its branch, then run the browser acceptance against the merged checkout.

- In the worktree, prove the deterministic contract:

  ```bash
  cd .devboard
  bun test server/skills-preparation.test.ts
  bun test
  bun run build
  ```

  The focused test covers: the `prepareSkills` command and `/prepare-skills` first prompt, one
  peer, activity and question relay, the GOAL.md precondition, every refusal, reconnect replay,
  skill validation and category coverage, managed-only rerun with an unmanaged skill preserved,
  the all-skill contradiction pass, the unresolvable-unmanaged-conflict error, failure leaving the
  previous managed set unchanged, and no GOAL.md or `adrs/` writes.

- Deterministic browser check with the stub peer, using a host inside the worktree:

  ```bash
  host="<repo root>/.worktree/prepare-skills-button/verify-host"
  mkdir -p "$host/adrs" "$host/.omp/commands" "$host/.devboard/prompts"
  cp .devboard/omp/commands/prepare-skills.md "$host/.omp/commands/"
  cp .devboard/prompts/prepare-skills.md "$host/.devboard/prompts/"
  printf '# Goal\n\nShip a documented HTTP API.\n' > "$host/GOAL.md"
  cd .devboard
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" PORT=18082 \
    AGENT_COMMAND="bun $PWD/server/fixtures/stub-agent.ts --prepare-skills" bun run start
  ```

  In the browser, confirm the control, active marker, activity, and completed Skills panel; then
  confirm the expected files exist under `$host/.omp/skills/`, each declares the managed marker
  and a category, and the panel lists the same names. Add a hand-authored skill, click
  `Prepare Skills` again, and confirm that file is byte-identical while managed skills are
  replaced. Confirm a blank `GOAL.md` disables the control and a direct `prepareSkills` command is
  refused with an error.

- Real-agent acceptance, using a second temporary host inside the worktree and the default
  `omp acp` command (no `AGENT_COMMAND` override):

  ```bash
  host="<repo root>/.worktree/prepare-skills-button/real-host"
  mkdir -p "$host/adrs" "$host/.omp/commands" "$host/.devboard/prompts"
  cp .devboard/omp/commands/prepare-skills.md "$host/.omp/commands/"
  cp .devboard/prompts/prepare-skills.md "$host/.devboard/prompts/"
  printf '# Goal\n\nShip a documented HTTP API.\n' > "$host/GOAL.md"
  cd .devboard
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" PORT=18083 \
    bun run start
  ```

  Open `http://127.0.0.1:18083/`, click `Prepare Skills`, answer any interview questions, and
  confirm the activity shows web research before the Skills panel appears. After completion,
  confirm the panel lists at least one skill per category and `No contradictions`; run
  `cd "$host" && omp read skill://<name>` for each listed skill and confirm each returns its
  `SKILL.md`. Read the skill bodies and confirm their guidance is specific to the goal's domain,
  not generic filler. Close and reopen the tab and confirm the panel is replayed from disk.
  Add an unmanaged skill, run the control again, and confirm that file is byte-identical.

- After installing the wrapper, `diff .devboard/omp/commands/prepare-skills.md
  .omp/commands/prepare-skills.md` exits 0, and `git status --porcelain .omp` lists only that
  new command file.
- Before merging, `git diff --exit-code main -- .devboard/prompts/goal-outcome.md
  .devboard/prompts/goal-spec.md .devboard/prompts/epic-next.md .devboard/prompts/adr-resolve.md
  .devboard/install.sh .devboard/package.json .devboard/bun.lock .devboard/Dockerfile AGENTS.md
  adrs GOAL.md` exits 0, and `git diff --name-only main` lists only files in the allowed set.
- The only intentional run-time writes outside `.devboard/` are the skill directories under the
  temporary acceptance hosts and the installed `.omp/commands/prepare-skills.md`. The repository
  root `GOAL.md`, `adrs/`, and every other `.omp/` file keep their original bytes.

## Boundaries

Harness mode only. Edit, build, and test inside `<repo root>/.worktree/prepare-skills-button/`;
merge that worktree directly into `main`, then delete the worktree and its branch. The opened
checkout is changed only by that merge and by installing the new wrapper with
`.devboard/install.sh`; never hand-edit `.omp/`.

Allowed files:

- `.devboard/server/app.ts`
- `.devboard/server/skills-preparation.test.ts` (new)
- `.devboard/server/fixtures/stub-agent.ts` (deterministic preparation mode only)
- `.devboard/client/App.svelte`
- `.devboard/client/app.css` (Skills panel styling only)
- `.devboard/prompts/prepare-skills.md` (new)
- `.devboard/omp/commands/prepare-skills.md` (new)
- `.devboard/README.md`
- `.devboard/goals/prepare-skills-button.md` (this specification)

Allowed outside the worktree: `.devboard/install.sh` may create
`<repo root>/.omp/commands/prepare-skills.md`; acceptance runs may write only inside their
temporary hosts under `.worktree/prepare-skills-button/`.

Leave untouched: every other file under `.devboard/`, including the existing goal creation,
revision, lifecycle, pause/resume, tracker, records, and install code and tests;
`.devboard/package.json`; `.devboard/bun.lock`; `.devboard/install.sh`; `.devboard/Dockerfile`;
`.devboard/.dockerignore`;
the other files under `.devboard/goals/`; `.devboard/omp/extensions/`; `.devboard/extensions/`;
`AGENTS.md`; `adrs/`; root `GOAL.md`; every `.omp/` file except the installed
`commands/prepare-skills.md`; `.github/`; `.gitignore`; `.worktree/show-edit-and-save-the-current/`.

Do not add dependencies. Do not install third-party skills. Do not change existing WebSocket
message or event semantics. Do not copy prompt text into the server; the server invokes the
installed command. Do not auto-start preparation on load, reconnect, or goal save. Do not weaken
the single-agent rule or the existing goal and lifecycle refusals.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation beyond the approved wrapper installation and temporary acceptance
hosts, a missing prerequisite, or a blocked external dependency. Examples: `omp acp` cannot
start or authenticate; web research is unavailable, in which case do not fabricate guidance;
`npx skills` or the network fails; the real agent cannot produce a valid skill in the temporary
host; `bun test` or `bun run build` fails for a reason outside this goal; `install.sh` refuses a
differing installed file; or the merge conflicts with `main` in a way that needs a human decision.

Do not halt for effort, question count, test cycles, model latency, or the number of
fix-and-rerun passes.

## Objective

In this repository's devboard harness — the `/prepare-skills` prompt at
`.devboard/prompts/prepare-skills.md`, its wrapper, the `prepareSkills` flow in
`.devboard/server/app.ts`, the Skills panel in `.devboard/client/App.svelte`, the tests, and
`.devboard/README.md` — a prepared Agent Skill is project-agnostic. It states relevant public
standards, general best practices, software-architecture patterns, and testing patterns that
another project could adopt, and it carries none of this host's project name, paths, files,
modules, symbols, packages, dependencies, technology choices, data formats, API shapes, or
concrete design and layout decisions; those stay with the implementation agent. `GOAL.md`
remains the only project-specific input and is read only to select which standards and pattern
families are relevant, never as an implementation brief. The agent decides how many skills to
prepare and which topics they cover; the harness enforces no fixed category taxonomy, only the
managed marker, name and description rules, a non-empty managed set, and the existing all-skill
contradiction review. After the change is merged, the real flow runs against this checkout's
`GOAL.md` and replaces its five existing managed, project-specific skills with project-agnostic
ones.

## Success criteria

**Prompt contract.** `.devboard/prompts/prepare-skills.md` satisfies all of the following.

- Its frontmatter description and body describe project-agnostic skills grounded in relevant
  public standards, general best practices, software-architecture patterns, and testing
  patterns.
- It keeps `GOAL.md` as the only project-specific input: read once, used only to select which
  standards and pattern families apply, never copied or paraphrased into a skill. It still
  forbids surveying source code, `adrs/`, configuration, manifests, build files, tests, README
  files, and directory trees, and forbids inferring implementation facts.
- It requires web research before authoring, in public standards, general best practices,
  architecture patterns, and testing patterns, and still halts when research is unavailable.
- It states, in the authoring rules, that a skill must not contain project-specific
  implementation detail: no host or product name, repository or absolute path, directory or file
  name, module, class, function, type, package, dependency, framework, runtime, library,
  language, data format, API shape, schema, configuration key, or concrete architecture, layout,
  or design decision. It permits public domain names, formats, and standard identifiers.
- It lets the agent choose the number of skills and their topics, requires at least one skill,
  and contains no fixed category table, no `devboard-category` value, no category coverage
  requirement, and no fixed skill count.
- It keeps the `SKILL.md` frontmatter shape with `name`, `description`, and
  `metadata.devboard-managed: "true"`, the existing name/description limits, imperative
  directive bullets, and the internal-consistency rule.
- It keeps managed-only replacement, the ban on installing third-party skills, the contradiction
  review of every installed skill, and every existing halt reason.
- It adds no separate project-agnosticism review phase, no server content scanner, and no
  required provenance line, source list, or citation field.

**Wrapper.** `.devboard/omp/commands/prepare-skills.md` describes project-agnostic skills
grounded in public standards and patterns instead of promising architecture, code organization,
and testing categories; its final line still instructs the agent to read
`.devboard/prompts/prepare-skills.md` and nothing else. After installation,
`<repo root>/.omp/commands/prepare-skills.md` is byte-identical to it.

**Server.** `.devboard/server/app.ts` removes `SkillCategory`, `SKILL_CATEGORIES`, category
parsing, category validation, and category coverage checks. A skill summary carries exactly
`name` and `description`. A run that finishes with zero managed skills fails with an `error`,
broadcasts `skillsPreparationStopped { completed: false }`, and restores the pre-run skills
snapshot. All other preparation behavior is unchanged: the managed marker, name and description
validation, name-collision failure, unmanaged-byte preservation, all-skill contradiction review,
snapshot restore on failure, refusals, replay, and the non-whitespace `GOAL.md` precondition.

**Client.** `.devboard/client/App.svelte` has no `SkillCategory` type, category guard, category
property, or category markup. `skillsState`, `skillsPreparationStopped`, and the Skills panel
accept and render summaries with only `name` and `description`; the panel still exposes
`data-testid="skills-panel"`, one `data-testid="skill"` per skill with `data-name`, each name and
description, and `No contradictions`. `.devboard/client/app.css` drops the `.skill-category`
rule. No other UI behavior changes.

**Tests.** `cd .devboard && bun test server/skills-preparation.test.ts` exits 0. Its assertions
cover the project-agnostic prompt rules above, the absence of `devboard-category` and fixed
categories from the prompt and fixtures, name and description validation, zero-managed-set
failure with snapshot restore, managed-only replacement with an unmanaged skill preserved, the
all-skill contradiction pass, the collision and invalid-output failures, and replay. The stub
skills are project-agnostic and carry no category. `cd .devboard && bun test` exits 0 and
`cd .devboard && bun run build` exits 0.

**Docs.** `.devboard/README.md` states that preparation produces project-agnostic skills
grounded in relevant public standards, general best practices, architecture patterns, and
testing patterns; that `GOAL.md` only selects relevance and is never an implementation brief;
that the agent chooses the skills and their count; that no category metadata is required or
validated; and that the managed marker, non-empty managed set, managed-only replacement,
contradiction review, and every existing refusal remain. It contains no claim that categories
are validated or required.

**Real-agent acceptance.** In a temporary host inside the worktree whose `GOAL.md` names the
project `QuasarLattice`, the file `src/quasar/lattice-core.ts`, the symbol `encodeFragment`, the
type `Uint8Array`, the dependency `msgpack-ultra`, the language TypeScript, and the instruction
"use a monorepo with exactly three packages", a real `/prepare-skills` run leaves at least one
managed skill and no generated `SKILL.md` contains `QuasarLattice`, `quasar`, `TypeScript`,
`lattice-core`, `encodeFragment`, `Uint8Array`, `msgpack-ultra`, `monorepo`, `three packages`,
`src/`, an absolute path, or the temporary host path. Every generated skill has the managed
marker, a frontmatter name matching its directory, a non-empty description no longer than 1024
characters, and at least one imperative directive; the panel lists the same names and
descriptions with `No contradictions`, and `omp read skill://<name>` returns each body.

**Repo regeneration.** After the change is merged, the real flow runs against
`<repo root>/GOAL.md` and replaces all five existing managed skills. The resulting managed set
is non-empty and project-agnostic: no generated `SKILL.md` contains `msgpack-javascript`, the
phrase "this MessagePack library" or "this project", a JavaScript or TypeScript technology
choice, a repository path, `.devboard`, or an absolute path. The panel and `skillsState` list
the same skills read from disk after a reload, `No contradictions` is reported, and
`GOAL.md` and `adrs/` keep their pre-run bytes and status.

## Verification

All implementation edits, tests, and builds run in an isolated worktree at
`<repo root>/.worktree/project-agnostic-skills/`. Merge that worktree directly into `main`,
delete the worktree and its branch, then run installation and regeneration against the merged
checkout. Never rewrite history.

- In the worktree, prove the deterministic contract:

  ```bash
  cd .devboard
  bun test server/skills-preparation.test.ts
  bun test
  bun run build
  ```

- In the worktree, confirm the category taxonomy is gone from the produced sources and docs:

  ```bash
  cd <repo root>/.worktree/project-agnostic-skills
  grep -Rn "devboard-category\|SKILL_CATEGORIES\|SkillCategory" \
    .devboard/prompts/prepare-skills.md .devboard/omp/commands/prepare-skills.md \
    .devboard/server/app.ts .devboard/server/skills-preparation.test.ts \
    .devboard/server/fixtures/stub-agent.ts .devboard/client/App.svelte \
    .devboard/client/app.css .devboard/README.md
  ```

  This command must exit 1 with no output. The historical
  `.devboard/goals/prepare-skills-button.md` is exempt and stays unchanged.

- Inspect `.devboard/prompts/prepare-skills.md` and confirm every prompt-contract bullet above,
  including `project-agnostic`, the prohibition list, the relevance-only role of `GOAL.md`, the
  research areas, at least one skill, and the absence of a fixed count, category table,
  provenance line, or citation requirement. Confirm the wrapper's final line still points at the
  prompt.

- Deterministic browser check with the stub peer, using a host inside the worktree:

  ```bash
  host="<repo root>/.worktree/project-agnostic-skills/verify-host"
  mkdir -p "$host/adrs" "$host/.omp/commands" "$host/.devboard/prompts"
  cp .devboard/omp/commands/prepare-skills.md "$host/.omp/commands/"
  cp .devboard/prompts/prepare-skills.md "$host/.devboard/prompts/"
  printf '# Goal\n\nShip a documented HTTP API.\n' > "$host/GOAL.md"
  cd .devboard
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" PORT=18082 \
    AGENT_COMMAND="bun $PWD/server/fixtures/stub-agent.ts --prepare-skills" bun run start
  ```

  Open `http://127.0.0.1:18082/`, click `Prepare Skills`, and confirm the active marker, the
  activity stream, and the completed Skills panel. The panel lists each name and description
  with no category label and `No contradictions`. Confirm every file under
  `$host/.omp/skills/` declares `metadata.devboard-managed: "true"`, its frontmatter name matches
  its directory, and it has a non-empty description. Add a hand-authored unmanaged skill, run
  `Prepare Skills` again, and confirm that file is byte-identical while managed skills are
  replaced. Confirm a blank `GOAL.md` disables the control and a direct `prepareSkills` command
  is refused with an error. Stop the server and remove the temporary host only through the
  worktree cleanup.

- Real-agent acceptance in a second temporary host, with the default `omp acp` command and a
  goal seeded with unique implementation tokens:

  ```bash
  host="<repo root>/.worktree/project-agnostic-skills/real-host"
  mkdir -p "$host/adrs" "$host/.omp/commands" "$host/.devboard/prompts"
  cp .devboard/omp/commands/prepare-skills.md "$host/.omp/commands/"
  cp .devboard/prompts/prepare-skills.md "$host/.devboard/prompts/"
  printf '%s\n' \
    '# Goal' \
    '' \
    'Build QuasarLattice, a TypeScript library in src/quasar/lattice-core.ts that exposes' \
    'encodeFragment(bytes: Uint8Array): string and depends on msgpack-ultra. Use a monorepo with' \
    'exactly three packages.' > "$host/GOAL.md"
  cd .devboard
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" PORT=18083 bun run start
  ```

  Open `http://127.0.0.1:18083/`, click `Prepare Skills`, answer any interview questions, and
  confirm the activity shows web research before the panel appears. After completion run:

  ```bash
  test -n "$(find "$host/.omp/skills" -name SKILL.md -print -quit)"
  ! grep -RniE 'quasarlattice|quasar|typescript|lattice-core|encodefragment|uint8array|msgpack-ultra|monorepo|three packages|src/' "$host/.omp/skills"
  ! grep -RnE '/home/|/tmp/|\.devboard' "$host/.omp/skills"
  cd "$host"
  for name in $(ls .omp/skills); do omp read "skill://$name" > /dev/null; done
  ```

  In the browser, confirm the panel lists every generated skill with its description and
  `No contradictions`, and that no generated skill body names the seeded tokens or a concrete
  implementation decision. Read the bodies and confirm every directive is portable policy in
  public standards, general best practice, architecture patterns, or testing patterns, not an
  instruction tied to this host.

- After merging, install the wrapper and confirm the byte-identical copy:

  ```bash
  cd <repo root>/.devboard
  ./install.sh --force <repo root>
  diff .devboard/omp/commands/prepare-skills.md <repo root>/.omp/commands/prepare-skills.md
  ```

- Regenerate this checkout's managed skills with the real agent. Record `GOAL.md` hashes and the
  current `adrs/` contents first, then start the merged interface and click `Prepare Skills`:

  ```bash
  cd <repo root>/.devboard
  ADRS_DIR=<repo root>/adrs REPO_DIR=<repo root> GOAL_FILE=<repo root>/GOAL.md PORT=18084 \
    bun run start
  ```

  After completion, confirm the five previous managed directories are replaced, the managed set
  is non-empty, and:

  ```bash
  cd <repo root>
  ! grep -RniE 'msgpack-javascript|this (messagepack )?(library|project|repository|codebase)|javascript|typescript|node\.js|nodejs|\bbun\b|/home/|\.devboard|src/|package\.json' .omp/skills
  for name in $(ls .omp/skills); do omp read "skill://$name" > /dev/null; done
  ```

  Confirm the panel and a reloaded `skillsState` list the same names and descriptions, report
  `No contradictions`, and that `GOAL.md` and `adrs/` are byte-identical to the recorded
  baseline. Restart the interface with the same paths after the `.devboard/` changes, as
  `.devboard/AGENTS.md` requires, and confirm it answers on its port.

- Finally, in the worktree before merging, `git status --porcelain` lists only files in the
  allowed set; after the merge, `git diff --exit-code main -- <untouched paths>` exits 0.

## Boundaries

Harness mode only. Create and work in `<repo root>/.worktree/project-agnostic-skills/`; edit,
build, and test only there. Merge that worktree directly into `main`, then delete the worktree
and its branch. The opened checkout changes only by that merge, by `install.sh --force`
updating the installed wrapper, and by the approved regeneration of managed skills under
`<repo root>/.omp/skills/`.

Allowed files:

- `.devboard/prompts/prepare-skills.md`
- `.devboard/omp/commands/prepare-skills.md`
- `.devboard/server/app.ts`
- `.devboard/server/skills-preparation.test.ts`
- `.devboard/server/fixtures/stub-agent.ts` (deterministic preparation mode only)
- `.devboard/client/App.svelte`
- `.devboard/client/app.css` (only to remove category styling)
- `.devboard/README.md`
- `.devboard/goals/project-agnostic-skills.md` (this specification)

Allowed outside the worktree: `.devboard/install.sh --force <repo root>` may update
`<repo root>/.omp/commands/prepare-skills.md` and rewrite byte-identical installed files; the
acceptance runs may write only inside their temporary hosts under the worktree; the merged
regeneration may delete and replace managed directories under `<repo root>/.omp/skills/` and
write nothing else.

Leave untouched: every other file under `.devboard/`, including the other prompt files
(`goal-outcome.md`, `goal-spec.md`, `epic-next.md`, `adr-resolve.md`); every other command and
extension; `.devboard/install.sh`; `.devboard/package.json`; `.devboard/bun.lock`;
`.devboard/Dockerfile`; `.devboard/.dockerignore`; `.devboard/index.html`; the Vite, TypeScript,
and Svelte configuration; the other files under `.devboard/goals/`, especially
`.devboard/goals/prepare-skills-button.md`; `AGENTS.md`; `adrs/`, whose current working-tree
state must stay exactly as it is; root `GOAL.md`; every `.omp/` path except the installed
`commands/prepare-skills.md` and the managed directories the approved regeneration replaces;
`.github/`; `.gitignore`; `.worktree/show-edit-and-save-the-current/`.

Do not add dependencies. Do not add a server-side content scanner, a provenance-line
requirement, or a project-agnosticism review phase. Do not change contradiction detection,
managed-only replacement, the unmanaged-byte check, snapshot restore, refusals, or replay. Do
not add, remove, or rename WebSocket event types; the only payload change is dropping `category`
from each skill summary. Do not auto-start preparation on load, reconnect, or goal save. Do not
weaken the single-agent rule. Do not copy prompt text into the server.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation beyond the approved wrapper installation, temporary acceptance hosts,
and managed-skill regeneration, a missing prerequisite, or a blocked external dependency.
Examples: `omp acp` cannot start or authenticate; web research is unavailable; the model
endpoint is unreachable; `bun test` or `bun run build` fails for a reason outside this goal;
`install.sh` refuses a differing installed file even with `--force`; or the merge conflicts with
`main` in a way that needs a human decision. A real-agent run that produces weak, invalid, or
still project-specific skills is not a halt: correct the prompt or fixtures and rerun, without
an attempt cap.

Do not halt for effort, question count, test cycles, model latency, or the number of
fix-and-rerun passes.

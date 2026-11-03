## Objective

The package ships one more project-scoped builtin skill, `devboard-architectural-layering`, whose
`SKILL.md` states the separation-of-concerns and architectural-layering policy: every concern
belongs to a clearly defined architectural boundary, dependencies follow the architecture's
defined direction, and infrastructure details never leak into business abstractions. The skill
installs into `<host>/.omp/skills/devboard-architectural-layering/` on every install, update, and
automatic replacement, is discoverable by an `omp` session at the host root, and appears on the
Devboard Skills page as a `Managed` row with no delete control.

## Success criteria

- `.devboard/omp/skills/devboard-architectural-layering/SKILL.md` exists; its frontmatter declares
  `name: devboard-architectural-layering`, a non-empty description of at most 1024 characters,
  and `metadata.devboard-builtin: "true"`, and carries no `metadata.devboard-managed` key.
- The skill body carries a level-one `# Architectural Layering` heading and these level-two
  sections in order: `## Architectural Constraint`, `## Design Principles`,
  `## Architectural Violations`, `## Architectural Boundaries`, `## Fundamental Constraint`.
- `## Design Principles` holds exactly eight bold-labelled bullets: `Separation of concerns`,
  `Explicit architectural boundaries`, `Consistent dependency direction`,
  `Business logic independence`, `Encapsulation of technical concerns`,
  `Controlled cross-layer interaction`, `Architectural consistency`, `Appropriate abstraction`.
- `## Architectural Violations` holds exactly nine bold-labelled bullets: `Mixed concerns`,
  `Boundary violations`, `Dependency inversion violations`, `Infrastructure leakage`,
  `Misplaced responsibilities`, `Layer bypassing`, `Circular architectural dependencies`,
  `Inconsistent layering`, `Artificial layering`.
- `## Architectural Boundaries` states that the policy is independent of a specific architectural
  style and names traditional layered architecture, Clean Architecture, Onion Architecture, and
  Hexagonal Architecture; it names `Interface / Presentation`, `Application`, `Domain`, and
  `Infrastructure` as conceptual responsibilities, and states that they are not a mandatory
  four-layer structure and that the project's established architecture determines the actual
  boundaries and dependency directions.
- `## Fundamental Constraint` states in one bolded sentence that every concern belongs to a
  clearly defined architectural boundary and that dependencies must respect those boundaries, and
  the section states that layering is not about directory organization or added abstractions.
- `.omp/skills/devboard-architectural-layering/SKILL.md` is tracked by git, is byte-identical to
  the canonical file, and carries the same `devboard-builtin` marker.
- `install.sh` into an empty fixture host copies the whole skill directory byte for byte and adds
  exactly one `/.omp/skills/devboard-architectural-layering` line to the host `.gitignore`; a
  second run reports `0 file(s) installed`, rewrites no byte, and adds no second ignore line.
- `managedSkillNames` in `.devboard/bin/devboard.mjs`, `syncSkills` in
  `.devboard/lib/host-sync.mjs`, and the `doctor` skills check need no source change: they discover
  the new directory through the `devboard-` prefix. `verify:install`'s `doctor` step prints one
  `PASS skills:` line that names `devboard-architectural-layering`, its existing tampered-byte case
  still fails that check, and no doctor check reports the new skill missing or differing.
- `.devboard/tests/install.test.ts` and `.devboard/tests/launcher.test.ts` list the new name in
  their `MANAGED_SKILLS` / shipped-skill name lists, and the launcher frontmatter case validates
  the new `SKILL.md`; `cd .devboard && bun test tests/install.test.ts tests/launcher.test.ts`
  exits 0.
- `.devboard/scripts/verify-install.ts` and `.devboard/scripts/verify-update.ts` list the new name
  in `MANAGED_SKILLS`, and `cd .devboard && bun run verify:install` and
  `cd .devboard && bun run verify:update` each exit 0.
- `.devboard/scripts/verify-interface.ts` copies the new skill into its fixture host and includes
  it in `devboardBuiltins`; `cd .devboard && bun run verify:interface` exits 0, and its Skills-page
  assertions cover the new row: it renders once, carries the `Managed` marker, and carries no
  delete control.
- `.devboard/README.md`'s Skills section says the package ships five skills, lists
  `devboard-architectural-layering` in its table with a description of the policy, and names
  `/.omp/skills/devboard-architectural-layering` among the `install` gitignore entries.
- `AGENTS.md` and `.devboard/templates/host-AGENTS.md` both name the new skill among the shipped
  ones, are byte-identical to each other, and stay under the repository's 768-byte line limit.
- The pre-existing four `SKILL.md` files under `.devboard/omp/skills/` and their `.omp/skills/`
  copies are byte-identical to their pre-change bytes, and no unmarked host skill under
  `.omp/skills/` is read, rewritten, or deleted by the change.
- From a fixture host installed by `install.sh`, `omp skill list` run at that host's root prints a
  line naming `devboard-architectural-layering`.
- `cd .devboard && bun test`, `cd .devboard && bun run check`, and `cd .devboard && bun run build`
  each exit 0.
- The work is merged to `main`, pushed to `origin`, and released by the Release Train: the
  published npm tarball for the released version contains
  `package/omp/skills/devboard-architectural-layering/SKILL.md` with the builtin marker.

## Verification

Run inside `.worktree/<name>`; run the post-merge checks again on `main` after the merge and push.

- Canonical file and marker:
  ```
  skill=.devboard/omp/skills/devboard-architectural-layering/SKILL.md
  test -f "$skill"
  sed -n '1,6p' "$skill"
  grep -c '^  devboard-builtin: "true"$' "$skill"
  grep -n 'devboard-managed' "$skill"
  ```
  prints `name: devboard-architectural-layering` and `metadata:` with the marker, the count is `1`,
  and the `devboard-managed` grep prints nothing.
- Section, principle, and violation coverage:
  ```
  skill=.devboard/omp/skills/devboard-architectural-layering/SKILL.md
  grep -n '^## ' "$skill"
  for label in 'Separation of concerns' 'Explicit architectural boundaries' \
    'Consistent dependency direction' 'Business logic independence' \
    'Encapsulation of technical concerns' 'Controlled cross-layer interaction' \
    'Architectural consistency' 'Appropriate abstraction' 'Mixed concerns' \
    'Boundary violations' 'Dependency inversion violations' 'Infrastructure leakage' \
    'Misplaced responsibilities' 'Layer bypassing' 'Circular architectural dependencies' \
    'Inconsistent layering' 'Artificial layering'; do
    grep -qF "**$label:**" "$skill" || exit 1
  done
  ```
  exits 0; the heading list shows exactly `## Architectural Constraint`, `## Design Principles`,
  `## Architectural Violations`, `## Architectural Boundaries`, and `## Fundamental Constraint`,
  in that order.
- Title proof: `grep -c '^# Architectural Layering$' "$skill"` prints `1`.
- Installed copy proof, after `.devboard/install.sh "$(git rev-parse --show-toplevel)"`:
  ```
  cmp -s .devboard/omp/skills/devboard-architectural-layering/SKILL.md \
    .omp/skills/devboard-architectural-layering/SKILL.md
  git ls-files --error-unmatch .omp/skills/devboard-architectural-layering/SKILL.md
  ```
  exits 0.
- Fixture-host install proof:
  ```
  h=.devboard/.tmp/layering-skill-proof; rm -rf "$h"; mkdir -p "$h/.devboard"; git -C "$h" init -q
  .devboard/install.sh "$h"
  diff -r .devboard/omp/skills "$h/.omp/skills"
  grep -c '^/.omp/skills/devboard-architectural-layering$' "$h/.gitignore"
  .devboard/install.sh "$h"
  ```
  prints nothing from `diff -r`, `1` from the first ignore count, and `0 file(s) installed` from the
  second install.
- Discovery proof: with the installed copy present, from the repo root `omp skill list` prints a
  tab-separated line whose first field is `devboard-architectural-layering` and whose second field
  is the skill description.
- Harness checks, from `.devboard`:
  ```
  bun test
  bun run check
  bun run build
  bun run verify:install
  bun run verify:update
  bun run verify:interface
  ```
  each exits 0. `verify:interface` opens its own fixture dashboard; never launch a dashboard by
  hand.
- Documentation proof:
  ```
  grep -n 'ships five' .devboard/README.md
  grep -n 'devboard-architectural-layering' .devboard/README.md AGENTS.md \
    .devboard/templates/host-AGENTS.md
  cmp -s AGENTS.md .devboard/templates/host-AGENTS.md
  awk 'length > 768 {print FILENAME": "FNR}' .devboard/README.md AGENTS.md \
    .devboard/templates/host-AGENTS.md .devboard/omp/skills/devboard-architectural-layering/SKILL.md
  ```
  the first prints the five-skill sentence, the second names the new skill in all three files, the
  `cmp` exits 0, and `awk` prints nothing.
- Untouched proof:
  ```
  git diff --exit-code main -- .devboard/omp/skills/devboard-ui-ux \
    .devboard/omp/skills/devboard-restful-api-implementation \
    .devboard/omp/skills/devboard-single-responsibility-principle \
    .devboard/omp/skills/devboard-consistent-naming
  git status --porcelain .omp/skills/dependency-boundaries .omp/skills/benchmark-methodology
  ```
  both print nothing.
- After the push: `git ls-remote origin refs/heads/main` names the integrated commit,
  `git status --short --branch` reports no commits ahead of the upstream, the Release Train's
  released version is visible with `npm view @dsdenes/devboard version`, and
  `npm pack @dsdenes/devboard@<version> --pack-destination .devboard/.tmp` followed by
  `tar xOf .devboard/.tmp/dsdenes-devboard-<version>.tgz
  package/omp/skills/devboard-architectural-layering/SKILL.md` prints the canonical bytes.

## Boundaries

- Do all work in `.worktree/<name>` inside the repo root; never edit the opened checkout. Every
  fixture host, pack destination, and temporary file lives under the worktree or
  `.devboard/.tmp/`; nothing is created outside the repo root, including under `/tmp` or `$HOME`.
- Allowed to create: `.devboard/omp/skills/devboard-architectural-layering/SKILL.md` and, through
  `.devboard/install.sh`, `.omp/skills/devboard-architectural-layering/SKILL.md`.
- Allowed to edit: `.devboard/tests/install.test.ts`, `.devboard/tests/launcher.test.ts`,
  `.devboard/scripts/verify-install.ts`, `.devboard/scripts/verify-update.ts`,
  `.devboard/scripts/verify-interface.ts`, `.devboard/README.md`, `AGENTS.md`, and
  `.devboard/templates/host-AGENTS.md`.
- Untouched: `.devboard/install.sh`, `.devboard/lib/host-sync.mjs`,
  `.devboard/bin/devboard.mjs`, `.devboard/server/app.ts`, `.devboard/client/**`,
  `.devboard/prompts/**`, `.devboard/omp/commands/**`, `.devboard/omp/extensions/**`,
  every existing `SKILL.md` under `.devboard/omp/skills/` and `.omp/skills/`, every unmarked host
  skill, `adrs/`, `GOAL.md`, `.devboard/dist/`, `node_modules/`, `.design/`, and `.worktree/`
  other than this task's own directory.
- The installed `.omp/skills/devboard-architectural-layering/` copy is written by
  `.devboard/install.sh` and never hand-edited; the canonical file is the source and the two stay
  byte-identical.
- The new skill stays a single `SKILL.md` with no `references/` tree and no `scripts/`: no audit
  command, prompt, worker, settings, persisted state, MCP tool, or interface surface is added for
  it.
- Forbidden shortcuts: adding a dependency, force-pushing, rewriting published history, running
  `bun run publish` by hand, dispatching the release workflow by hand, killing or spawning a
  dashboard by hand, making the new skill deletable or giving it `devboard-managed`, and
  substituting a host-level skill or a `$HOME` skill for the shipped builtin.

## Stop conditions

There is no attempt cap, no token budget, and no time limit: continue until every success
criterion is verified against current state. Halt and surface only for genuine ambiguity the
draft, this spec, and the repository cannot resolve; a missing prerequisite such as `bun`, `git`,
`omp`, npm, or forge write access being unavailable; an external dependency that cannot be
reached, such as npm or the Gitea release source; or a risky irreversible operation this goal does
not authorize, such as force-pushing, rewriting published history, or writing outside the repo
root. A failed attempt is never reported as a satisfied criterion, and a narrower skill, a
scaffold, a mock, or a local-only commit never substitutes for a criterion.

## Objective

On the Devboard mode Skills page, every skill created by the `/prepare-skills` command carries one
delete control that removes that skill in a single click, while the three built-in `devboard-*`
skills carry a visible `Managed` marker and can never be deleted. Hand-authored, symlinked, and
Discover-generated skills stay undeletable and byte-identical.

## Success criteria

- Each canonical built-in skill — `.devboard/omp/skills/devboard-ui-ux/SKILL.md`,
  `.devboard/omp/skills/devboard-restful-api-implementation/SKILL.md`, and
  `.devboard/omp/skills/devboard-single-responsibility-principle/SKILL.md` — carries
  `metadata.devboard-builtin: "true"` in its frontmatter and no `metadata.devboard-managed` key.
- Each installed copy at `.omp/skills/<name>/SKILL.md` for those three names is byte-identical to
  its canonical original and carries the same marker.
- `getInstalledSkills` answers every installed skill with `builtin: true` exactly for the three
  shipped `devboard-*` skills and `builtin: false` for every other skill, including a
  prepare-family skill, a hand-authored skill, and a Discover skill.
- The Skills table renders a visible `Managed` label on every built-in row and exactly one delete
  control, with accessible name `Delete <skill>`, on every prepare-family row. Built-in,
  Discover, hand-authored, and symlinked rows carry no delete control.
- One click on a prepare-family row's delete control removes that row and deletes the whole
  `.omp/skills/<name>/` directory with no confirmation dialog; a page reload keeps the row gone.
- The server refuses a delete command for a built-in, Discover, hand-authored, symlinked, or
  non-installed name, and for any name while Goal or Flow work is active; in every refusal the
  skill directory and `.omp/settings.json` are unchanged and the row remains.
- Deleting a prepare-family skill whose name sits in `.omp/settings.json` `skills.ignoredSkills`
  removes exactly that name from the array; every other key and array entry stays unchanged, and
  deleting an enabled skill adds or removes no settings entry.
- After a deletion, the Devboard Skills table and the Goal mode skills table both drop the row
  without a reload.
- No skill outside the three built-ins gains `metadata.devboard-builtin`; prepare-family,
  Discover, hand-authored, and symlinked skill bytes stay unchanged except for the deleted skill.
- `.devboard/README.md` documents the delete control, the `Managed` marker, and the
  `devboard-builtin` key, and no longer says the Skills table has exactly two columns or no delete
  control; `AGENTS.md` and its byte-identical `.devboard/templates/host-AGENTS.md` name the marker.
- `cd .devboard && bun test`, `bun run check`, `bun run build`, `bun run verify:interface`,
  `bun run verify:install`, and `bun run verify:update` each exit 0; the interface verification
  exercises the delete control, the `Managed` marker, and the refusal paths.
- The work is merged to `main` and pushed, and the Release Train publishes a version whose npm
  tarball and Gitea release contain a built-in `SKILL.md` carrying `devboard-builtin`.

## Verification

Run inside `.worktree/<name>`, then again on `main` after the merge and push.

- `cd .devboard && bun test` exits 0, including the installed-skills and skills-preparation cases.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run build` exits 0.
- `cd .devboard && bun run verify:interface` exits 0. It drives the Skills page in its fixture
  host, asserts the `Managed` marker and the single delete control per prepare-family row, clicks
  the control, and asserts the directory and row are gone and the ignored name is removed. It
  also asserts built-in, Discover, hand-authored, and symlinked rows carry no delete control.
- `cd .devboard && bun run verify:install` exits 0.
- `cd .devboard && bun run verify:update` exits 0.
- Marker and copy proof:
  ```
  for s in devboard-ui-ux devboard-restful-api-implementation devboard-single-responsibility-principle; do
    grep -q '^  devboard-builtin: "true"$' ".devboard/omp/skills/$s/SKILL.md" &&
    grep -q '^  devboard-builtin: "true"$' ".omp/skills/$s/SKILL.md" &&
    cmp -s ".devboard/omp/skills/$s/SKILL.md" ".omp/skills/$s/SKILL.md";
  done
  ```
  exits 0, and `grep -rn 'devboard-managed' .devboard/omp/skills .omp/skills` names no built-in.
- Fixture-host install proof:
  ```
  h=.devboard/.tmp/delete-skills-proof; rm -rf "$h"; mkdir -p "$h/.devboard"; git -C "$h" init -q
  .devboard/install.sh "$h"
  for s in devboard-ui-ux devboard-restful-api-implementation devboard-single-responsibility-principle; do
    grep -q '^  devboard-builtin: "true"$' "$h/.omp/skills/$s/SKILL.md" || exit 1
  done
  ```
  exits 0.
- Refusal and settings proof: `cd .devboard && bun test server/installed-skills.test.ts` exits 0
  and its cases cover the built-in, Discover, hand-authored, symlink, unknown, and active-work
  refusals, the `ignoredSkills` cleanup, and byte-preservation of every other settings key.
- Do not spawn a dashboard by hand; `verify:interface` owns its fixture server, and the live
  dashboard is opened through its normal launcher path.
- After the push: `git ls-remote origin refs/heads/main` names the integrated commit,
  `git status --short --branch` reports no commits ahead, `npm view @dsdenes/devboard version`
  names the Release Train's version, and
  `npm pack @dsdenes/devboard@<version> --pack-destination .devboard/.tmp` followed by
  `tar xOf .devboard/.tmp/dsdenes-devboard-<version>.tgz package/omp/skills/devboard-ui-ux/SKILL.md`
  shows `devboard-builtin`.

## Boundaries

- Do all work in `.worktree/<name>` inside the repo root; never edit the opened checkout. Every
  fixture host, pack destination, and temporary file lives under the worktree or `.devboard/.tmp/`.
- Allowed to edit: `.devboard/omp/skills/devboard-ui-ux/SKILL.md`,
  `.devboard/omp/skills/devboard-restful-api-implementation/SKILL.md`,
  `.devboard/omp/skills/devboard-single-responsibility-principle/SKILL.md`,
  `.devboard/server/app.ts`, `.devboard/server/installed-skills.test.ts`,
  `.devboard/client/lib/devboard.svelte.ts`,
  `.devboard/client/lib/components/DevboardSkills.svelte`,
  `.devboard/scripts/verify-interface.ts`, `.devboard/scripts/verify-install.ts`,
  `.devboard/scripts/verify-update.ts`, `.devboard/tests/launcher.test.ts`,
  `.devboard/README.md`, `AGENTS.md`, `.devboard/templates/host-AGENTS.md`.
- The installed `.omp/skills/devboard-*` copies are refreshed by `.devboard/install.sh`, never
  hand-edited; the canonical files are the source and the copies must stay byte-identical.
- Every new control follows the interface contract: the existing button primitive or
  `CommandButton` for a WebSocket command, its pressed and busy states, and no bespoke `<button>`.
- Untouched: `.devboard/prompts/**`, Discover generation and its six skills, prepare-skills
  generation and its rollback snapshot, hand-authored and symlinked skills, the installer's
  `devboard-*` prefix ownership and prune rules, `adrs/`, `GOAL.md`, `.devboard/dist/` and
  `node_modules/` (generated, never hand-edited), and every path under `$HOME`.
- No new dependency, no force-push, no rewriting published history, and no deletion of a skill
  the operator did not create through `/prepare-skills`.
- The three built-ins carry only `metadata.devboard-builtin: "true"`; they must not gain
  `metadata.devboard-managed`, because a marked skill without a family is classified as
  prepare-family and the existing Goal-mode delete would then remove it.

## Stop conditions

There is no attempt cap, no token budget, and no time limit: continue until every success criterion
is verified against current state. Halt and surface only for genuine ambiguity the repository
cannot resolve, a missing prerequisite (`bun`, `git`, npm, the Gitea release source, or forge write
access unavailable), a blocked external dependency (the upstream push rejected by a permission the
repository cannot grant, or npm/Gitea rejecting the artifact), or a risky irreversible operation
outside this goal (force-pushing, rewriting published history, deleting an unmarked skill, writing
under `$HOME`). A failed attempt is never reported as a satisfied criterion, and a narrower
feature, a scaffold, a mock, or a local-only commit never substitutes for a criterion.

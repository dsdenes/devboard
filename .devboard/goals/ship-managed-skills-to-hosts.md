## Objective

In this repository — the `dsdenes/devboard` harness at the repo root — the installer surface gains a
managed, project-scoped skill set that every host project receives. Three skills ship as canonical
harness files under `.devboard/omp/skills/`, named `devboard-ui-ux`,
`devboard-restful-api-implementation`, and `devboard-single-responsibility-principle`, and every
install, manual update, and automatic update writes them into `<host>/.omp/skills/<name>/` as real
copies that a plain `omp` session at the host root discovers at project scope. The `devboard-` name
prefix is the ownership marker: the package always wins those names, overwriting a differing copy and
deleting a marked directory a newer package no longer ships, while every unmarked skill in the host —
hand-authored, prepare-family, or Discover-family — stays byte-identical. The `ui-ux` skill moves out
of the operator's global skill directory into this project-scoped, reworked form; deleting the global
copy is a separate later goal and stays out of this one.

## Success criteria

- Three canonical directories exist with exactly these files:
  - `.devboard/omp/skills/devboard-ui-ux/` — `SKILL.md`, `references/design-system.md`,
    `references/templates.md`, `references/validation.md`, `references/wireframe.md`,
    `scripts/preflight.mjs`.
  - `.devboard/omp/skills/devboard-restful-api-implementation/` — `SKILL.md`,
    `references/zalando-rest-rules.md`.
  - `.devboard/omp/skills/devboard-single-responsibility-principle/` — `SKILL.md`.
- Each `SKILL.md` frontmatter `name` equals its directory name, matches
  `^devboard-[a-z0-9]+(-[a-z0-9]+)*$`, carries a non-empty `description` of at most 1024
  characters, and carries no `metadata.devboard-managed` key.
- `.devboard/install.sh` copies every file of the three directories into a fixture host at
  `<host>/.omp/skills/<name>/` with identical bytes, and a second run against unchanged bytes prints
  `0 file(s) installed` and changes no file.
- A launcher install writes the same three directories into a fresh host, and a manual update and the
  automatic replacement path (`server/updates.ts` through `syncHostCopies`) do the same for a host
  installed from an earlier version.
- Ownership holds in every install path: an edited `devboard-*` file is restored to package bytes, an
  extra file inside a shipped `devboard-*` directory is removed, a `devboard-*` directory the package
  does not ship is deleted, and a symlinked `devboard-*` entry is replaced by a real directory without
  writing its target.
- Unmarked skills survive byte for byte: a host-authored `house-style`, a prepare-family
  `behavior-first-testing`, and a Discover-family `discover-testing-strategy` directory keep their
  exact bytes and are never deleted by install, update, or prune.
- No code path deletes or rewrites a `.omp/skills` entry whose name does not start with `devboard-`.
- The host `.gitignore` gains exactly `/.omp/skills/devboard-ui-ux`,
  `/.omp/skills/devboard-restful-api-implementation`, and
  `/.omp/skills/devboard-single-responsibility-principle` on install; a rerun adds nothing.
- `doctor` and the update verification compare each shipped skill directory against the installed
  package and exit nonzero when one byte differs, while an unmarked host skill never fails the check.
- In the canonical checkout, `.omp/skills/devboard-ui-ux`,
  `.omp/skills/devboard-restful-api-implementation`, and
  `.omp/skills/devboard-single-responsibility-principle` exist as git-tracked copies byte-identical to
  their `.devboard/omp/skills/` originals; the old names `.omp/skills/ui-ux`,
  `.omp/skills/restful-api-implementation`, and `.omp/skills/single-responsibility-principle` exist
  neither on disk nor in the git index. The five prepare-family skills stay untouched.
- API Standards reads the shipped path:
  `apiStandardsConfig().skillDocument` is `.omp/skills/devboard-restful-api-implementation/SKILL.md`,
  the rule table resolves under the same directory, and `.devboard/prompts/api-standards.md`,
  `.devboard/README.md`, `.devboard/scripts/verify-api-standards.ts`, and
  `.devboard/tests/api-standards.test.ts` name only the prefixed paths.
- The shipped `devboard-ui-ux` content is reworked for project scope: no `global`, `user-level`, or
  `~/.omp` wording remains, every self-reference reads `skill://devboard-ui-ux/...` including the
  preflight invocation, the gate and its numbered steps plus the four references are unchanged in
  behavior, and `bun .devboard/omp/skills/devboard-ui-ux/scripts/preflight.mjs .` still prints JSON
  carrying `applicable`, `checks`, and `missing`.
- `server/feedback.ts` no longer calls ui-ux a global standard; it names the project skill
  `devboard-ui-ux`, and its test asserts the new text.
- `AGENTS.md` and its byte-identical copy `.devboard/templates/host-AGENTS.md` document
  `.devboard/omp/skills/` as canonical and the host `.omp/skills/devboard-*` copies as installed,
  package-owned files; `.devboard/README.md` documents the three skills, the ownership rules, and the
  new `.gitignore` entries.
- `cd .devboard && bun test`, `bun run check`, `bun run build`, `bun run verify:install`,
  `bun run verify:update`, `bun run verify:api-standards`, and `bun run verify:interface` each exit 0.
- Regression tests cover the ownership rules: `tests/install.test.ts` proves overwrite of a marked
  file, prune of an omitted marked directory, and byte-preservation of an unmarked skill;
  `tests/launcher.test.ts` proves the package carries the three skill trees.
- In a throwaway host that ran `.devboard/install.sh`, `omp skill list` run from that host root prints
  one line beginning `devboard-ui-ux`, one beginning `devboard-restful-api-implementation`, and one
  beginning `devboard-single-responsibility-principle`.
- The global directory `~/.omp/agent/skills/ui-ux` still exists with unchanged bytes, and no harness
  file writes to or deletes a path under `$HOME/.omp`.
- The work is merged to `main` and pushed: `git ls-remote origin refs/heads/main` names the
  integrated commit, and the Release Train publishes a version whose npm and Gitea artifacts contain
  `omp/skills/devboard-ui-ux/SKILL.md`.

## Verification

Run inside `.worktree/<name>`, then again on `main` after the merge and push.

- `for s in devboard-ui-ux devboard-restful-api-implementation devboard-single-responsibility-principle; do test -d ".devboard/omp/skills/$s"; done`
- `for s in devboard-ui-ux devboard-restful-api-implementation devboard-single-responsibility-principle; do printf '%s ' "$s"; sed -n 's/^name: //p' ".devboard/omp/skills/$s/SKILL.md"; done` prints each directory name twice per line.
- `! grep -rn 'devboard-managed' .devboard/omp/skills` produces no output.
- `h=.devboard/.tmp/skills-proof; rm -rf "$h"; mkdir -p "$h/.devboard"; git -C "$h" init -q; .devboard/install.sh "$h"` exits 0; then `diff -r .devboard/omp/skills "$h/.omp/skills"` prints nothing.
- `.devboard/install.sh "$h"` a second time prints `0 file(s) installed`.
- `printf 'tampered\n' >> "$h/.omp/skills/devboard-ui-ux/SKILL.md"; mkdir -p "$h/.omp/skills/devboard-retired" "$h/.omp/skills/house-style"; printf -- '---\nname: devboard-retired\ndescription: retired\n---\n' > "$h/.omp/skills/devboard-retired/SKILL.md"; printf -- '---\nname: house-style\ndescription: host owned\n---\n' > "$h/.omp/skills/house-style/SKILL.md"; cp "$h/.omp/skills/house-style/SKILL.md" .devboard/.tmp/house-style.expected; .devboard/install.sh "$h"` exits 0; then
  `cmp "$h/.omp/skills/devboard-ui-ux/SKILL.md" .devboard/omp/skills/devboard-ui-ux/SKILL.md`,
  `test ! -e "$h/.omp/skills/devboard-retired"`, and
  `cmp "$h/.omp/skills/house-style/SKILL.md" .devboard/.tmp/house-style.expected` all succeed.
- `cd "$h" && omp skill list | grep -c '^devboard-'` prints `3`.
- `grep -n 'devboard-' "$h/.gitignore"` lists the three `/.omp/skills/devboard-…` lines exactly once each; running `.devboard/install.sh "$h"` again leaves that count unchanged.
- `cd .devboard && bun run verify:install` exits 0 and its output names the three installed skill trees.
- `cd .devboard && bun run verify:update` exits 0 and its output proves the skills after the automatic replacement.
- `cd .devboard && bun run verify:api-standards` exits 0 and its filed-issue body names
  `.omp/skills/devboard-restful-api-implementation/SKILL.md` and
  `.omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md`.
- `cd .devboard && bun test`, `bun run check`, `bun run build`, and `bun run verify:interface` each exit 0.
- `for s in devboard-ui-ux devboard-restful-api-implementation devboard-single-responsibility-principle; do cmp -s ".devboard/omp/skills/$s/SKILL.md" ".omp/skills/$s/SKILL.md"; done` succeeds, and `git ls-files .omp/skills` lists only the prefixed names and the five prepare-family ones.
- `grep -rn 'skill://ui-ux' .devboard/omp/skills/devboard-ui-ux` produces no output; `grep -rniE 'global|user-level|\.omp/agent' .devboard/omp/skills/devboard-ui-ux` produces no output.
- `bun .devboard/omp/skills/devboard-ui-ux/scripts/preflight.mjs .` prints JSON that parses and contains `applicable`.
- `grep -n 'global OMP UI/UX' .devboard/server/feedback.ts` produces no output.
- `cmp .devboard/templates/host-AGENTS.md AGENTS.md` succeeds.
- `ls -l ~/.omp/agent/skills/ui-ux/SKILL.md` still reports the file, and `grep -rn 'HOME/.omp' .devboard/bin .devboard/lib .devboard/install.sh` shows no write path.
- After the push: `git ls-remote origin refs/heads/main` names the merge commit, `git status --short --branch` reports no commits ahead, and `npm view @dsdenes/devboard version` plus the Gitea release assets name the Release Train's version whose tarball contains `omp/skills/devboard-ui-ux/SKILL.md` (`npm pack --pack-destination .devboard/.tmp` then `tar tzf`).

## Boundaries

- Do all work in `.worktree/<name>` inside the repo root; never edit the opened checkout. Every
  temporary host, pack destination, and fixture lives under `.devboard/.tmp/` or the worktree.
- Allowed to create: `.devboard/omp/skills/devboard-ui-ux/**`,
  `.devboard/omp/skills/devboard-restful-api-implementation/**`,
  `.devboard/omp/skills/devboard-single-responsibility-principle/**`.
- Allowed to edit: `.devboard/lib/host-sync.mjs`, `.devboard/bin/devboard.mjs`,
  `.devboard/install.sh`, `.devboard/server/feedback.ts`, `.devboard/issues/api-standards/paths.ts`,
  `.devboard/prompts/api-standards.md`, `.devboard/client/**` only where the existing Skills page or
  feedback text names a skill, `.devboard/scripts/{verification,verify-install,verify-update,verify-api-standards,verify-interface,harness-package}.ts`,
  `.devboard/tests/**`, `.devboard/package.json` only if a packaged path is missing,
  `.devboard/README.md`, `AGENTS.md`, `.devboard/templates/host-AGENTS.md`.
- Allowed to move: `.omp/skills/restful-api-implementation/` and
  `.omp/skills/single-responsibility-principle/` under their `devboard-` names and into the canonical
  tree; add `.omp/skills/devboard-ui-ux/` from `~/.omp/agent/skills/ui-ux/` by copy.
- Untouched: every unmarked host skill, including the five prepare-family skills in `.omp/skills/`;
  `server/app.ts` managed-family logic, `managedSkillNames`, and Discover's six names;
  `.devboard/prompts/prepare-skills.md`; `adrs/`; `GOAL.md`; `.devboard/prompts/discover-*`;
  `.devboard/dist/` and `node_modules/` (generated, never hand-edited); `~/.omp/**` — no harness file
  writes, replaces, or deletes anything under the home directory, so the global `ui-ux` copy is left
  byte-identical and its removal is a later goal.
- The marked namespace is reserved: any host entry named `devboard-*` is package-owned, overwritten
  and pruned without `--force`, and a host that wants a skill of its own uses an unmarked name.
- `install.sh` keeps its refuse-unless-`--force` rule for `commands/`, `extensions/`, `config.yml`,
  and `mcp.json`; only `skills/` follows the ownership rule.

## Stop conditions

There is no attempt cap, no token budget, and no time limit: continue until every success criterion is
verified against current state. Halt and surface only for genuine ambiguity the repository cannot
resolve, a risky or irreversible operation outside this goal (deleting the global `ui-ux` copy,
force-pushing, rewriting published history), a missing prerequisite (`omp`, `bun`, `git`, npm, or the
Gitea release source unavailable, so the scope proof or release proof cannot run), or a blocked
external dependency (npm or Gitea rejects the artifact, or the upstream push is rejected by a
permission the repository cannot grant). A failed attempt is never reported as a satisfied criterion.

## Objective

In this repository — the `dsdenes/devboard` harness at the repo root — the package ships one more
project-scoped skill, `devboard-gh-stack`, whose `SKILL.md` is a passive reference for GitHub's
stacked-pull-request CLI (`gh stack`): the linear stack model and what each `gh stack` command
does. Every install, manual update, and automatic update writes it into
`<host>/.omp/skills/devboard-gh-stack/` as a real copy that a plain `omp` session at the host root
discovers at project scope, the Skills page renders it `Managed` with no delete control, and the
npm tarball carries it. The skill is reference material only: no harness prompt, command,
extension, agent, worker, or gate requires it, triggers it, or directs anyone to stack pull
requests.

## Success criteria

- `.devboard/omp/skills/devboard-gh-stack/SKILL.md` exists and its bytes are exactly the block at
  the end of this section: frontmatter `name: devboard-gh-stack`, `metadata.devboard-builtin:
  "true"`, a description of at most 1024 characters, and the pasted gh-stack reference body.
- `.omp/skills/devboard-gh-stack/SKILL.md` exists in this checkout as a git-tracked copy
  byte-identical to the canonical file.
- `.devboard/install.sh <host>` copies the directory into `<host>/.omp/skills/devboard-gh-stack/`
  with identical bytes; a second run against unchanged bytes prints `0 file(s) installed` and
  changes no file.
- A launcher install writes the same directory into a fresh host, and a manual update plus the
  automatic replacement path (`server/updates.ts` through `syncHostCopies`) writes it into a host
  installed from an earlier version.
- Ownership holds for the new name in every install path: an edited
  `devboard-gh-stack/SKILL.md` is restored to package bytes without `--force`, an extra file
  inside the directory is removed, and a symlinked `devboard-gh-stack` entry becomes a real
  directory without writing its target.
- The host `.gitignore` gains exactly one `/.omp/skills/devboard-gh-stack` line on install, a
  rerun adds nothing, and the canonical checkout's `.gitignore` is unchanged.
- `doctor` compares the directory against the installed package and exits nonzero when one byte
  differs; an unmarked host skill still never fails that check.
- The Skills page lists one row named `devboard-gh-stack` carrying the `Managed` marker and no
  delete control; a delete command for that name is refused and the directory stays.
- `omp skill list` at the root of a throwaway host that ran `.devboard/install.sh` prints a line
  beginning `devboard-gh-stack`, and `omp skill list | grep -c '^devboard-'` prints `5`.
- No harness surface requires or triggers the skill: `grep -rn 'gh-stack'` finds no line under
  `.devboard/prompts`, `.devboard/omp/commands`, or `.devboard/extensions`, and no agent, worker,
  gate, or checklist names it.
- The four existing shipped skills keep their exact bytes, canonical and installed:
  `devboard-ui-ux`, `devboard-restful-api-implementation`,
  `devboard-single-responsibility-principle`, and `devboard-consistent-naming`.
- Every hardcoded shipped-skill enumeration reads five names: the `MANAGED_SKILLS` arrays in
  `.devboard/scripts/verify-install.ts`, `.devboard/scripts/verify-update.ts`, and
  `.devboard/tests/install.test.ts`, the package-tree expectations in
  `.devboard/tests/launcher.test.ts`, `.devboard/README.md`, `AGENTS.md`, and
  `.devboard/templates/host-AGENTS.md`; no sentence still says four.
- `.devboard/README.md`'s Skills table carries a `devboard-gh-stack` row describing the reference,
  and the paragraph listing ignore entries names five `/.omp/skills/devboard-<name>` lines
  including `/.omp/skills/devboard-gh-stack`.
- `AGENTS.md` and `.devboard/templates/host-AGENTS.md` stay byte-identical to each other and both
  name `devboard-gh-stack` among the shipped skills.
- `cd .devboard && bun test`, `bun run check`, `bun run build`, `bun run verify:install`,
  `bun run verify:update`, and `bun run verify:interface` each exit 0.
- The work is merged to `main` and pushed, and the Release Train publishes a version whose npm
  tarball and Gitea release contain `omp/skills/devboard-gh-stack/SKILL.md`.

````
---
name: devboard-gh-stack
description: Manage GitHub stacked pull requests with gh-stack. Use when creating, reviewing, updating, rebasing, synchronizing, or merging dependent PRs.
metadata:
  devboard-builtin: "true"
---

# GitHub Stacked Pull Requests

## Purpose

Manage a linear sequence of dependent branches and pull requests using GitHub's `gh stack` CLI extension.

Each branch represents one independently reviewable logical change. A branch's pull request targets the branch immediately below it.

## Prerequisites

- Git 2.36+
- Authenticated GitHub CLI
- `github/gh-stack` CLI extension
- Repository with stacked PR support

```bash
gh extension install github/gh-stack
git config rerere.enabled true
```

For repositories with multiple remotes, configure `remote.pushDefault` or specify `--remote` on supported commands.

## Architecture

A stack is a linear dependency chain:

```text
main <- schema <- api <- frontend
```

- `schema` targets `main`.
- `api` targets `schema`.
- `frontend` targets `api`.
- Lower layers contain foundational changes.
- Higher layers contain dependent changes.
- Independent changes belong in separate stacks.

## Stack creation

Create the stack before implementing dependent changes.

```bash
gh stack init schema
# Implement and commit schema changes

gh stack add api
# Implement and commit API changes

gh stack add frontend
# Implement and commit frontend changes
```

Each layer should have a coherent, independently reviewable responsibility.

## Publishing

```bash
gh stack submit --auto
```

This publishes the stack and creates draft pull requests.

To create PRs ready for review:

```bash
gh stack submit --auto --open
```

Inspect the resulting state:

```bash
gh stack view --json
```

## Editing existing layers

Changes belong on the layer that owns the responsibility.

```bash
gh stack checkout api
# Edit and commit changes

gh stack rebase --upstack
gh stack top
gh stack push
```

Changes to lower layers must propagate to dependent layers.

## Synchronization

```bash
gh stack sync
```

Synchronize local branches, remote changes, rebases, and PR state.

To additionally prune merged local branches:

```bash
gh stack sync --prune
```

## Merging

Merge through the stack-aware CLI rather than independently merging dependent pull requests.

```bash
gh stack merge 42 --yes
```

A PR target merges that PR and eligible unmerged layers below it.

A stack identifier targets the entire stack.

Branch protection rules, required reviews, and CI requirements remain applicable.

## Agent execution constraints

- Prefer non-interactive commands.
- Use `gh stack view --json` instead of interactive `view`.
- Use `gh stack submit --auto` instead of bare `submit`.
- Always provide a branch name to `init` and `add`.
- Always provide a target to `checkout`.
- Use explicit targets and `--yes` for merges.
- Never invoke the interactive `gh stack modify` command in an unattended agent.
- Do not assume commands succeed; inspect exit codes.
- Do not run concurrent mutations against the same stack.
- Do not automatically resolve semantic merge conflicts.

## Failure recovery

After a rebase conflict:

```bash
# Resolve conflicts and stage files
git add <resolved-files>
gh stack rebase --continue
```

To cancel:

```bash
gh stack rebase --abort
```

If synchronization detects divergent stacks, inspect the local and remote histories before attempting reconciliation.

## Verification

Before reporting completion, verify:

- All intended branches are included.
- Parent-child relationships are correct.
- Each PR contains only its intended incremental diff.
- Required checks and reviews are satisfied.
- No rebase or merge operation remains unresolved.
- The published stack matches local state.

Use `gh stack view --json` as the primary machine-readable state source.

## References

Official documentation:
https://github.com/github/gh-stack

Official agent skill:
https://github.com/github/gh-stack/tree/main/skills/gh-stack

CLI command documentation:
`gh stack <command> --help`

````
## Verification

Run inside `.worktree/<name>`, then again on `main` after the merge and push, from the worktree
root unless a step changes directory.

- Byte equality with the block above:
  ```
  awk '/^````$/{f=!f; next} f' .devboard/goals/ship-gh-stack-skill.md > .devboard/.tmp/gh-stack.expected
  cmp .devboard/.tmp/gh-stack.expected .devboard/omp/skills/devboard-gh-stack/SKILL.md
  cmp .devboard/omp/skills/devboard-gh-stack/SKILL.md .omp/skills/devboard-gh-stack/SKILL.md
  git ls-files .omp/skills | grep 'devboard-gh-stack/SKILL.md'
  ```
  all succeed and the last prints `.omp/skills/devboard-gh-stack/SKILL.md`.
- Fixture-host install:
  ```
  h=.devboard/.tmp/gh-stack-proof; rm -rf "$h"; mkdir -p "$h/.devboard"; git -C "$h" init -q
  .devboard/install.sh "$h"
  diff -r .devboard/omp/skills "$h/.omp/skills"
  .devboard/install.sh "$h" | grep '0 file(s) installed'
  grep -c '^/.omp/skills/devboard-' "$h/.gitignore"
  (cd "$h" && omp skill list | grep -c '^devboard-')
  ```
  `diff` prints nothing and both counts print `5`.
- Ownership proof against that fixture host:
  ```
  printf 'tampered\n' >> "$h/.omp/skills/devboard-gh-stack/SKILL.md"
  printf 'extra\n' > "$h/.omp/skills/devboard-gh-stack/extra.md"
  .devboard/install.sh "$h"
  cmp "$h/.omp/skills/devboard-gh-stack/SKILL.md" .devboard/omp/skills/devboard-gh-stack/SKILL.md
  test ! -e "$h/.omp/skills/devboard-gh-stack/extra.md"
  mv "$h/.omp/skills/devboard-gh-stack" "$h/linked-target"
  ln -s "$h/linked-target" "$h/.omp/skills/devboard-gh-stack"
  .devboard/install.sh "$h"
  test ! -L "$h/.omp/skills/devboard-gh-stack"
  cmp "$h/.omp/skills/devboard-gh-stack/SKILL.md" .devboard/omp/skills/devboard-gh-stack/SKILL.md
  ```
  every command exits 0.
- `grep -rn 'gh-stack' .devboard/prompts .devboard/omp/commands .devboard/extensions` prints
  nothing.
- `cd .devboard && bun test` exits 0, including the install, launcher, and skills cases.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run build` exits 0.
- `cd .devboard && bun run verify:install` exits 0 and its output names
  `devboard-gh-stack` among the installed project skills.
- `cd .devboard && bun run verify:update` exits 0 and proves the skill after the automatic
  replacement.
- `cd .devboard && bun run verify:interface` exits 0; its fixture host asserts the
  `devboard-gh-stack` row, the `Managed` marker, and the refusal of a delete command for it.
- `cmp .devboard/templates/host-AGENTS.md AGENTS.md` succeeds.
- `grep -rn 'four project-scoped\|four entries' .devboard/README.md AGENTS.md` prints nothing, and
  `grep -n 'devboard-gh-stack' .devboard/README.md` lists both the Skills table row and the
  `/.omp/skills/devboard-gh-stack` ignore entry.
- `grep -c 'devboard-builtin' .devboard/omp/skills/devboard-gh-stack/SKILL.md` prints `1`, and
  `grep -rn 'devboard-managed' .devboard/omp/skills` names no shipped skill.
- After the push: `git ls-remote origin refs/heads/main` names the integrated commit,
  `git status --short --branch` reports no commits ahead, `npm view @dsdenes/devboard version`
  prints the Release Train's version, and
  `npm pack --pack-destination .devboard/.tmp` followed by
  `tar tzf .devboard/.tmp/dsdenes-devboard-<version>.tgz | grep 'omp/skills/devboard-gh-stack'`
  lists the skill file; the Gitea release for that version carries `devboard-<version>.tgz` and
  its `.sha256`.

## Boundaries

- Mode: harness. Work only in `.worktree/<name>` inside the repo root; never edit the opened
  checkout. Every fixture host, pack destination, and temporary file lives under
  `.devboard/.tmp/` or the worktree.
- Allowed to create: `.devboard/omp/skills/devboard-gh-stack/SKILL.md` and its installed copy
  `.omp/skills/devboard-gh-stack/SKILL.md`. No other new file.
- Allowed to edit: `.devboard/scripts/verify-install.ts`, `.devboard/scripts/verify-update.ts`,
  `.devboard/tests/install.test.ts`, `.devboard/tests/launcher.test.ts`, `.devboard/README.md`,
  `AGENTS.md`, `.devboard/templates/host-AGENTS.md`, and any other file whose hardcoded
  shipped-skill enumeration must gain the fifth name.
- Must stay untouched: the bytes of the four existing shipped skills, canonical and installed;
  `.devboard/install.sh`'s copy, prune, and `.gitignore` logic, which already globs
  `omp/skills/devboard-*`; every unmarked host skill under `.omp/skills/`; the canonical
  checkout's `.gitignore`; `$HOME/.omp`; and `.devboard/prompts/`, `.devboard/omp/commands/`,
  `.devboard/extensions/`, and every agent, worker, and gate.
- The skill body is the block above, unedited: keep the description's trigger sentence and the
  "Agent execution constraints" wording exactly as written; do not soften, extend, reformat, or
  append guidance, and add no obligation that anything stack pull requests.
- No dependency is added, and no check may require `gh`, the `gh stack` extension, network access
  to GitHub, or an authenticated GitHub account.
- Forbidden: force-pushing, rewriting published history, hand-editing an installed `devboard-*`
  copy in this checkout's `.omp/`, running `bun run publish` or dispatching the release workflow by
  hand, spawning or killing a dashboard by hand, and writing anything outside the repo root.
- Out of scope: any stacked-PR workflow itself, wiring the skill into an agent, prompt, gate, or
  checklist, and documenting stacking beyond the shipped `SKILL.md` and one README table row.

## Stop conditions

Halt and report a blocker when a step cannot proceed without a decision this goal does not make,
such as genuine ambiguity between two success criteria; a missing prerequisite such as an
unavailable `bun`, `git`, `omp`, or forge write access for `dsdenes/devboard`; a forge, npm, or
Gitea dependency that cannot be reached; or an irreversible operation this goal does not
authorize, such as rewriting published history or force-pushing `main`. Report the failing step,
the exact command, and what was observed, and leave every file as it stands.

There is no attempt cap, no token budget, and no time limit: retries, extra runs, and further
investigation are unrestricted. A narrower skill, a shortened or reworded body, a scaffold, a
mock, a local-only commit, or a subset of the shipped-skill enumerations never substitutes for a
success criterion. The goal is met only when every criterion holds on pushed `main` and the
Release Train's release carries the skill.

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


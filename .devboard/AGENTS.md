# Harness instructions

## Agent flows are prompts plus MCP tools

Every agent flow this harness runs follows four rules, and a change that breaks one is a defect:

1. **The prompt describes the complete flow.** An agent prompt states the whole flow the agent
   executes: its input, its survey or read steps, its decision rules, and every action it takes.
   Nothing load-bearing lives only in worker code the agent cannot see.
2. **Agents act through the Devboard MCP tools.** An agent files an issue, registers a Flow widget,
   records a steering acknowledgement, checkpoint, or verification, stages a Discover document, or
   requests a Design System release by calling the matching MCP tool. The tool performs the write
   and returns the created or recorded identity.
3. **No rigid answer document.** No flow may require a JSON document, JSON-lines file, or staged
   document that deterministic code then parses, validates, corrects, or converts into an external
   action. MCP tools validate their own arguments and confinement; publication and rendering may
   still parse what is on disk and report a malformed state as an error, but no path asks the same
   agent to rewrite a rejected answer.
4. **Manifesto first, no self-reference.** Every prompt file and every prompt assembled in code
   begins its body with a `## Manifesto` section whose first sentence names the agent's goal and
   the observable result it produces. No prompt body opens with a backticked or bare slash-command
   invocation of itself.

## The source tree is not the installed harness

This checkout builds and releases the harness; hosts run an installed copy.

- `<host>/.devboard` is a real npm prefix holding
  `node_modules/@dsdenes/devboard` plus the host copies of `prompts/`, `extensions/`, and `lib/`
  that the copied wrappers open by repo-root-relative path. It is never a symlink to this
  checkout and never a full copy of these sources.
- The public `@dsdenes/devboard` package at this directory carries the CLI and the whole harness.
  `bin/devboard.mjs` installs, updates, and checks hosts; npm is the version and artifact
  authority. The canonical Gitea release is a fallback record, not a second package.
- Fix the harness here, then release it. An installed host picks the release up on its own; do
  not edit an installed package in a host by hand.

## Install, update, and reload

```bash
npx @dsdenes/devboard install   # real prefix, real wrapper dirs, one dashboard
npx @dsdenes/devboard update    # newest release, no restart
npx @dsdenes/devboard doctor    # one PASS or FAIL line per check
```

A running dashboard checks npm for a newer version immediately and every 60 seconds and installs
it into its own prefix without stopping. When npm cannot serve it and `DEVBOARD_GITEA_URL` is
configured, the Gitea tarball and its `.sha256` are the fallback. It keeps serving the
code it loaded until someone clicks the reload control
(`data-testid="reload-devboard"`), which restarts the server from the installed package and
reloads the page. Never restart a dashboard by hand and never symlink a host.

## Restart the source interface after every change

The canonical source dashboard serves this checkout. After a change under `.devboard/`, rebuild
and restart it so the page reflects the new code:

1. `bun run build` from this directory.
2. Stop the running source server and start it again with the same host paths it was given.
3. Confirm it answers on its port before continuing.

For an installed host, the reload control is the only restart path.

## Commit messages

Every commit on the canonical line is a Conventional Commit:

```
<type>[(<scope>)][!]: <description>
```

`<type>` is one of `feat fix docs style refactor perf test build ci chore revert`, in lowercase.
`<scope>` is optional and matches `[a-z0-9._-]+`; `!` marks a breaking change; `<description>` is
non-empty with no leading or trailing whitespace. Body and footers are unrestricted. A merge
commit — two or more parents, or Git's generated `Merge …` subject — is exempt.

The release version comes from those messages. The first release of this line is `1.0.0` while
the highest published release is below it. Later releases advance the newest release tag reachable
from `HEAD` by the highest level in the non-merge commits after it: a `!` before the colon or a
`BREAKING CHANGE:`/`BREAKING-CHANGE:` footer raises the major, otherwise a `feat` raises the
minor, otherwise the patch. A range with no non-merge commit releases nothing. `bun run release`
checks the same grammar over the range it is about to release, so a malformed commit cannot
publish even when it reached `main` through `--no-verify`.

Install the gate once per checkout; it lives in the repository's shared hooks directory and covers
every existing and future worktree:

```bash
bun .devboard/hooks/install.ts           # idempotent
bun .devboard/hooks/install.ts --force   # replace a differing hook
```

A rejected push names each offending `<sha> <subject>` and the rule it broke, and adds no ref.
Reword those commits with `git commit --amend` or an interactive rebase, then retry the push.
Never use `--no-verify` and never edit or remove the installed hook.

## Verify and release

Before a commit that changes the harness:

```bash
bun run build
bun test
bunx tsc --noEmit
bun run verify:install
bun run verify:update
bun run verify:ui
```

Merge into `main` and push. The release workflow tests, packs the complete public package,
publishes `@dsdenes/devboard@<version>` to npmjs, and creates the Gitea release with the fallback
tarball and `.sha256`. Then run `bun run publish` from the integration checkout: it waits for
that workflow, verifies the npm package and release assets, and reports each dashboard without
restarting it.

# Harness instructions

## Instruction files

Long-term agent instructions live in exactly two places: `AGENTS.md`, read every run, and a
project-scoped skill at `.omp/skills/<name>/SKILL.md`, read on demand when its description matches
the work. Do not create a `README.md`, a `docs/` tree, or any other instruction file.
`.devboard/README.md is retired`; its reference content now lives in the
`devboard-harness-reference` skill, which is loaded on demand and is not an instruction file.

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

- The harness is one Rust binary built by cargo-dist. GitHub Releases is the public install,
  update, and doctor surface: a host with no Gitea reads its release manifest, archives, and
  installer. Gitea is the local forge and the publishing authority; the Release Train builds the
  artifacts from the canonical tagged Gitea commit, and Gitea is never a consumer dependency.
- `<host>/.devboard` holds the host's harness directory and state; `devboard install` writes the
  managed `.omp/commands`, `.omp/extensions`, `.omp/skills/devboard-*`, `AGENTS.md`, and
  `.gitignore` lines as real files. It is never a symlink to this checkout.
- Fix the harness here, then release it through the Release Train. An installed host reads the
  public GitHub release manifest and replaces itself without an operator click; do not edit an
  installed copy by hand.
- This checkout runs omp against its tracked `.omp/` mirror, and no install or update path
  refreshes it. Change `.devboard/omp/`, run `install.sh`, and commit both trees together;
  `cargo test --workspace` plus `devboard doctor` fail when the mirror is missing a file,
  differs, or still carries a wrapper the canonical tree dropped.

## Install, update, and reload

```bash
devboard install <host>   # real wrapper dirs, skills, AGENTS.md, gitignore lines
devboard doctor <host>    # exit 0 when every managed file matches the release
```

A running dashboard reads the public GitHub release manifest immediately and every 60 seconds
(and the Gitea manifest when `DEVBOARD_GITEA_URL` is configured), verifies
the artifact digest, installs it beside its own binary, and replaces itself without an operator
click: every connected page waits for the replacement and reloads once. An unreachable, invalid,
or mismatched manifest leaves the running process serving and is journaled once per attempt. The
reload control (`data-testid="reload-devboard"`) appears only when a replacement could not start
and retries the same launcher. The MATE top-panel Devboard icon
(`desktop/devboard-launcher.py`) is the sanctioned operator path: it sweeps this host's stray
dashboards, keeps the newest ready one, and starts or restarts exactly one. Never restart a
dashboard by hand outside that icon, and never symlink a host. The reaper signals only processes
of the host directory it runs for: a dashboard, worker, or run belonging to another host
directory is never signalled.

## Restart the source interface after every change

A canonical source dashboard never installs or replaces itself on an update check. After a
successful publish, `devboard publish` writes a source-refresh request into each live dashboard's
own `STATE_DIR`; the dashboard verifies the embedded client digest and replaces itself through the
ordinary handoff. Editing a source file, rebuilding `dist`, a page reload, and an update check
never restart it. Never stop or relaunch a source dashboard by hand outside the panel icon's
sweep, which keeps the newest ready dashboard and ends only this host directory's strays.

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
minor, otherwise the patch. A range with no non-merge commit releases nothing. `devboard publish`
checks the same grammar over the range it is about to release, so a malformed commit cannot
publish even when it reached `main` through `--no-verify`.

Install the gate once per checkout; it lives in the repository's shared hooks directory and covers
every existing and future worktree:

```bash
cargo run -p devboard -- hooks install          # idempotent
cargo run -p devboard -- hooks install --force  # replace a differing hook
```

A rejected push names each offending `<sha> <subject>` and the rule it broke, and adds no ref.
Reword those commits with `git commit --amend` or an interactive rebase, then retry the push.
Never use `--no-verify` and never edit or remove the installed hook.

## Verify without mutating a live dashboard

Automated verification runs against a throwaway `--state-dir` under `.devboard/.test-tmp` and an
ephemeral port (`--port 0`). It never calls `setResources`, Start, Stop, or any mutating command
against a live operator dashboard, never targets `.devboard/.tmp` or port 8080 as a write target
for resource settings, and never mutates a live operator dashboard's state. Read and hash live
state only when the proof requires it.

## Verify and release

Before a commit that changes the harness:

```bash
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run check
bun test
bun run build   # builds the client and refreshes crates/devboard/assets when it changed
```

A client change is verified with `cd .devboard && bun test`. `.gitea/workflows/devboard-ci.yml`
runs the Rust checks and the embedded-client build, not the client suite, so a client change must
pass `bun test` locally before it lands.

A client change lands together with the refreshed, committed `crates/devboard/assets`: `bun run
build` embeds the bundle it just built, the binary serves that copy, the release workflow builds
the tagged commit without re-embedding it, and both the CI check and `devboard publish` refuse a
tree whose committed copy differs from the rebuilt bundle.

Merge into `main` and push. A push releases nothing: `.github/workflows/devboard-build.yml` runs
only when `devboard publish` dispatches it at the temporary build ref, and `devboard publish`
pushes the release tag only after the target commit's `devboard-ci.yml` run concludes success. The Release Train background agent watches
canonical `main` on its 10-minute default cadence, batches every non-merge commit since the newest
release tag into one release, starts one agent only when that range is non-empty, and retries a
failed release on a later tick. That agent tags the commit, dispatches `devboard-build.yml` from the
canonical commit, verifies the GitHub assets against the Gitea manifest, moves the GitHub release
tag to an empty-tree commit, and records the version. No
implementation agent, design agent, or manual step publishes a version; the train is the only
releaser.

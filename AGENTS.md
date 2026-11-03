# AGENTS.md

Two layers. Identify yours before reading or editing.

```
<repo root>/
  .devboard/   <- harness: interface, prompts, wrappers, install.sh
  adrs/        <- host data
  GOAL.md      <- host data
  .omp/        <- installed harness wrappers
  ...          <- host project
```

| Path | Identity |
| --- | --- |
| `.devboard/` | Agentic development harness. Project-agnostic. Owns the browser interface and its toolchain. Works *on* the host. Never the host product. |
| `.devboard/omp/` | Canonical agent commands, extensions, and skills; installed into the host's `.omp/`. |
| `adrs/`, `GOAL.md` | Host data at the root; never harness artifacts. |
| everything else | Host project. |

## Containment boundary

The whole project — host, harness, toolchain, tests, fixtures, caches, logs, temporary
files, and worktrees — lives inside `<repo root>`. Nothing may be created, written, or kept
outside it: not under `/tmp`, not in a home directory, not in a parent, sibling, or other
checkout. This applies to every agent, script, and service, including throwaway
verification, "safe" sandbox copies, and manual test data.

- Point every path variable (`ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`) at a
  location inside `<repo root>`.
- When a tool defaults outside the root, override it to a directory inside the root; never
  accept the default.
- Asked to place a file, artifact, cache, log, or worktree outside the root? Refuse and
  propose the in-repo path.
- Running system binaries (`bun`, `git`, `gh`, `omp`) is not a violation; writing their
  output outside the root is.

A temporary directory is still project data. Create it under `<repo root>` (for example
under `.worktree/`), never outside.

## Scope

Default to the host project. "the repo", "the project", "the code", and unnamed files all mean the host project.

Enter harness mode only when the request names the harness, "devboard", or a path inside `.devboard/`.

| Mode | Trigger | Edit |
| --- | --- | --- |
| host (default) | everything else | host project; leave `.devboard/` untouched |
| harness | explicit harness / `.devboard` reference | `.devboard/` only; host files untouched unless named |

A request naming both layers is two scopes; change each side by its own rules.
Never edit `.devboard/` for a host request. Never edit host files for a harness request. If a task couples them, surface it and state the scope change.

## Harness rules

1. **Containment.** Keep every harness file inside `.devboard/`: code, scripts, prompts, tests, fixtures, docs, configs, CI glue, artifacts. Nothing harness-related is created outside `<repo root>` — no temporary files, caches, logs, or test data. Asked to place one outside? Refuse; propose the `.devboard/` path. Host files *invoking* the harness at runtime are fine.
2. **Portability.** Harness code moves between unrelated hosts. Bake in nothing host-specific: no absolute paths, project names, identifiers, remotes, secrets, language/layout/build/test-runner assumptions. Discover host facts at runtime, take them as arguments, or read them from config under `.devboard/`. Emit host paths relative to the repo root.
3. **Fixed location, fixed name.** Install at `<repo root>/.devboard`, spelled exactly that. Never rename or relocate per host.
4. **Host-neutral deletion.** Deleting `.devboard/` must leave host build, tests, and run paths working. No host hard-dependency on the harness beyond `.devboard/` itself.
5. **The one exception.** `AGENTS.md` sits at the repo root by design: agents must find it there. Host-agnostic, copied verbatim between hosts, not a harness artifact. Nothing else gets this treatment.

## Interface

`.devboard/` owns the browser interface and everything needed to build, test, and run it: the Bun
server, the Svelte client, the tests and fixtures, `package.json`, `bun.lock`, the build
configuration, `index.html`, the `Dockerfile`, and `README.md`. Run its commands from `.devboard`:
`bun install`, `bun test`, `bun run build`, `bun run start`; build the container from the
`.devboard` context. The interface is a harness tool, not the host product.

The harness may define its own toolchain, but it must not assume host facts: no host language,
package manager, test runner, build system, or layout. Host data lives at the root — the decision
records in `adrs/` and the goal document `GOAL.md` — and reaches the interface only through paths
the host supplies: `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, `AGENT_COMMAND`. The
lifecycle prompts under `.devboard/prompts/` likewise treat the repository root as the host and
exclude `.devboard/` and `.worktree/` from every survey and every write.

## Releases and installation

The harness is the public npm package `@dsdenes/devboard`. One tarball carries the launcher, the
server, the client sources and built bundle, the prompts, the omp wrappers and extensions, the
templates, and the installer. npm is the authority for install and update versions and artifacts;
no local checkout, running dashboard, or required release tarball is involved. GitHub is only a
push mirror of this repository; it carries no release the dashboard reads.

A host installs a real npm prefix at `<host>/.devboard` with
`npx @dsdenes/devboard install`. The launcher never discovers, reads, copies, or waits on another
local Devboard installation or source checkout. `<host>/.omp/commands`, `<host>/.omp/extensions`,
`<host>/.omp/skills/devboard-*`, and `<host>/AGENTS.md` are real copies from the installed package;
no harness path is a symlink.
The canonical `.devboard/` in this checkout is the source tree and is never an npm install.

Every installed dashboard checks the newest npm version at startup and every 60 seconds and
installs a newer artifact. When the install completes, the server replaces itself with the
installed version without an operator click: every connected page receives the replacement event,
waits for the new process, and reloads once. The replacement never kills a live agentic run or a
background worker. Every run owns a detached process that survives the dashboard, so its state and
activity replay after reconnect, an answer reaches the same run, Stop ends it, and work in flight
finishes on the version that started it. Each background worker family (Issues, Auto Scout, Design
System, MCP optimizer, Watchdog, Release Train) accepts a live worker of more than one harness
version: the running version starts its own worker when an older one is live, sends the older
worker a drain, and every unit that arises afterwards is claimed by the newest worker. The older
worker starts no new unit,
finishes its in-flight unit, exits when its last unit ends, releases its lock, and leaves its
state and activity readable. Start launches the newest installed version when no worker is live;
Pause, Resume, Check now, Stop, and settings apply to every live worker of the family. A worker
started by a version that predates this mechanism has no drain command and is never killed
mid-unit; it is left to finish its unit.

`versionState` reports `running`, `installed`, `latest`, `stale`, and `source`. `running` is the
version the process actually loaded; `installed` is what a restart would load now — the package
under the prefix on an installed host, the checkout's source version on a source checkout. The
status bar labels that second value `installed` on an installed host and `source` on a source
checkout. The reload control is rendered only when a replacement could not start: the running
version keeps serving, its accessible name and title name both versions, and clicking it retries
the same launcher. A canonical source checkout, which has no package under
`.devboard/node_modules/@dsdenes/devboard`, never installs and never replaces itself on an update
check. It replaces itself only after one successful `bun run publish`: that path writes a
source-refresh request into each live dashboard's own `STATE_DIR` only after its fast-forward,
dependency install, client build, release-workflow wait, npm-package check, and Gitea-asset check
have all passed. The request names the published commit, the released version, and a SHA-256 of
the built `.devboard/dist`; the dashboard verifies that digest without a second build, replaces
itself through the ordinary replacement handoff, and records the applied commit so the same
publish never restarts it twice. A missing, invalid, or mismatched request, a failed spawn, or a
replacement that never becomes ready leaves the old process serving and is journaled once per
attempt; a valid pending request is retried on a fixed interval, 60,000 ms by default and
configurable with `DEVBOARD_SOURCE_REFRESH_INTERVAL_MS` (minimum 1,000 ms). A new commit, a new
tag, a rebuilt `dist`, an edited source file, a page reload, and an npm update check never restart
a source dashboard. Installed hosts never receive or act on a source-refresh request. When npm
cannot resolve or serve the artifact and `DEVBOARD_GITEA_URL` is configured, install and update
fall back to the Gitea release tarball and its `.sha256` for the same version. A failed download,
checksum, authentication, or install leaves the installed package and the running server intact;
the journal records the failure and doctor reports it.

Harness-owned issue reporting uses only the configured Gitea API. Without `DEVBOARD_GITEA_URL`
the report controls are not rendered and `POST /feedback` answers HTTP 503 naming that
variable; no GitHub request is made. Host-forge behavior for GitHub, GitLab, and Gitea origins is
unchanged.

## The Release Train releases

The Release Train is the only component that publishes a Devboard version. It is the
`release-train` background agent family in the dashboard. On each tick its worker runs one
deterministic gate and starts one `omp acp` release agent only when the gate finds unreleased
commits. Nothing is published under `@dsdenes/devboard-harness`.

- **Cadence.** The default is 10 minutes, and the field accepts 1 through 1440 minutes.
- **Gate.** The worker fetches `origin/main` and its tags and compares that tip with the newest
  `v<version>` tag reachable from it. Unreleased means at least one non-merge commit after that
  tag; with no release tag, every non-merge commit is unreleased. Only merge commits release
  nothing. An unreadable remote, tag, or commit read records a failure and starts no agent.
- **Singleton.** At most one release agent run exists per repository. A second worker of the same
  harness version refuses to start while one is live; a cadence tick or Check now during an active
  run starts nothing. After a run ends, the next due tick may start one.
- **Batching.** One run publishes exactly one version for every non-merge commit since the newest
  release tag, using the existing Conventional Commit derivation: one npm version, one Gitea
  release carrying `devboard-<version>.tgz` and `devboard-<version>.tgz.sha256`, and one tag
  naming the released commit.
- **Retry.** A failing workflow conclusion, a missing npm version, missing release assets, or a
  rejected derived version records the failure with its detail, ships nothing, and leaves the
  range unreleased. The next due tick starts a new run without operator action. A failed run is
  never recorded as released.
- **Agent.** `.devboard/prompts/release-train.md` instructs one run to fetch canonical `main`,
  release it through `bun run publish` from the integration checkout, verify the npm package and
  the Gitea assets, and report the version and release URL. `bun run publish` dispatches
  `.gitea/workflows/devboard-release.yml` for the checked-out `main` tip when that tip has no
  usable run, then performs the existing verification; it never requires a push.
- **No other releaser.** `.gitea/workflows/devboard-release.yml` runs only on
  `workflow_dispatch`. The implementing agent closes its issue after the push proof and never
  publishes. The Design System pushes its documentation commit and reports without waiting for a
  release. No prompt, worker, or workflow other than the Release Train starts a release.

A change is finished when it is merged to `main`, pushed, and released by the Release Train. The
integration checkout is advanced and rebuilt after a push; it is never a place for feature work.
If its uncommitted changes block the fast-forward, preserve them (copy or patch them aside, apply
the published revision, reapply the changes) and rerun the train's publish path. Never discard
them and never bypass the fast-forward. Never run `bun run publish` by hand and never dispatch the
release workflow by hand: the Release Train owns both.

Guardrails:

- Never rebuild only a worktree or only the client and call the change done.
- Never kill, spawn, or relaunch a dashboard server by hand; install, update, the reload control,
  and the publish-driven source refresh are the only paths.
- Never copy the harness into a host or symlink a host path to this checkout; install owns the
  host prefix.
- Stale output is the first suspect, not the last: when the UI behaves like an older revision,
  compare `versionState` and the installed package version before debugging client code.
- A UI check against a bundle or server older than the changed source is not a passing
  verification.

## Wrappers

`.devboard/omp/` is canonical: agent commands live in `omp/commands/`, extensions in
`omp/extensions/`, and host skills in `omp/skills/`, never in the root `.omp/`.
`.devboard/install.sh` copies every file under `.devboard/omp/` to the same relative path under
`<host>/.omp/`. The host path is an argument or is discovered with
`git rev-parse --show-toplevel`; the script refuses a host without a `.devboard/` directory,
refuses to overwrite a differing file outside `skills/devboard-*` without `--force`, never touches
unrelated files, and is safe to rerun. Edit `.devboard/omp/`, rerun `install.sh`, and never
hand-edit the installed `.omp/`.

## Skills

The package ships four project-scoped skills, canonical under `.devboard/omp/skills/`:
`devboard-ui-ux`, `devboard-restful-api-implementation`,
`devboard-single-responsibility-principle`, and `devboard-consistent-naming`. Every install,
manual update, and automatic update copies them as real files into `<host>/.omp/skills/<name>/`,
where a plain `omp` session at the host root discovers them at project scope.

Each shipped `SKILL.md` carries `metadata.devboard-builtin: "true"` in its frontmatter. The
Devboard Skills page renders that row as `Managed` and offers no delete control for it; only a
prepare-family skill directory can be deleted.

The `devboard-` prefix is the ownership marker, and the marked namespace is reserved for the
package:

- The package always wins a marked name: a differing file is restored to package bytes without
  `--force`, an extra file inside a shipped marked directory is removed, and a marked directory
  the package no longer ships is deleted.
- A marked entry that is a symlink or a file is replaced with a real directory; nothing writes
  through it to its target.
- An unmarked skill — a host's own, a prepare-family skill, or a Discover-family skill — belongs
  to the host and is never read, rewritten, or deleted. A host that wants a skill of its own uses
  an unmarked name.

`install` adds one `/.omp/skills/devboard-<name>` line per shipped skill to the host
`.gitignore`; a rerun adds nothing. `doctor` compares each shipped skill directory with the
installed package and exits nonzero on one differing byte; an unmarked host skill never fails that
check.

The API Standards worker reads the project copy: `apiStandardsConfig().skillDocument` is
`.omp/skills/devboard-restful-api-implementation/SKILL.md` and its rule table is
`references/zalando-rest-rules.md` under the same directory.

## Cross-boundary changes

Split, never mix: host-specific detail in host files; generic mechanism in `.devboard/` taking that detail as input. A host name, path, or stack inside `.devboard/` is a bug. A harness dependency outside it is a bug.

## Worktree

Do all work — host and harness — in an isolated git worktree: `<repo root>/.worktree/<name>`.
Never outside the repo root. Never edit the opened checkout. One worktree per task; edit, build,
and test inside it.

Done means merged into main **and pushed to the upstream that tracks it**. A local commit, a local
merge, or a deleted worktree branch is not done. Before deleting the worktree, verify the push:
`git ls-remote <remote> refs/heads/main` must name the integration commit, and
`git status --short --branch` must report no commits ahead of the upstream. A local merge that is
never pushed is a failed task, even when every test passes. If a push is rejected, fetch the new
tip, integrate it, resolve every conflict yourself, rerun the checks it invalidates, and push
again. Never finish, hand off, or delete the worktree with local-only changes.

After the push, advance the integration checkout to the published revision without discarding
its uncommitted work, then run `cd .devboard && bun run publish` so every dashboard that serves
the checkout runs the new bundle and server. Deleting the worktree before the integration
checkout is published and verified is a failed task.

## Line length

Never create a line longer than 768 bytes (UTF-8) in a repository text file. Hard-wrap
prose, prompts, and Markdown list items; do not rely on a later reader re-opening a
truncated line. Aim for 100 columns or less. Generated files such as lockfiles are exempt;
never hand-edit them.

## Working rules

- State mode and edit root before the first edit.
- Decide which side a new file belongs on first. Two common bugs: a harness artifact in host code, a host fact baked into `.devboard/`.
- Run harness work from the repo root with the host path passed in or discovered at runtime.
- In harness mode, never "temporarily" write outside `.devboard/`; fix the layering.
- Host mode leaves `.devboard/` byte-identical. Harness mode leaves host behavior unchanged except where asked.
- Pushing is part of the task, not a follow-up. Never stop with a commit or merge that exists only
  locally, even when every test passes and the worktree is clean.

## Done

- Both modes: done in `.worktree/<name>`, merged to main, pushed to the canonical upstream, and
  verified that the upstream tip is the integrated commit. Only then are the worktree and branch
  removed. Local-only main is never done.
- Host mode: host build/tests run; `.devboard/` unchanged.
- Harness mode: the pushed commit is released by the Release Train, which dispatched and verified
  the release workflow and the npm package and release assets; installed dashboards report the
  release through `versionState` and keep their update path, while live source dashboards replace
  themselves from the publish-written request; the changed entry point runs from the repo root
  against a supplied host path; no absolute paths or host specifics under `.devboard/`; nothing
  created outside `.devboard/`.

## Map

- `.devboard/` — harness root: interface, toolchain, prompts, extensions, goals, tests,
  `omp/`, `install.sh`, `scripts/publish.ts`.
- `.devboard/scripts/publish.ts` — dispatches the release workflow for the `main` tip, waits for
  it, proves the npm package and release assets, and reports dashboards without restarting them.
  Only the Release Train invokes it.
- `.devboard/release-train/` — the Release Train family: worker, gate call, settings, control,
  state, and runs.
- `.devboard/scripts/release.ts` — publishes the public package and the Gitea fallback release.
- `.devboard/templates/host-AGENTS.md` — host contract copied at release time; byte-identical to
  this file.
- `.gitea/workflows/devboard-release.yml` — CI on the canonical Gitea instance: install, build,
  test, typecheck, and release. GitHub receives a push mirror only.
- `.devboard/omp/` — canonical agent commands, extensions, and skills.
- `.devboard/omp/skills/` — canonical project-scoped skills; `devboard-*` names are
  package-owned and installed into `<host>/.omp/skills/` on every install and update.
- `.omp/` — installed copy of `.devboard/omp/`; never edited by hand.
- `adrs/`, `GOAL.md` — host data at the root; not harness artifacts.
- `.devboard/AGENTS.md` — harness-internal instructions, when present.
- `.worktree/` — per-task worktrees; ephemeral.
- `AGENTS.md` — harness ⇄ host contract; at repo root by design.

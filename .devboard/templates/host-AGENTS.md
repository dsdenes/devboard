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

`.devboard/` owns the browser interface and everything needed to build, test, and run it: the Rust
workspace under `crates/`, the Svelte client, the tests and fixtures, the contract corpus under
`contract/`, the cargo-dist configuration, `index.html`, and the `Dockerfile`. Run its
commands from `.devboard`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D
warnings`, `cargo run -p devboard -- serve`, and `bun run build` for the client bundle; build the
container from the `.devboard` context. The interface is a harness tool, not the host product.

The harness may define its own toolchain, but it must not assume host facts: no host language,
package manager, test runner, build system, or layout. Host data lives at the root — the decision
records in `adrs/` and the goal document `GOAL.md` — and reaches the interface only through paths
the host supplies: `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, `AGENT_COMMAND`. The
lifecycle prompts under `.devboard/prompts/` likewise treat the repository root as the host and
exclude `.devboard/` and `.worktree/` from every survey and every write.

## Releases and installation

The harness is one Rust binary built by cargo-dist. GitHub Releases carries the platform archives
publicly: Linux x64 and arm64 for both gnu and musl, macOS x64 and arm64, plus the shell and
PowerShell installers. Gitea is the forge where version control happens and the authority for
release metadata: every published tag carries one Gitea release whose `devboard-manifest.json`
asset names the version and every platform artifact with its SHA-256. No local checkout, running
dashboard, or npm registry is involved.

A clean machine installs the harness with the released one-command installer. `devboard install
<host>` then writes real files: `<host>/.omp/commands`, `<host>/.omp/extensions`,
`<host>/.omp/skills/devboard-*`, `<host>/AGENTS.md`, and one `.gitignore` line per shipped skill.
No harness path is a symlink, a rerun adds nothing, and `devboard doctor` compares every managed
skill with the released artifact. The canonical `.devboard/` in this checkout is the source tree,
never an installed copy.

Every installed dashboard reads the public GitHub release manifest at startup and every 60
seconds, and installs a newer artifact next to its own binary. Gitea is the local forge and the
publishing authority; it is not a consumer dependency, so a host with no Gitea installs, updates,
and passes `devboard doctor` from the public GitHub release alone. When the install completes, the server replaces
itself with the installed version without an operator click: every connected page receives the
replacement event, waits for the new process, and reloads once. An unreachable, invalid, or
mismatched manifest leaves the running process serving and is journaled once per attempt. The
replacement never kills a live agentic run or a background worker. Every run owns a detached
process that survives the dashboard, so its state and activity replay after reconnect, an answer
reaches the same run, Stop ends it, and work in flight finishes on the version that started it.
Each background worker family (Issues, Auto Scout, Design System, MCP optimizer, Watchdog, Release
Train) accepts a live worker of more than one harness version: the running version starts its own
worker when an older one is live, sends the older worker a drain, and every unit that arises
afterwards is claimed by the newest worker. The older worker starts no new unit, finishes its
in-flight unit, exits when its last unit ends, releases its lock, and leaves its state and activity
readable. Start launches the newest installed version when no worker is live; Pause, Resume, Check
now, Stop, and settings apply to every live worker of the family. A worker started by a version
that predates this mechanism has no drain command and is never killed mid-unit; it is left to
finish its unit.

The operator's Start and Stop are durable commands, never a report the worker's own state can
revive. The dashboard writes a family's intent under its state directory, keyed by repository and
family; an enabled family restarts its worker on the newest version after a dashboard restart or a
version change, a disabled family is drained and never started by a takeover, and only an explicit
Start clears a Stop. A Start that never produced a worker is not retried behind the operator's
back. The card never says `stopped` while a worker or one of the family's agent peers is alive: a
live worker reads `running` or `stopping`, and a peer that outlived its worker reads `stopping`
with its pid until it is reaped. Every ACP peer carries a kernel parent-death signal and a
supervision record, so ending its worker ends it too, and a recorded peer whose owner is gone is
reaped by the ordinary orphan pass.

`versionState` reports `running`, `installed`, `latest`, `stale`, and `source`. `running` is the
version the process actually loaded; `installed` is what a restart would load now — the binary and
manifest beside it on an installed host, the checkout's released source version on a source
checkout, and the newest fully published release a launcher restart would load on a launcher
published-worktree dashboard. The status bar labels that second value `installed` on an installed
host and `source` on a source checkout, renders the newest published release beside it whenever
`latest` differs from `running`, and marks the pair stale while a restart would load different
code. The reload control is rendered only when a replacement could not start: the
running version keeps serving, its accessible name and title name both versions, and clicking it
retries the same launcher. The desktop launcher installs the selected release binary over
`.devboard/target/release/devboard` by staging beside it and renaming atomically, so a process
executing the canonical binary keeps its inode and the upgrade never fails with `Text file busy`.

A launcher published-worktree dashboard — a dashboard the launcher starts from a published tag
worktree under `<repo>/.devboard/published/<version>/.devboard` — reads the newest fully published
release at startup and every 60 seconds, verifies that release's platform artifact, installs its
binary under `<repo>/.devboard/published/.releases/<version>/devboard` (never inside a tag worktree,
never at `<repo>/.devboard/bin/devboard`), and replaces its own process through the ordinary
handoff. Its `installed` and `latest` name that newest fully published release, so a dashboard the
launcher started on an older release reports `stale: true` until it upgrades itself, and the
checkout stays a source deployment. The release that introduces this path activates it once:
`devboard publish` hands a restart to `desktop/devboard-launcher.py`, which waits for that run's
`result.json` and then replaces the dashboard with the release publish just proved. The attempt is
recorded at most once per published version, a successful launch records activation in
`STATE_DIR/desktop/published-bootstrap.json` so no later release bootstraps again, and a bootstrap
that cannot start leaves the old dashboard serving and is journaled without failing the release. A
canonical source checkout that is not such a dashboard still never installs or replaces itself on
an update check. It replaces itself only after one successful `devboard publish`: that path
discovers live dashboards through the shared process inventory and writes a source-refresh request
into each one's own
`STATE_DIR` only after its fast-forward,
client build, cargo-dist workflow wait, GitHub-asset check, and Gitea-manifest check have all
passed. The request names the published commit, the released version, and a SHA-256 of the built
`.devboard/dist`; the dashboard verifies that digest without a second build, replaces itself through
the ordinary replacement handoff, and records the applied commit so the same publish never restarts
it twice. A missing, invalid, or mismatched request, a failed spawn, or a replacement that never
becomes ready leaves the old process serving and is journaled once per attempt; a request whose
digest no longer matches the served bundle was superseded by a later build, so it is recorded once
per request as `activity` rather than an error. A valid pending request is retried on a fixed
interval, 60,000 ms by default and configurable with
`DEVBOARD_SOURCE_REFRESH_INTERVAL_MS` (minimum 1,000 ms). A new commit, a new tag, a rebuilt
`dist`, an edited source file, a page reload, and an update check never restart a source dashboard.
Installed hosts never receive or act on a source-refresh request. When GitHub cannot serve the
artifact and `DEVBOARD_GITEA_URL` is configured, install and update fall back to the Gitea release
artifact and its checksum for the same version. A failed download, checksum, authentication, or
install leaves the installed harness and the running server intact; the journal records the
failure and doctor reports it.

Harness-owned issue reporting uses only the configured Gitea API. Without `DEVBOARD_GITEA_URL` the
report controls are not rendered and `POST /reports` answers HTTP 503 naming that variable; no
GitHub request is made. An accepted report answers HTTP 202 with the record the dashboard files,
and a forge that rejects the reporting credential settles that record as failed with the
credential named, journaled as activity, never as a server error, because the operator owns that
fix. A forge that could not serve the creation — an unreachable upstream, a rate limit, or its
own busy database — settles that record as failed with the fixed detail, journaled as activity
and never as a server error. An answer this server could not use — a creation the forge refused
outright, other than a rejected credential, or a document missing its issue — is journaled as a
server error. Host-forge behavior for GitHub and GitLab origins is unchanged.

Every tracker read and credential selection resolves the forge from the checkout's `origin`:
`github.com` is GitHub, a GitLab host is GitLab, `DEVBOARD_FORGE` pins a self-hosted instance,
and every other host — this Gitea origin included — is Gitea, so no `gh` or `glab` process starts
for a Gitea origin. An origin that names no supported forge refuses every forge path with the
origin as the reason and starts no forge CLI and no forge HTTP request. The Issues panel reports
each tracker failure with its forge, its operation, and the concrete cause.

## The Release Train releases

The Release Train is the only component that publishes a Devboard version. It is the
`release-train` background agent family in the dashboard, and it is gated to the harness source
checkout: on a host project its entry stays listed and disabled, carries `Release Train runs only
in a harness source checkout; this project is a host project.`, and starts no worker.
On each tick its worker runs one
deterministic gate and starts one `omp acp` release agent only when the gate finds unreleased
commits. Nothing is published under `@dsdenes/devboard-harness`.

- **Project kind.** The Release Train runs only in the harness source checkout. A host project
  deploys itself through Deploy on main; the Release Train page there shows that reason and no
  Start control.
- **Cadence.** The default is 10 minutes, and the field accepts 1 through 1440 minutes.
- **Gate.** The worker fetches `origin/main` and its tags and compares that tip with the newest
  release tag of the line: a tag whose commit is merged into the tip, or whose commit's parent is
  (a pinned release commits its bump only on the tag and never advances `main`). The gate,
  `devboard publish`, and the source `versionState` share that one release-line rule. Unreleased
  means at least one non-merge commit after that tag; with no release tag, every non-merge commit
  is unreleased. Only merge commits release nothing. An unreadable remote, tag, or commit read
  records a failure and starts no agent.
- **Lifecycle.** A dashboard that starts with the family enabled starts a worker again when the
  recorded worker is dead or its kernel start ticks differ. A version drain ends the worker but
  leaves `enabled: true`, so the replacing dashboard starts one without an operator Start. Only an
  explicit Stop clears the intent. A failed automatic start is journaled once per attempt and
  retried on a bounded backoff of at least 5 and at most 60 seconds.
- **Integration refusal.** A run whose publish integrates an already-published release commit
  records the run as `failed` with that detail, keeps the worker `running` and `enabled`, and
  re-gates on the next due tick without an operator Start.
- **Singleton.** At most one release agent run exists per repository. A second worker of the same
  harness version refuses to start while one is live; a cadence tick or Check now during an active
  run starts nothing. After a run ends, the next due tick may start one.
- **Batching.** One run publishes exactly one version for every non-merge commit since the newest
  release tag, using the existing Conventional Commit derivation: one canonical cargo-dist build
  from the tagged Gitea commit, one GitHub release of the platform archives, installer, checksums,
  and `devboard-manifest.json`, one Gitea release for the same tag carrying the manifest and
  checksums, and one tag naming the released commit. The GitHub release tag names an empty-tree
  commit and GitHub's `main` never reaches the released commit.
- **Pinned target.** The gate's target commit pins the whole run. `devboard publish --target
  <sha>` releases exactly the range ending at that commit, and the run records that commit as its
  released sha. It fetches canonical `main` and its tags once, checks out the target in its own
  detached worktree, derives the version from the target's range once, and compares it with the
  `version` in the run's `request.json`. A target or version the request does not name, a target
  the checkout cannot read or that is not reachable from `main`, and a target that is already
  released all fail before any tag push, workflow dispatch, or release write, with a concrete
  first error line and no tag left behind. Commits that land on `main` after the gate are not part
  of that release and wait for the next tick, which re-gates at then-current `main`. A pinned run
  never integrates a landing into its release, never re-fetches, and never derives a second time.
- **CI gate.** `devboard publish` reads the pinned target's `devboard-ci.yml` run on Gitea, and
  pushes the tag only after that run concludes `success`. The target is already on `main`, and the
  release adds no branch commit: it publishes the tag that names the release commit. A settled
  failure restarts that same run once through the forge, because the commit is already on the
  branch and no later push produces a second run; the restarted attempt gets the same bound. A
  refused restart, a restart that settles without success, or a run still absent after the bounded
  wait leaves the range unreleased, records the run id, its conclusion, and the job and step that
  failed, and retries on the next tick.
- **Retry.** A failing workflow conclusion, a missing GitHub release artifact, a missing Gitea
  manifest, or a rejected derived version records the failure with its detail, ships nothing, and
  leaves the range unreleased. The next due tick starts a new run without operator action and
  re-gates at then-current `main`. A tag that already covers the target without a complete
  release is completed rather than re-tagged; a target whose release already verifies is refused
  with a concrete first error line. When the refused version is a published release of this line
  from a commit `main` never carried, that release commit is integrated into `main` forward-only
  before the refusal and the push is proven, so the next tick re-gates at a `main` that carries
  the release instead of deriving the same version forever. A failed run is never recorded as
  released.
- **Stop.** Stop ends the peer before its publish finishes. The run settles as `stopped`, never as
  a failed release, and the page raises no error for it: the operator's stop is the cause, and a
  release absent at that moment is its consequence. The record the stopped run keeps is the retry
  handle a tag the stop already pushed still needs, so a later tick verifies that release and
  records it once it ships. A peer that reported its publish failed, a publish error, or a bound
  that closed the peer keeps its failure, because the stop did not produce it.
- **Agent.** `.devboard/prompts/release-train.md` instructs one run to release the collected range
  through `devboard publish --target <sha>`, taking the target and version from the run's
  `request.json` and never re-fetching or re-deriving `main`, verify the GitHub assets and the
  Gitea manifest, and report the version and release URL. `devboard publish` dispatches
  `.github/workflows/release.yml` for the released tag when that tag has no usable run, then
  performs the existing verification; it never requires a push.
- **Agent.** The worker starts exactly one `omp acp` peer with `/release-train <run-dir>`; the run
  state names that peer, and Stop ends it. `.devboard/prompts/release-train.md` is the instruction
  the peer receives. The peer releases through `devboard publish` and verifies the GitHub assets
  and the Gitea manifest; it never edits a tracked file.
- **Release suite and classification.** `devboard publish` runs `devboard release-suite` before it
  tags or dispatches, and refuses both when the suite exits nonzero. The suite runs the pinned
  commit's tree, whose `HEAD` is the target, in the publish worktree: an uncommitted edit or a
  later landing in the integration checkout cannot change the gate's result. It runs the workspace
  suite once and retries each failing test alone. A test that fails the whole-suite attempt and
  passes its isolated retry is flaky: it is skipped for the rest of that run, files one
  deduplicated issue naming its file, exact name, released commit, workflow run, and whole-suite
  failure output, and does not block the release; the run starts no second whole-suite attempt. A
  test that fails its isolated retry is deterministic: it files one issue and blocks the release,
  and no tag is created, pushed, or dispatched. The skip is run-only: nothing is read back from
  the forge to decide what runs, so a test with an open flaky issue executes on the next run. A
  later finding for the same test appends one comment to the open issue and creates no second
  issue; a filing failure logs one line and never changes the suite's verdict. No tracked test
  file is rewritten, deleted, renamed, ignored, commented out, or given a changed assertion, so
  `git status --porcelain` stays empty and the tree stays byte-identical. An attempt that ran no
  test because the kernel refused to start a freshly built binary, or because the target directory
  left while the build ran, is retried whole and reported only once the attempt budget is spent. A
  suite that cannot compile, or that yields no per-test result, exits nonzero, files nothing, and
  prints the first concrete error line.
- **No other releaser.** `.github/workflows/release.yml` runs only on
  `workflow_dispatch`. The implementing agent closes its issue after the push proof and never
  publishes. The Design System pushes its documentation commit and reports without waiting for a
  release. No prompt, worker, or workflow other than the Release Train starts a release.

A change is finished when it is merged to `main`, pushed, and released by the Release Train. The
integration checkout is advanced and rebuilt after a push; it is never a place for feature work.
If its uncommitted changes block the fast-forward, preserve them (copy or patch them aside, apply
the published revision, reapply the changes) and rerun the train's publish path. Never discard
them and never bypass the fast-forward. Never run `devboard publish` by hand and never dispatch the
release workflow by hand: the Release Train owns both.

Guardrails:

- Never rebuild only a worktree or only the client and call the change done.
- Never kill, spawn, or relaunch a dashboard server by hand: the MATE top-panel Devboard icon
  (`desktop/devboard-launcher.py`) sweeps this host's stray dashboards and starts, restarts, or
  stops exactly one, and the resident panel indicator runs those same four actions; install,
  update, the reload control, and the publish-driven source refresh are the only other paths.
- Never copy the harness into a host or symlink a host path to this checkout; install owns the
  host prefix.
- Stale output is the first suspect, not the last: when the UI behaves like an older revision,
  compare `versionState` and the installed package version before debugging client code.
- A UI check against a bundle or server older than the changed source is not a passing
  verification.

## Deploy on main

The Deploy on main background family (`deploy-on-main`) deploys the served host project whenever
the served checkout's `main` advances. It and the Release Train are gated to opposite projects:
the Release Train releases the harness source checkout, and Deploy on main deploys host projects.
The host project's own `AGENTS.md` owns how that deployment happens.

- **Gate.** Deploy on main runs only on a host project. In the harness source checkout its entry
  stays listed and disabled, carries `Deploy on main runs only on host projects; this project is
  the harness source checkout.`, and renders no Start control. The Release Train is gated the
  other way and carries its own reason on a host project.
- **Trigger.** It is push-triggered, with no cadence and no timer: the descriptor has no interval,
  the page renders no cadence field, and one coalesced run exists per advance of the served
  checkout's `main`. An advance that arrives during a live run is folded into the next run.
- **Worktree.** Every run deploys the triggering commit from the fast-forward-only worktree at
  `<served checkout>/.worktree/deploy-main`. Nothing edits the served checkout, moves `main`,
  force-updates a ref, or rewrites history.
- **Instructions.** The worker reads the host project's root `AGENTS.md` and hands its
  deploy-instructions section to one `omp acp` peer per run as `/deploy-on-main <run-dir>`. The
  peer executes exactly those instructions from the deploy worktree and writes
  `<run-dir>/result.json` as `{"ok":true,"detail":"…"}` or `{"ok":false,"detail":"…"}`; a host
  `AGENTS.md` with no deploy instructions yields `{"ok":false,"skipped":true,"detail":"…"}` and a
  skipped run.
- **Never.** A deploy never runs a release, never kills or relaunches the dashboard, and never
  deploys a commit other than the one its request names. The peer's only writes are its result
  document and whatever the host's own instructions write.

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

The package ships seven project-scoped skills, canonical under `.devboard/omp/skills/`:
`devboard-ui-ux`, `devboard-restful-api-implementation`,
`devboard-single-responsibility-principle`, `devboard-consistent-naming`,
`devboard-architectural-layering`, `devboard-gh-stack`, and `devboard-harness-reference`. Every
install, manual update, and
automatic update copies them as real files into `<host>/.omp/skills/<name>/`, where a plain `omp`
session at the host root discovers them at project scope.

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

## Resource limits

Every worker, run owner, and `omp acp` peer the dashboard starts runs inside the transient
`devboard.slice`; the dashboard process itself stays outside it, so a slice kill never takes the
control plane down. One global cap bounds concurrent agent peers across the Issues worker, every
background family, goal, flow, the Release Train, and manual runs. Discover runs are outside that
cap: a Discover start is admitted while every cap slot is held, so its peer never waits in a
silent `starting` state and never records a cap deferral. The memory reserve and the slice's
kernel `MemoryMax` still defer or kill a Discover start like any other. A start at the cap or
below the memory reserve is deferred with a recorded reason and retried on a later tick; it is
never marked failed, and running work is never stopped for budget reasons. The kernel's hard
slice limit is the only kill. The Resources page reports the cap's live count and, beside it, the
live Discover peers outside the cap in a separate exempt count; the cap's holder groups and
deferral lines name only cap slots.

The budget is derived from host memory and CPUs: the reserve is `max(1 GiB, 25% of MemTotal)`,
the hard maximum is `MemTotal - reserve`, the soft high mark is 80% of the maximum, and the agent
cap is `max(1, cpus / 4)` clamped to 1..=64. The reserve is the only hard protection for the
desktop session: the slice may use everything above it. `DEVBOARD_MEMORY_RESERVE_MB`,
`DEVBOARD_MEMORY_MAX_MB`, `DEVBOARD_MEMORY_HIGH_MB`, and `DEVBOARD_MAX_AGENT_PEERS` override a
default when no saved value exists. The Devboard workspace's `Resources` tab reads and saves the
same values, refuses a maximum that reaches into the reserve, applies the values to the live slice
without a restart, and persists them in the dashboard state directory. A CLI invocation, a
workspace test, and a worker only join the slice; only the dashboard ever rewrites its budget.
A host whose memory total cannot be read derives no memory budget at all: the peer cap stands,
no memory mark is derived, saved, or written to the slice, the failed read is journaled once as
activity, and the Resources page reports `memory unavailable` instead of a number.

The host write path is bounded too. `/etc/sysctl.d/99-io-tuning.conf` sets
`vm.dirty_background_bytes=268435456` and `vm.dirty_bytes=1073741824`, so a workspace build cannot
accumulate several GiB of dirty page cache before the kernel throttles it. The
`devboard-io-tuning.service` system unit delegates the `io` controller to the user slice and
calibrates iocost for the root device. The slice and every transient scope under it carry
`IOWeight=10`; `DEVBOARD_IO_WEIGHT` overrides it. `IOWriteBandwidthMax` is unset unless a
measured build proves the weight insufficient. The workspace links with `mold` from the apt
package `mold` (2.40.4 or newer) through `.cargo/config.toml`. Build output is reclaimed only when
no process works inside it: `target/` and `.devboard/target/` under `.worktree/*`,
`.devboard/.test-tmp`, and `.devboard/target/debug` beyond its 20 GiB cap; a live worktree target is
skipped and named, and no worktree, branch, tracked file, or commit is removed.

## Cross-boundary changes

Split, never mix: host-specific detail in host files; generic mechanism in `.devboard/` taking that detail as input. A host name, path, or stack inside `.devboard/` is a bug. A harness dependency outside it is a bug.

## Worktree

Do all work — host and harness — in an isolated git worktree: `<repo root>/.worktree/<name>`.
Never outside the repo root. Never edit the opened checkout. One worktree per task; edit, build,
and test inside it.

Done means merged into main **and pushed to the upstream that tracks it**. A local commit, a local
merge, or a deleted worktree branch is not done. `devboard land <branch>` performs that landing and
its proof: one fast-forward merge into the integration checkout, one push, and the remote tip read
back and printed beside the merged commit and the checkout's ahead/behind. A local merge that is
never pushed is a failed task, even when every test passes. If the command refuses a push, reread
its first stderr line, integrate what it names, resolve every conflict yourself, rerun the checks
it invalidates, and call it again. Never finish, hand off, or delete the worktree with local-only
changes.

After the push, advance the integration checkout to the published revision without discarding
its uncommitted work, then run `cd .devboard && cargo run -p devboard -- publish` so every
dashboard that serves the checkout runs the new binary. Deleting the worktree before the integration
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
- Harness source: a change is finished when it is merged, pushed, and released by the Release
  Train. The Release Train dispatches and verifies the release workflow, the GitHub assets, and the
  Gitea manifest; installed dashboards report the release through `versionState` and keep their
  update path, while live source dashboards replace themselves from the publish-written request.
- Host project: a change is finished when it is merged and pushed. Deployment belongs to the host's
  own Deploy on main path; no background agent waits for, inspects, or claims a release or a
  deployment.
- Host mode: host build/tests run; `.devboard/` unchanged.
- Harness mode: the changed entry point runs from the repo root against a supplied host path; no
  absolute paths or host specifics under `.devboard/`; nothing created outside `.devboard/`.

## Map

- `.devboard/` — harness root: interface, toolchain, prompts, extensions, goals, tests,
  `omp/`, `install.sh`, `scripts/publish.ts`.
- `.devboard/crates/devboard/src/land.rs` — `devboard land <branch>`: the one fast-forward landing,
  its lock retry, its push, and the remote-tip proof a finished task reports.
- `.devboard/crates/devboard/src/publish.rs` — tags the released commit, dispatches the cargo-dist
  workflow, waits for it, proves the GitHub assets and the Gitea manifest, and reports dashboards
  without restarting them. Only the Release Train invokes it.
- `.devboard/release-train/` — the Release Train family: worker, gate call, settings, control,
  state, and runs. It runs only in the harness source checkout.
- `.devboard/prompts/deploy-on-main.md` — the Deploy on main instruction: one run executes the
  host `AGENTS.md` deploy steps from `.worktree/deploy-main` at the triggering commit. It runs
  only on host projects.
- `.devboard/dist-workspace.toml` — the cargo-dist workspace: the platform matrix, the installers,
  and the GitHub release host.
- `.devboard/templates/host-AGENTS.md` — host contract copied at install time; byte-identical to
  this file.
- `.github/workflows/release.yml` — the cargo-dist release workflow GitHub runs for one tag;
  Gitea remains the forge and the release-metadata authority.
- `.devboard/omp/` — canonical agent commands, extensions, and skills.
- `.devboard/omp/skills/` — canonical project-scoped skills; `devboard-*` names are
  package-owned and installed into `<host>/.omp/skills/` on every install and update.
- `.omp/` — installed copy of `.devboard/omp/`; never edited by hand.
- `adrs/`, `GOAL.md` — host data at the root; not harness artifacts.
- `.devboard/AGENTS.md` — harness-internal instructions, when present.
- `.worktree/` — per-task worktrees; ephemeral.
- `AGENTS.md` — harness ⇄ host contract; at repo root by design.

## Objective

In the `/home/ds/devboard` repository, the Devboard harness under `.devboard/` must make every
background-agent Start in the browser dashboard answer immediately: Auto Scout, Watchdog, Design
System, Dead Code, MCP optimizer, API Standards, Single Responsibility, Consistent Naming, and
Release Train. A Start publishes its confirming snapshot before its preflight can delay it, a
Start that will not spawn says why in that same answer, and no Start waits on the provider usage
network call. The same change makes a fresh dashboard connection and a `getAgents` read answer
inside fixed bounds and stops the 250 ms poll from rebuilding and serializing an unchanged
snapshot. The 10 second control ceiling, the existing WebSocket frame set, the contract corpus,
and the documented preflight guarantees stay as they are.

## Success criteria

1. **The starting state arrives before the preflight finishes.** With a real WebSocket client
   connected to a running `devboard serve`, `{"type":"startAgent","id":"<family>"}` reaches the
   server while the family's preflight is held pending; within 1000 ms that same socket receives
   an `agentState` for `<family>` with `lifecycle` equal to `starting` while the preflight is
   still pending. Releasing the preflight delivers the queued final snapshot on the same socket,
   in the order the server produced it.
2. **A Start that spawns nothing is still an answer.** A `startAgent` that does not spawn (a live
   worker another `STATE_DIR` owns, or a family already starting or running) publishes an
   `agentState` whose `notice`, `startError`, or `lifecycle` differs from the snapshot read when
   the command was sent. The client shows that reason, and the control does not wait for the
   10 second ceiling.
3. **The client latch releases on the answer, never on the ceiling.** The background-agent Start
   control's evidence changes on every answering frame. A client test delivers the refusal
   `agentState` while the control is busy and observes `busy === false`, `notice === null`, and
   the refusal reason rendered; delivering a `starting` frame releases the busy word the same way.
   `Start received no answer.` is never rendered when an answering frame arrived.
4. **Provider usage is off the Start path.** With the injected usage transport held pending,
   `Providers::select_environment` returns and a `startAgent` spawns without awaiting that
   transport. Stale usage is refreshed by a background path without a Start or a `getProviders`
   request: a test with an injected clock advances 60 seconds, observes the transport called, and
   observes the refreshed report written to the cached usage.
5. **A fresh connection and a read answer inside their bounds.** On the running dashboard serving
   the released bundle, a new `ws://<host>:<port>/ws` connection receives its first frame within
   1000 ms, and a `getAgents` command is answered with `agentsState` within 250 ms. Replay frames
   are written as they are produced; a connection's replay is not withheld until the whole replay
   has been built.
6. **An idle dashboard stays quiet.** With no agent state file changing, a connected client
   receives no periodic `agentState` broadcast for 2 seconds; the poll publishes only a snapshot
   whose serialized form changed.
7. **The workspace gates are clean and the contract is unchanged.** `cargo fmt --check --all`,
   `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
   `cargo test -p devboard-contract`, `bun test`, `bun run check`, and
   `bun run build && bun scripts/embed-client.mjs` all exit 0. The diff for `contract/`,
   `../DESIGN.md`, and `crates/devboard/assets` is empty, and the tree is clean after the commit.
   `README.md` describes the button, transport, and provider behavior the change produces.
8. **The change is merged, pushed, and released.** `main` at the upstream names the integrated
   commit, and the Release Train has published a version whose Gitea `devboard-manifest.json`
   names that commit's tag and the artifact SHA-256. The live dashboard reports the released
   version through `versionState` before criterion 5 is measured.

## Verification

Targeted regressions (each test name is required and lives in the named file):

```bash
cd .devboard
cargo test -p devboard --test http_surface a_starting_frame_arrives_while_the_preflight_is_pending
cargo test -p devboard --test agents_mode a_start_that_spawns_nothing_still_answers
cargo test -p devboard --test agents_mode an_unchanged_snapshot_is_not_rebroadcast
cargo test -p devboard --test providers a_start_never_waits_for_the_usage_transport
cargo test -p devboard --test providers the_background_refresh_checks_stale_usage
bun test client/lib/agents.test.ts
```

Workspace gates:

```bash
cd .devboard
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p devboard-contract
bun install --frozen-lockfile
bun test
bun run check
bun run build && bun scripts/embed-client.mjs
git diff --exit-code -- contract ../DESIGN.md
git status --porcelain
```

The client bundle check is `git diff --exit-code -- crates/devboard/assets` after the embed step
and before the commit.

Live measurement, run only after the Release Train publishes and `versionState` reports the
released version (never against a stale bundle). In a browser tab on the running dashboard:

1. Open `ws://<host>:<port>/ws` and time the arrival of the first message. It must be at most
   1000 ms.
2. Send `{"type":"getAgents"}` on the same socket and time the `agentsState` reply. It must be
   at most 250 ms.
3. Open a stopped background-agent page and activate `data-testid="agent-start"`. Within 1000 ms
   the busy word must be replaced by the confirming state (the `Stop` control or the server's
   refusal reason) and no `Start received no answer.` notice may appear. Stop the worker with the
   same page's `agent-stop` control.

Release proof:

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
curl -fsS "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/latest"
```

The first two must name the same commit; the release must carry `devboard-manifest.json` for that
tag with the published version and the artifact SHA-256.

## Boundaries

- Work only in a git worktree under `<repo root>/.worktree/`; never edit the opened checkout.
- Harness mode: every edit stays under `.devboard/`. Host files at the repository root, `adrs/`,
  and `GOAL.md` stay byte-identical. Leave the concurrent uncommitted `.omp/skills/` deletions
  and every other uncommitted change alone.
- Allowed source files: `.devboard/crates/devboard/src/http.rs`,
  `.devboard/crates/devboard/src/agents_mode.rs`, `.devboard/crates/devboard/src/providers.rs`,
  `.devboard/crates/devboard/src/app.rs` (background refresh wiring only),
  `.devboard/client/lib/agents.svelte.ts`, `.devboard/client/lib/command-busy.svelte.ts`,
  `.devboard/client/lib/components/AgentPage.svelte`,
  `.devboard/client/lib/types.ts` or `.devboard/client/lib/agent-registry.ts` for snapshot
  fields, `.devboard/crates/devboard/tests/*`, `.devboard/README.md`, and the generated
  `.devboard/crates/devboard/assets/**`.
- Forbidden: any new WebSocket frame type; any edit under `.devboard/contract/`; any change to
  `DESIGN.md`, the 10 second ceiling, `COMMAND_CEILING_MS`, or the documented preflight budget
  and retry schedule; `.devboard/omp/`, `install.sh`, or an installed host; timing assertions in
  the CI test suite (the live bounds are operator checks, not test-suite gates); any file,
  cache, log, or worktree outside `<repo root>`.
- Never publish by hand, never dispatch the release workflow by hand, and never stop, spawn, or
  relaunch a dashboard. The Release Train and the publish-driven source refresh are the only
  paths.

## Stop conditions

- Effort is uncapped: no attempt limit, no token or time budget. Continue until every success
  criterion is verified.
- Halt and surface, rather than proceed, for: genuine ambiguity; a risky or irreversible
  operation (adding a frame type, changing the contract corpus, changing `DESIGN.md` or the
  ceiling); a missing prerequisite (a live Gitea, a provider credential, a Release Train worker,
  or a dashboard serving this checkout); a blocked external dependency (GitHub or Gitea
  unreachable, the release workflow red, or the Release Train not publishing).
- Never weaken a documented guarantee to make a criterion pass: the forge preflight, the 10
  second ceiling, the frame contract, the contract corpus, or the release path. If a criterion
  cannot be met without weakening one, stop and report the conflict.

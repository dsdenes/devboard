## Objective

In the `/home/ds/devboard` repository, the Devboard harness under `.devboard/` must make the
Issues Overview's cap-deferral line truthful and attributable. While an issue start is deferred,
the line names the live agent peers that hold the cap, grouped by the starter that created each
one, and states the effective saved cap (24 on the running dashboard). Once no start is deferred,
the line disappears on the next worker publish, and no unattached or older-version worker state
can reintroduce it. The same change deletes `.devboard/README.md`, preserves its reference
content in an on-demand `devboard-harness-reference` skill, and makes `.devboard/AGENTS.md` the
only home for long-term agent rules, including a rule that automated verification never mutates a
live operator dashboard. The change ships through the Release Train and is proven on the running
dashboard.

## Success criteria

1. **The deferral line is live and attributable.**
   - A worker pass with no deferred start publishes `deferral: null`, and the Issues Overview
     renders no `data-testid="issues-deferral"` element.
   - A pass that defers a start publishes exactly
     `issue #<n> deferred: <A> agent peer(s) already run at the cap of <C> (<starter> <count>, ...); the start is deferred`
     where `<C>` is the effective saved cap, `<A>` is the number of live governed slots, every
     `<starter>` is the starter name recorded on those slots, every count is positive, the counts
     sum to `<A>`, and groups sort by count descending, then starter name ascending.
   - Every slot file under `resources/slots/` carries the starter name, and
     `devboard resources status` exposes it; peers started by different surfaces carry different
     starter names.
   - When a slot frees or the cap rises, the next pass publishes `deferral: null` without a
     worker restart.
2. **No stale line.**
   - A deferral persisted in a stopped or unattached worker's state, and a deferral-shaped
     `notice` written by an older harness version, never render as `issues-deferral` or as an
     `issues-notice`.
3. **The live cap is 24.**
   - On the running dashboard, `.devboard/.tmp/resources/settings.json` and the `resourcesState`
     frame report `maxAgentPeers: 24`; twelve live background peers at cap 24 produce no deferral
     and no line.
4. **Documentation has one instruction home.**
   - `.devboard/README.md` is absent; `git ls-files .devboard/README.md` prints nothing.
   - `.devboard/omp/skills/devboard-harness-reference/SKILL.md` exists with
     `metadata.devboard-builtin: "true"`, preserves every `## ` heading of the deleted README,
     lists all seven project-scoped skills, and describes the starter-grouped deferral line.
   - `.devboard/AGENTS.md` states, in its own words but covering these terms, that long-term agent
     instructions live only in `AGENTS.md` (read every run) or `.omp/skills/<name>/SKILL.md`
     (read on demand), that no `README.md`, `docs/` tree, or other instruction file may be
     created, that `.devboard/README.md` is retired, and that its reference content is the
     `devboard-harness-reference` skill.
   - `.devboard/AGENTS.md` also states that automated verification uses a throwaway
     `--state-dir` under `.devboard/.test-tmp` with an ephemeral port and never calls
     `setResources`, Start, Stop, or any mutating command against a live operator dashboard.
   - Root `AGENTS.md` and `.devboard/templates/host-AGENTS.md` list seven project-scoped skills,
     no longer list `.devboard/README.md` as an owned file, and are byte-identical.
5. **Verification hygiene holds.**
   - No tracked harness script, test, or e2e config targets `.devboard/.tmp` or port 8080 as a
     write target for resource settings.
   - The SHA-256 of `.devboard/.tmp/resources/settings.json` is unchanged by the full check suite,
     and its content reports 24.
6. **The checks pass from the task worktree.**
   - `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
     `cargo test --workspace`, `bun test`, `bun run build`, and `bun run check` all exit 0 from
     `.devboard/`.
   - A workspace test named `the_deferral_names_every_live_starter` proves: cap 2, one Watchdog
     slot and one Auto Scout slot held, a queued issue publishes the grouped line naming both
     starters and cap 2; dropping one slot clears `deferral` on the next pass. The existing
     `a_resolved_deferral_leaves_no_line_behind` test keeps passing.
   - An install into a throwaway host under `.devboard/.test-tmp/` followed by
     `devboard doctor <host>` exits 0 and compares `devboard-harness-reference` byte-for-byte.
7. **The release is proven on the running dashboard.**
   - The commit is merged to `main` and pushed to the upstream that tracks it; the Release Train
     publishes it.
   - The dashboard on 127.0.0.1:8080 reports the released version as `versionState.running` and
     shows no deferral line while no start is deferred; its Resources state reports
     `maxAgentPeers: 24`.

## Verification

Run every command from the task worktree's `.devboard/` unless stated otherwise.

- Checks: `cargo fmt --check --all`, then
  `cargo clippy --workspace --all-targets -- -D warnings`, then `cargo test --workspace`, then
  `bun test`, then `bun run build`, then `bun run check`; each must exit 0.
- Deferral proof: `cargo test -p devboard the_deferral_names_every_live_starter` and
  `cargo test -p devboard a_resolved_deferral_leaves_no_line_behind` exit 0.
- Client proof: `bun test client/lib/components/IssuesWorkspaceDeferral.test.ts` exits 0 with a
  case asserting the grouped line renders in `issues-deferral` and a `null` deferral renders no
  element.
- Docs: `git ls-files .devboard/README.md` prints nothing;
  `test -f .devboard/omp/skills/devboard-harness-reference/SKILL.md` exits 0;
  `git show <base>:.devboard/README.md | grep '^## '` yields every heading, and each heading is
  found in the skill (`grep -F -- "<heading>"`); the skill contains `devboard-harness-reference`
  and `seven project-scoped skills`; `.devboard/AGENTS.md` contains `AGENTS.md`, `.omp/skills`,
  `.devboard/README.md is retired`, `throwaway`, `.devboard/.test-tmp`, and
  `never mutate`/`never call`; `cmp AGENTS.md .devboard/templates/host-AGENTS.md` exits 0;
  `grep -F 'seven project-scoped skills' AGENTS.md .devboard/templates/host-AGENTS.md` matches
  both files.
- Install and doctor: create a host under `.devboard/.test-tmp/`, run
  `cargo run -p devboard -- install <host> --force`, then
  `cargo run -p devboard -- doctor <host>`; both exit 0.
- Live-state invariance: `sha256sum .devboard/.tmp/resources/settings.json` before and after the
  whole check suite must match, and `grep -F '"maxAgentPeers": 24'` must match that file.
- Scratch dashboards: any `devboard serve` used for verification runs with `--port 0` and a
  `--state-dir` under `.devboard/.test-tmp/`; none writes `.devboard/.tmp` or port 8080.
- Release proof: after the Release Train publishes and the dashboard replaces itself, open
  127.0.0.1:8080; `getVersion`/the status bar reports the released version, the Issues Overview
  has no `issues-deferral` element while no start is deferred, and the Resources state reports
  `maxAgentPeers: 24`.

## Boundaries

- Do all work in `.worktree/<name>`; never edit the opened checkout.
- Allowed: `.devboard/**` including the Rust crates, client, contract corpus, `.devboard/AGENTS.md`,
  `.devboard/omp/skills/devboard-harness-reference/`, `.devboard/bench/run.sh`, and the deletion
  of `.devboard/README.md`.
- Allowed by `install.sh` only: the tracked `.omp/skills/devboard-harness-reference/` mirror;
  never hand-edit `.omp/`.
- Allowed for the skill-list and README-removal sync only: root `AGENTS.md` and
  `.devboard/templates/host-AGENTS.md`, which stay byte-identical.
- Untouched: `adrs/`, `GOAL.md`, root `.design/`, `.devboard/hooks/README.md`,
  `.devboard/e2e/fixtures/**`, `node_modules`, and the live `.devboard/.tmp` state. The live state
  is read and hashed, never written.
- No new README, `docs/` tree, or instruction file; the only new Markdown is the skill.
- Never call `setResources`, Start, Stop, or any mutating command on the live dashboard.
- Never run `devboard publish` or dispatch the release workflow; the Release Train owns both.
  Never restart, kill, or relaunch a dashboard by hand.
- Merge to `main` and push to the upstream that tracks it; a local-only commit is not done.

## Stop conditions

- Continue until every criterion is verified; there is no attempt cap and no token, time, or
  budget limit.
- Halt and surface only for genuine ambiguity, a risky or irreversible operation, a missing
  prerequisite, or a blocked external dependency.
- Delete `.devboard/README.md` only after every heading is present in the skill; recover it from
  git and stop if the comparison fails.

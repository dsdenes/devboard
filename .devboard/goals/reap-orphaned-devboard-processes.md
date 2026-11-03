## Objective

This repository's Devboard harness (`.devboard/`, the canonical source checkout that every installed
host ships from) must stop accumulating orphaned processes. Today a spawned child outlives whatever
started it: an ACP peer, a verification dashboard, a detached run owner, a background worker, or a
test fixture keeps running after its owner dies from `SIGKILL`, a crash, an aborted `bun test`, or a
killed `verify:*` script, and the only process-aware component deliberately ignores verification
fixtures (`watchdog/discovery.ts:153`). This goal makes every harness-spawned process supervised on
Linux: isolated in its own process group, durably recorded with its owner, and reaped within one
60-second tick once its owner is provably dead — without ever signalling a process the proof does
not cover.

## Success criteria

1. **One supervised spawn path.** Every long-lived harness child — the verification and test
   dashboard (`scripts/verification.ts:232`), the ACP peer (`server/acp.ts:256`), a detached run
   owner (`server/run-owner.ts`, `server/goal-draft-owner.ts`), each background worker entry point,
   and each fixture peer — is started through one helper that (a) places the child in its own
   process group, (b) writes `{pid, argv, cwd, ownerPid, startedAt}` under the state directory
   before the child is used, and (c) deletes that record when the child exits or is reaped.
   For each of those six surfaces a test proves the spawned child is a group leader with its own
   `pgid`, that its durable record exists while it runs, and that the record is gone after it exits.

2. **One reaper, two activations.** A single implementation is called (a) by the running watchdog
   process on a dedicated interval of at most 60,000 ms that is independent of the watchdog's cycle
   cadence, and (b) at every dashboard start.

3. **Two-tier kill proof, one test per rule.**
   - record exists, owner pid dead, recorded argv and start time still match → child is killed and
     its record removed;
   - record exists and owner pid is alive → never signalled;
   - no record, cwd or `REPO_DIR` under a `.devboard/.tmp` scratch directory, and the ancestor chain
     reaches PID 1 → killed;
   - no record and nothing under scratch → never signalled;
   - a detached run holding a live lease or handoff (`server/detached-run.ts`) → never signalled;
   - a live worker of an older harness version → never signalled.

4. **Leak regression proof.** A test starts a supervised owner that spawns a peer which spawns a
   grandchild, `SIGKILL`s the owner, and observes every descendant gone within 60 seconds and the
   owner's records removed.

5. **The live machine is clean.** After one tick on the machine that implements this goal, no
   devboard process remains without a live owner — including the 758+ leaked fixture and worker
   processes observed in this session — and the process scan reports no candidate.

6. **Existing checks stay green.** In `.devboard`: `bun test`, `bunx tsc --noEmit`, `bun run build`,
   `bun run verify:install`, `bun run verify:update`, and `bun run verify:ui` all exit 0.

7. **Released.** The change is merged to `main`, pushed, and released by the Release Train, and a
   dashboard's `versionState` reports the released version as `running`.

## Verification

Run each against current state; every command must produce the stated result.

```bash
cd .devboard && bun test
cd .devboard && bunx tsc --noEmit
cd .devboard && bun run build
cd .devboard && bun run verify:install
cd .devboard && bun run verify:update
cd .devboard && bun run verify:ui
```

Criterion 1 — every spawn surface is supervised:

```bash
cd .devboard && bun test --filter 'record'
```

Criterion 2 — the reaper interval constant is at most 60,000 ms and is scheduled independently of
the watchdog cycle:

```bash
cd .devboard && bun test --filter 'reaper'
```

Criterion 3 — each proof rule has a passing named test:

```bash
cd .devboard && bun test --filter 'reaper|supervis|orphan'
```

Criterion 4 — the leak regression passes and fails without the fix (verify by reverting the reaper
invocation, observing the red test, restoring it):

```bash
cd .devboard && bun test --filter 'orphan'
```

Criterion 5 — the machine holds no older stray: both commands print nothing and exit 0.

```bash
cd .devboard && bun run cleanup -- --processes --dry-run
ps -eo pid=,ppid=,etimes=,args= | awk '$2==1 && ($0 ~ /fixtures\/stub-agent\.ts/ || \
  $0 ~ /run-owner\.ts/ || $0 ~ /worker\.ts/) && $3>60'
```

Criterion 7 — the released version is live. `git ls-remote` must name the integration commit,
`git status --short --branch` must report no commits ahead of the upstream, and the Devboard status
surface must report the released version as `running`:

```bash
cd .devboard && git ls-remote origin refs/heads/main
cd .devboard && git status --short --branch
```

## Boundaries

Allowed to change, all under `<repo root>/.devboard/`:

- `server/acp.ts`, `server/app.ts`, `server/run-owner.ts`, `server/goal-draft-owner.ts`,
  `server/detached-run.ts` (registry plumbing only — handoff semantics stay as they are);
- `scripts/verification.ts` and the `scripts/verify-*.ts` spawn and teardown sites;
- `watchdog/` — a new supervision module plus its activation in the watchdog entry point;
- `issues/`, `mcp-optimizer/`, `release-train/` worker entry points, only to route spawns through
  the helper;
- `tests/` and `server/*.test.ts` for the new proofs; `package.json` for any new script entry;
- `README.md` and the docs that describe the cleanup CLI and process lifetime.

Stays untouched:

- `<repo root>/AGENTS.md` and host data (`adrs/`, `GOAL.md`, `DESIGN.md`, `openui.json`, `stories/`,
  `design/`, `WATCHDOG.yml`);
- `.devboard/omp/` and the installed `.omp/` mirror;
- the Svelte client and the built `dist/` beyond what `bun run build` regenerates;
- `watchdog/cleanup.ts`'s age-based file retention rule and its one-week threshold — process
  supervision lives beside it, not inside it;
- detached-run lifetime: a run outlives a dashboard replacement, is adopted by the replacement, and
  is never ended as an orphan;
- the release workflow and `scripts/publish.ts`;
- anything outside `<repo root>` — no temporary files, caches, or logs elsewhere.

Operating limits:

- Supervision reads `/proc`, matching the existing discovery module; on a platform without it the
  reaper reports itself unavailable and signals nothing.
- A signal is sent only under one of the two proofs; a doubt leaves the process alive and journals
  the candidate.
- A live process of an older harness version is never signalled while it holds its lock or unit.

## Stop conditions

Continue until every criterion above is verified against current state. There is no attempt cap and
no token, time, or cost budget.

Halt and surface only for: a genuine ambiguity the repository cannot resolve; a risky or
irreversible operation (a signal that fails the two-tier proof, or work outside `<repo root>`); a
missing prerequisite (no `/proc`, no watchdog install path available); or a blocked external
dependency (the Release Train cannot publish).

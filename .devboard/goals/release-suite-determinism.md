## Objective

The Devboard harness under `.devboard/` in `dsdenes/devboard` stops failing releases at the
release workflow's test step. Every test that has failed a `devboard-release.yml` run is repaired
at its cause instead of being retried, filtered, or skipped; the full suite passes the workflow's
exact command deterministically while the host carries its normal concurrent agent load; the fix
reaches `origin/main`; and the Release Train publishes a version whose release-workflow run
concluded `success` and whose tag, npm package, and Gitea release assets are independently
verified. The affected surface is the `.devboard` test suite, the production code a failing test
exposes, and the release path that gates on it.

## Success criteria

1. Every file in the failed-release set passes ten consecutive runs of `bun test <file>
   --timeout=60000` from `.devboard`, each ending with `0 fail`. The set is every file named by a
   `devboard-release.yml` failure run observed on 2026-11-03 (runs 562-581):
   - `server/flow.test.ts` (run 580, peer-count assertion),
   - `server/discover.test.ts` (run 580, staging removal after reset),
   - `server/static-snapshot-process.test.ts` (run 581, dashboard readiness),
   - `server/ask.test.ts` (run 577, handshake recovery),
   - `tests/issues.test.ts` (run 577, abandon command),
   - `tests/supervision-reaper.test.ts` (run 574, six reaper proofs),
   - `server/skills-preparation.test.ts` (run 570, refusal during a run),
   - `client/lib/components/DiscoverWorkspace.test.ts` (runs 562-567),
   - `client/lib/components/NotificationRegion.test.ts` (runs 562-567).
   Any further file that fails a run counted in criterion 2 joins this set and must satisfy this
   criterion before criterion 2 can pass.
2. Three consecutive `bun test --parallel=8 --timeout=60000` runs of the whole suite in
   `.devboard` each print `0 fail` and exactly `1 skip`, the pre-existing
   `Flow Mode contract > a Flow goal interview has no wall-clock bound`. A run that fails does not
   count and resets the sequence.
3. Every repaired test still exists under exactly its recorded name: a `grep -c 'test("'` for that
   name prints `1` in its file, the file contains no `test.only`, `test.skip`, or `test.todo` added
   by this work, and `bun test <file> -t '<name>'` prints `1 pass`.
4. The release gate is not weakened: `git diff origin/main...HEAD -- .gitea/workflows/devboard-release.yml
   .devboard/package.json` adds no second `bun test` invocation, no `continue-on-error`, no
   `--filter` or exclusion flag, no retry wrapper, and no forked or conditional test script. The
   workflow still runs checkout, install, build, suite, typecheck, client check, and release as
   single-shot blocking steps in that order.
5. `bun run build`, `bunx tsc --noEmit`, and `bun run check` in the worktree each exit `0`.
6. The fix commit is merged to `main` and pushed: `git ls-remote origin refs/heads/main` names the
   fix commit or a descendant, and `git status --short --branch` in the worktree reports no
   commits ahead of the upstream.
7. The Release Train publishes a version that carries the fix: a `devboard-release.yml` run whose
   `head_sha` equals or descends from the fix commit concluded `success`, and that run's job log
   prints no `(fail)` line for any file in the criterion-1 set.
8. The published release is independently verifiable: `git tag --contains <fix-sha> --list 'v*'`
   lists `v<version>`; the Gitea release for `v<version>` lists `devboard-<version>.tgz` and
   `devboard-<version>.tgz.sha256`; `npm view @dsdenes/devboard@<version> version` prints
   `<version>`.
9. The Release Train records the release: its state names `<version>` as the published release and
   its `failure` is `null` or dated before that release.

## Verification

Set the paths once; every command runs from the path it names.

```bash
REPO_ROOT=/home/ds/devboard
WT="$REPO_ROOT/.worktree/<task>"
cd "$WT/.devboard" && bun install --frozen-lockfile
```

Criterion 1, ten consecutive per-file runs (repeat the block per file; each must end `0 fail`):

```bash
cd "$WT/.devboard"
for i in $(seq 1 10); do
  bun test server/flow.test.ts --timeout=60000 || break
done
for i in $(seq 1 10); do bun test server/discover.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test server/static-snapshot-process.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test server/ask.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test tests/issues.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test tests/supervision-reaper.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test server/skills-preparation.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test client/lib/components/DiscoverWorkspace.test.ts --timeout=60000 || break; done
for i in $(seq 1 10); do bun test client/lib/components/NotificationRegion.test.ts --timeout=60000 || break; done
```

Criterion 2, three consecutive full-suite runs; each must print `0 fail` and `1 skip`:

```bash
cd "$WT/.devboard"
for i in 1 2 3; do bun test --parallel=8 --timeout=60000; done
```

Criteria 3 and 4:

```bash
cd "$WT"
grep -c 'test("the Flow implementation gets one peer in its own worktree and branch from origin/main"' \
  .devboard/server/flow.test.ts
grep -c 'test("cancels an active run on reset"' .devboard/server/discover.test.ts
grep -nE 'test\.(only|skip|todo)\(' .devboard/server/flow.test.ts .devboard/server/discover.test.ts
git diff origin/main...HEAD -- .gitea/workflows/devboard-release.yml .devboard/package.json
```

The two `grep -c` commands print `1`; the `test.only`/`test.skip` grep prints nothing new; the
diff contains no retry, `continue-on-error`, filter, exclusion, or second suite invocation.

Criterion 5:

```bash
cd "$WT/.devboard"
bun run build
bunx tsc --noEmit
bun run check
```

Each exits `0`.

Criterion 6:

```bash
cd "$WT"
git status --short --branch
git ls-remote origin refs/heads/main
```

After merge and push, the status line reports no commits ahead, and the remote line names the
integrated commit.

Criteria 7 to 9, after the Release Train tick:

```bash
cd "$REPO_ROOT"
git fetch --prune origin && git fetch --tags origin
git tag --contains <fix-sha> --list 'v*'
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/runs?limit=30"
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/tags/v<version>"
npm view @dsdenes/devboard@<version> version
python3 -c 'import json;d=json.load(open(".devboard/.tmp/release-train/state.json"));
print(d["release"]["version"], d.get("failure"))'
```

The run list shows a `success` run at or after the fix commit; the release document's `assets[].name`
contains both tarball names; `npm view` prints the version; the state prints that version with a
`failure` that is null or older.

## Boundaries

- In scope: test files under `.devboard/client`, `.devboard/server`, and `.devboard/tests`, their
  helpers and fixtures under `.devboard/server/fixtures`, `.devboard/lib`, and the production
  modules under `.devboard/client` and `.devboard/server` whose race a failing test exposes —
  changed only as far as removing that race.
- Out of scope and untouched: `.devboard/scripts/publish.ts`, `.devboard/scripts/release.ts`,
  `.devboard/release-train/`, `.devboard/lib/release-train-gate.ts`,
  `.gitea/workflows/devboard-release.yml`, the `.devboard/package.json` version and test script,
  `bun.lock`, `adrs/`, `GOAL.md`, git tags, and published history.
- Do not weaken a test to make it pass: no deletion, rename, skip, filter, conditional run,
  retry, or expected-value change without a matching behavioral fix. Where an assertion is
  stricter than the product guarantees, either make the product guarantee it or narrow the
  assertion to the behavior the test's name states; never remove the named behavior.
- Work only in `<repo root>/.worktree/<name>`; never edit the opened checkout, another worktree,
  or another goal's branch. If a related repair lands on `origin/main` first (for example
  `devboard/goal-1207-*` or `devboard/goal-1228-*`), verify it against the criteria rather than
  duplicating or reverting it.
- Create no file outside the repository root; no new dependency; never force-push, rewrite
  published history, or push with `--no-verify`.
- Never run `bun run publish` by hand and never dispatch `.gitea/workflows/devboard-release.yml`
  by hand; the Release Train is the only releaser. Never kill, spawn, or relaunch a dashboard
  server by hand.
- The workflow command stays as built (`--parallel=8 --timeout=60000`, single-shot); host load is
  a condition the suite must survive, not an excuse to serialize, filter, or retry it.

## Stop conditions

- No attempt cap, no token budget, and no time limit: continue until every criterion is verified.
- Halt and report when a failing test's named behavior is genuinely ambiguous, when two tests
  demand incompatible behavior, or when making a test pass would require deleting, skipping,
  narrowing below its stated behavior, or retrying it.
- Halt before an irreversible or risky operation not authorized here: deleting or moving a tag,
  rewriting history, force-pushing, or publishing by hand.
- Halt and report a missing prerequisite or blocked external dependency: an unusable npm or Gitea
  credential, an unreachable forge or registry, a failing non-test workflow step, or a live
  Release Train run that never concludes (name its run id and step). Complete every reachable
  repair first.
- A local commit, a local merge, a deleted worktree branch, or a scaffold never substitutes for a
  success criterion.

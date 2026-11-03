## Objective

The release workflow stops failing at its test step. The harness test suite under `.devboard`
passes deterministically under the load the workflow runner applies, a fix commit reaches `main`,
and `v1.27.1` is published and independently verified: tag, npm package, and Gitea assets. Every
later release whose commit contains the fix is verified the same way. The affected surface is the
harness test suite, the production code whose races the flaky tests expose, the
`devboard-release.yml` workflow that runs the suite, and the Release Train release path.

## Success criteria

1. Three consecutive `bun test` runs of the whole suite in `.devboard` each end with `0 fail` and
   exactly `1 skip`, the pre-existing `Flow Mode contract > a Flow goal interview has no
   wall-clock bound`.
2. Each test file that failed in release workflow runs 555, 557, 558, 560, and 561 passes ten
   consecutive runs of that file with `0 fail`:
   - `client/lib/components/NotificationRegion.test.ts` (run 561),
   - `server/discover-remote.test.ts` (run 560),
   - `server/discover.test.ts` (run 558),
   - `tests/issues.test.ts` (run 557),
   - `server/persistence.test.ts` (run 555).
3. Every test that failed in those runs still exists under the same name, is neither skipped,
   deleted, nor renamed, and still asserts the behavior it asserted before.
4. The release path is not weakened: `.gitea/workflows/devboard-release.yml` still runs
   `bun test`, `bunx tsc --noEmit`, `bun run check`, and `bun run release` as single-shot blocking
   steps; the file and the `.devboard` `test` script add no second attempt, no
   `continue-on-error`, no filter or exclusion flag, and no retry wrapper.
5. The five fixed files no longer fail when the full suite runs concurrently with the workflow's
   other steps; the workflow step is not made serial or filtered to achieve this.
6. The fix commit is carried by a verified release: either a `devboard-release.yml` run whose
   `head_sha` is the fix commit or a descendant concluded `success`, or `git tag --contains
   <fix-sha> --list 'v*'` lists a tag whose release has the npm version and both Gitea assets.
7. `v1.27.1` is verified released: a `v1.27.1` tag exists on `origin` and the Gitea release for it
   lists `devboard-1.27.1.tgz` and `devboard-1.27.1.tgz.sha256`; `npm view
   @dsdenes/devboard@1.27.1 version` prints `1.27.1`.
8. The Release Train records the release: its state names `1.27.1` as the published release and
   carries no failure dated after that release for the range it released.

## Verification

Set the task worktree and repository root once; every command below runs from those paths.

```bash
REPO_ROOT=<repository root>
WT="$REPO_ROOT/.worktree/<task>"
```

Full-suite stability, run three times, each must print `0 fail` and `1 skip`:

```bash
cd "$WT/.devboard"
bun install --frozen-lockfile
bun test
```

Targeted stability, run the command for each file ten times, each must print `0 fail`:

```bash
cd "$WT/.devboard"
bun test client/lib/components/NotificationRegion.test.ts
bun test server/discover-remote.test.ts
bun test server/discover.test.ts
bun test tests/issues.test.ts
bun test server/persistence.test.ts
```

Test preservation and the unweakened gate:

```bash
cd "$WT"
git diff origin/main...HEAD -- .gitea/workflows/devboard-release.yml .devboard/package.json
```

The diff adds no second test invocation, no `continue-on-error`, no filter or exclusion flag, and
no retry wrapper. For each of the five test names above, `grep -c` in its file still finds the
test, and the `bun test` output prints `1 skip` only.

Pre-push repository checks:

```bash
cd "$WT/.devboard"
bun run build
bunx tsc --noEmit
bun run check
bun run verify:install
bun run verify:update
bun run verify:ui
```

Each command exits 0.

Published release. After the fix commit is pushed to `origin/main` and the Release Train has
ticked:

```bash
cd "$REPO_ROOT"
git fetch --prune origin
git fetch --tags origin
git log --oneline origin/main -1
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/runs?limit=30"
```

The last output lists a run whose `head_sha` is an ancestor of `origin/main` and equals or
descends from the fix commit, with `conclusion` `success`.

```bash
cd "$REPO_ROOT"
git tag --contains <fix-sha> --list 'v*'
git rev-list -n1 v1.27.1
npm view @dsdenes/devboard@1.27.1 version
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/tags/v1.27.1"
```

`git tag --contains` lists `v1.27.1` or a later release tag whose release carries the fix; `git
rev-list -n1 v1.27.1` prints `v1.27.1`'s commit; `npm view` prints `1.27.1`; the release document's
`assets[].name` contains `devboard-1.27.1.tgz` and `devboard-1.27.1.tgz.sha256`.

Release Train state:

```bash
cd "$REPO_ROOT"
python3 -c 'import json;d=json.load(open(".devboard/.tmp/release-train/state.json"));
print(d["release"]["version"], d["release"]["sha"], d.get("failure"))'
```

`release.version` is `1.27.1` and `failure` is null or dated before that release. When the
dashboard uses another `STATE_DIR`, read the same fields from the live Release Train snapshot
instead.

## Boundaries

- In scope: test files and test helpers under `.devboard/client`, `.devboard/server`,
  `.devboard/tests`, and `.devboard/lib`; and the production modules under `.devboard/client` and
  `.devboard/server` whose race a failing test exposes, changed only as far as removing that race.
- The release path stays as built: `.gitea/workflows/devboard-release.yml` keeps its install,
  build, test, typecheck, client-check, and release steps single-shot and blocking. No retry,
  `continue-on-error`, filter, exclusion, serialization of the suite for CI only, or timeout
  increase without removing the underlying wait.
- Do not touch `.devboard/scripts/publish.ts` verification gates, `.devboard/scripts/release.ts`,
  `.devboard/release-train/`, `.devboard/lib/release-train-gate.ts`, git tags, the `package.json`
  version, the lockfile, `adrs/`, or `GOAL.md`; add no dependency.
- Do not delete, rename, skip, or weaken a failing test to make the suite green, and do not change
  an assertion's expected value without fixing the behavior it observes.
- Work only in `<repository root>/.worktree/<name>`; never edit the opened checkout, and create no
  file outside the repository root.
- Never push with `--no-verify`, never force-push, and never rewrite published history.
- Never run `bun run publish` and never dispatch `.gitea/workflows/devboard-release.yml` by hand;
  the Release Train is the only releaser. Never kill, spawn, or relaunch a dashboard server.

## Stop conditions

- Stop and report when a flaky test's intended behavior is genuinely ambiguous, or when making it
  pass would require deleting, skipping, narrowing, or retrying it, or raising its timeout while
  leaving the wait that times out in place.
- Stop and report when a flake cannot be reproduced or its cause cannot be found after the full
  suite and the targeted file have each been run repeatedly under load.
- Stop and report when publication is blocked by a missing forge or npm credential, an unreachable
  Gitea or npm, a failing non-test workflow step, or a live Release Train run that never
  concludes; name the run id and step. Complete every reachable flake repair first.
- Stop before any irreversible operation not authorized here, such as deleting or moving a tag,
  rewriting history, or publishing by hand.
- There is no attempt cap, no token budget, and no time limit. A narrower fix, a scaffold, a mock,
  a skipped test, or a local-only commit never substitutes for a success criterion.

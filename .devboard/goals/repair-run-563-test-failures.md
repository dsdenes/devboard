## Objective

`devboard-release.yml` stops failing at its `Run the harness suite` step on the two tests that
workflow run 563 for `f8e3e66` exposed: `client/lib/components/DiscoverWorkspace.test.ts`'s
"the running Overview run stops through the quiet destructive control" and
`client/lib/components/NotificationRegion.test.ts`'s "a second activation while filing sends no
second request". Both tests pass deterministically, including inside a full-suite run under
workflow-like load; the repair reaches `origin/main`; and the Release Train publishes a version
whose release-workflow run concluded `success` and whose npm package and Gitea release assets are
verified. The affected surface is those two test files, the component and store code they observe
where a product-visible race is proven, the harness test suite, and the release path that gates on
it.

## Success criteria

1. Both tests still exist under exactly their current names, are neither skipped, deleted, nor
   renamed, contain no `test.only` or filter, and each still asserts the behavior it asserted
   before this work: the Overview stop control is present with class `discover-run__stop` and
   `data-variant="bare"`; and after the first filing resolves, no second request was sent, the
   first notification shows an `Open issue` link to the filed URL, and the remaining
   `.notification__file` control is enabled.
2. Ten consecutive runs of `bun test client/lib/components/NotificationRegion.test.ts` each print
   `0 fail`, and the full-suite output of this checkout reports exactly `1 skip`, the pre-existing
   `Flow Mode contract > a Flow goal interview has no wall-clock bound`.
3. Ten consecutive runs of `bun test client/lib/components/DiscoverWorkspace.test.ts` each print
   `0 fail`, and the DiscoverWorkspace test also passes inside the full suite, where it failed in
   run 563.
4. Three consecutive full-suite runs print `(pass)` for both named tests, and no failure line in
   any of them names either of the two files.
5. `bun run build`, `bunx tsc --noEmit`, and `bun run check` each exit 0 in the worktree.
6. The fix commit is contained in `origin/main`, and `git status --short --branch` in the worktree
   reports no commits ahead of the upstream.
7. The Release Train publishes a version whose tag and release commit contain the fix commit; that
   version's `devboard-release.yml` run concluded `success`, and the job log for that run prints
   `(pass)` for both named tests.
8. The published version is independently verifiable: `npm view @dsdenes/devboard@<version>
   version` prints `<version>`, and the Gitea release for `v<version>` lists
   `devboard-<version>.tgz` and `devboard-<version>.tgz.sha256`.
9. The Release Train's state names `<version>` as the published release, and its `failure` is null
   or older than that release.

## Verification

Set the worktree once; every command below runs from the path it names.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WT="$REPO_ROOT/.worktree/<task>"
git worktree add "$WT" -b devboard/<task> origin/main
cd "$WT/.devboard" && bun install --frozen-lockfile
```

Criterion 1 — the tests are intact and unweakened:

```bash
cd "$WT/.devboard"
grep -c 'test("the running Overview run stops through the quiet destructive control"' \
  client/lib/components/DiscoverWorkspace.test.ts
grep -c 'test("a second activation while filing sends no second request"' \
  client/lib/components/NotificationRegion.test.ts
grep -cE 'test\.(only|skip|todo)\(' client/lib/components/DiscoverWorkspace.test.ts \
  client/lib/components/NotificationRegion.test.ts
bun test 2>&1 | grep -E '^\s*[0-9]+ skip$'
```

The two `grep -c` commands print `1`, the `test.only`/`test.skip` grep prints nothing, and the
skip line prints `1 skip`.

Criteria 2 and 3 — ten consecutive runs per file, each must end `0 fail`:

```bash
cd "$WT/.devboard"
for i in $(seq 1 10); do
  bun test client/lib/components/NotificationRegion.test.ts || break
done
for i in $(seq 1 10); do
  bun test client/lib/components/DiscoverWorkspace.test.ts || break
done
```

Criterion 4 — three full-suite runs, each printing both named tests as passing:

```bash
cd "$WT/.devboard"
for i in 1 2 3; do
  bun test 2>&1 | grep -E \
    '^\((pass|fail)\) (the running Overview run stops through the quiet destructive control|a second activation while filing sends no second request)'
done
```

Each run prints two `(pass)` lines and no `(fail)` line naming either test. A failure naming any
other file is outside this goal; see Stop conditions.

Criterion 5 — repository checks:

```bash
cd "$WT/.devboard"
bun run build
bunx tsc --noEmit
bun run check
```

Each exits 0.

Criterion 6 — pushed fix:

```bash
cd "$REPO_ROOT"
git fetch origin
git merge-base --is-ancestor <fix-sha> origin/main && echo contained
git ls-remote origin refs/heads/main
git -C "$WT" status --short --branch
```

The first prints `contained`; `ls-remote` names the commit that contains `<fix-sha>`; the worktree
status reports `## devboard/<task>...origin/main` with no `[ahead` marker.

Criteria 7, 8, and 9 — the published release. After the Release Train ticks:

```bash
cd "$REPO_ROOT"
git fetch --tags origin
git tag --contains <fix-sha> --list 'v*'
git rev-list -n1 "v<version>"
npm view "@dsdenes/devboard@<version>" version
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/tags/v<version>" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["tag_name"], [a["name"] for a in d["assets"]])'
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/runs?limit=30" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); [print(r["id"], r["head_sha"], r["conclusion"]) for r in d["workflow_runs"]]'
```

`git tag --contains` lists `v<version>`; `git rev-list -n1` prints the release commit; `npm view`
prints `<version>`; the release document lists `devboard-<version>.tgz` and
`devboard-<version>.tgz.sha256`; the run list contains the run whose `head_sha` is the release
commit with `conclusion` `success`.

That run's job log must show both tests passing under the runner:

```bash
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/runs/<run>/jobs" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["jobs"][0]["id"])'
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/jobs/<job>/logs" |
  grep -E '^\(pass\) (the running Overview run stops through the quiet destructive control|a second activation while filing sends no second request)'
```

Two `(pass)` lines print.

Release Train state:

```bash
cd "$REPO_ROOT"
python3 -c 'import json; d=json.load(open(".devboard/.tmp/release-train/state.json"));
print(d["release"]["version"], d["release"]["sha"], d.get("failure"))'
```

`release.version` is `<version>`, `release.sha` is the release commit or an ancestor of it, and
`failure` is null or dated before that release. When the dashboard's `STATE_DIR` differs, read the
same fields from the live Release Train snapshot instead.

## Boundaries

- In scope: `.devboard/client/lib/components/DiscoverWorkspace.test.ts`,
  `.devboard/client/lib/components/NotificationRegion.test.ts`, and the test-local helpers they
  use. `client/lib/components/DiscoverWorkspace.svelte`, `client/lib/components/NotificationRegion.svelte`,
  `client/lib/components/CommandButton.svelte`, `client/lib/command-busy.svelte.ts`, and
  `client/lib/discover.svelte.ts` are in scope only when a product-visible failure is demonstrated
  and the change removes exactly that failure.
- Out of scope: the five other flaky files owned by issue #1207 — `server/discover-remote.test.ts`,
  `server/discover.test.ts`, `tests/issues.test.ts`, `server/persistence.test.ts`, and any other
  file whose failure a full-suite run reports. Do not edit `#1207`'s worktree or conflict with it.
- The release path stays as built: `.gitea/workflows/devboard-release.yml` keeps its install,
  test, typecheck, client-check, and release steps single-shot and blocking; no retry, second
  invocation, `continue-on-error`, filter, exclusion flag, `test.only`, CI-only serialization, or
  timeout increase without removing the wait that times out. The `test` script in
  `.devboard/package.json` stays `bun test`.
- Do not touch `.devboard/scripts/publish.ts`, `.devboard/scripts/release.ts`,
  `.devboard/release-train/`, `.devboard/lib/release-train-gate.ts`, existing git tags, the
  `package.json` version, the lockfile, `adrs/`, or `GOAL.md`; add no dependency.
- Never delete, rename, skip, or narrow a failing test, and never change an assertion's expected
  value to match the behavior it observes.
- Work only in `<repository root>/.worktree/<name>`; never edit the opened checkout, and create no
  file outside the repository root, including temporary files.
- Never push with `--no-verify`, never force-push, and never rewrite published history. Never run
  `bun run publish` and never dispatch `.gitea/workflows/devboard-release.yml` by hand; the
  Release Train is the only releaser. Never kill, spawn, or relaunch a dashboard server.

## Stop conditions

- Stop and report when either test's intended behavior is genuinely ambiguous, or when making it
  pass would require deleting, skipping, narrowing, or retrying it, or raising a timeout while the
  wait that times out stays in place.
- Stop and report when the DiscoverWorkspace failure cannot be reproduced under load and no
  candidate change can be shown, by experiment or by reading Svelte's flush path, to remove the
  missed update; report the runs and the log evidence gathered.
- Stop and report when a full-suite run or the release workflow fails on a file outside this goal's
  two files; name the file, the run id, and the failing step, and complete every reachable repair
  on this goal's two files first.
- Stop and report when publication is blocked by a missing forge or npm credential, an unreachable
  Gitea or npm, a failing non-test workflow step, or a live Release Train run that never
  concludes; name the run id and step.
- Stop before any irreversible operation not authorized here, such as deleting or moving a tag,
  rewriting history, or publishing by hand.
- There is no attempt cap, no token budget, and no time limit. A narrower fix, a scaffold, a mock,
  a skipped test, or a local-only commit never substitutes for a success criterion.

## Objective

A flaky harness test stops blocking the release. When the release workflow's suite step under
`.devboard` fails, that step retries the whole suite, skips for the rest of that workflow run every
test that failed on three consecutive attempts, files one issue per skipped test in the checkout's
origin forge, and exits 0 so the workflow's later typecheck, client check, and publish steps still
run and the version still ships. Nothing is committed, pushed, or left in a tracked file: the
checkout, `main`, the packed npm tarball, and the git-tracked working tree are unchanged when the
step ends, so the quarantine lasts only for that run and the filed issue is the durable record. A
structural failure of the suite — a compile or import error, a crashed runner, an unparseable
result — still fails the step and the workflow, so the release is unblocked by flaky tests, not by
a suite that cannot run.

The affected surface is `.gitea/workflows/devboard-release.yml`, the harness scripts and package
script that step invokes, the harness suite's CI fixtures, and the release documentation in
`.devboard/README.md` and `.devboard/AGENTS.md`.

## Success criteria

1. With a fixture suite whose test always fails, the workflow's suite step exits `0`, prints one
   line per attempt, prints a line naming each skipped test with its file path and exact test name,
   prints `0 fail` for its last attempt, and the workflow's later typecheck, client-check, and
   publish steps still run.
2. A test that fails on three consecutive suite attempts is marked skipped in the step's own
   working copy before the next attempt; a test that fails fewer than three consecutive attempts
   and then passes is never marked skipped, and no issue is filed for it.
3. A test marked skipped keeps its exact name and body; only its registration changes to
   `test.skip(`. No test is deleted, renamed, narrowed, or given a different expected value.
4. After the step ends, `git status --porcelain --untracked-files=no` in the checkout is empty and
   `git diff --exit-code` reports no change, for a passing run, a quarantining run, and a failing
   run alike. The step performs no `git add`, `git commit`, `git push`, or tag write, and the
   checkout's `origin/main` ref is unchanged after the step.
5. The suite the step runs is still the whole harness suite under the workflow's current load
   settings (`--parallel=8 --timeout=60000`). The step adds no `continue-on-error`, no
   `--path-ignore-patterns`, no `--only`, no `-t`/`--test-name-pattern`, no `--retry`, no filter,
   no shard, and no second suite invocation.
6. The step attempts the whole suite at most nine times. It stops at the first attempt that reports
   `0 fail` (exit `0`) and exits nonzero after the ninth attempt still reports failures.
7. A suite failure that is not an individual test result — an import or compile error, a vanished
   test file, a runner crash, output that yields no per-test result — exits nonzero, files no
   issue, and fails the workflow.
8. One forge issue is filed per skipped test in the origin repository (`dsdenes/devboard`), with a
   one-line title of at most 200 characters that contains the exact test name, and a body that
   names the test file path, the test name, the output of each failed attempt for that test, the
   released commit SHA, and the workflow run URL when the runner exposes one.
9. Filing is deduplicated: when an open issue already exists whose title names the test, a second
   quarantining run creates no issue and appends exactly one comment to that issue naming the new
   run and its attempt output.
10. Filing is best effort and never blocks the release: with the forge unreachable or the token
    refused, the step still exits `0`, prints a line naming the filing failure and its first
    concrete line, and the release step still runs.
11. `.devboard/package.json` exposes the step's entry point as `bun run test:release`. The workflow
    step invokes it with no arguments; when extra arguments are passed after `--`, they are
    appended to every attempt and change nothing else.
12. The workflow's other steps keep their names, order, commands, and environment except for the
    forge URL and token variables the suite step needs; the release step's env block is unchanged.
13. `.devboard/README.md` and `.devboard/AGENTS.md` both state the policy: the suite is retried, a
    test failing three consecutive attempts is skipped for that run and reported as an issue, the
    tree and the release are untouched, and the earlier rule that forbade any retry, skip, filter,
    or second attempt no longer applies to the release suite step.
14. The repository's own checks pass from the worktree: `bun run build`, `bun test`,
    `bunx tsc --noEmit`, `bun run check`, `bun run verify:install`, `bun run verify:update`, and
    `bun run verify:ui` each exit `0`, and the new quarantine behavior's own tests pass.
15. The change is merged to `main`, pushed, and released: `git ls-remote origin refs/heads/main`
    names the change commit or a descendant, the Release Train publishes a version whose
    `devboard-release.yml` run concluded `success`, `npm view @dsdenes/devboard@<version> version`
    prints that version, and the Gitea release lists `devboard-<version>.tgz` and
    `devboard-<version>.tgz.sha256`.

## Verification

Every command runs from the path it names. Set the roots once:

```bash
REPO_ROOT=$(git -C /home/ds/devboard rev-parse --show-toplevel)
WT="$REPO_ROOT/.worktree/<task>"
cd "$WT/.devboard" && bun install --frozen-lockfile
```

Criterion 11 and 12: the step's command and the untouched steps.

```bash
awk '/name: Run the harness suite/{f=1} f&&/run:/{print;exit}' \
  "$WT/.gitea/workflows/devboard-release.yml"
git -C "$WT" diff origin/main...HEAD -- .gitea/workflows/devboard-release.yml
```

The first command prints `run: bun run test:release`; the diff shows no `continue-on-error`, no
exclusion or filter flag, no second suite invocation, and no change to the build, typecheck,
client-check, or publish steps other than the two forge variables on the suite step.

Criteria 1 to 4 and 8 to 10, fixture runs against a stub forge. Start the stub the harness
fixtures provide, then write the three fixture tests:

```bash
mkdir -p "$WT/.tmp/quarantine-stub"
PORT=4599 QUARANTINE_STUB_FORGE_STATE="$WT/.tmp/quarantine-stub/state.json" \
  bun "$WT/.devboard/tests/fixtures/quarantine-stub-forge.ts" &
STUB=$!
cat > "$WT/.devboard/tests/zz-quarantine-always.test.ts" <<'EOF'
import { expect, test } from "bun:test";
test("always fails: quarantine fixture", () => {
  expect(1).toBe(2);
});
test("always passes: quarantine fixture", () => {
  expect(1).toBe(1);
});
EOF
cat > "$WT/.devboard/tests/zz-quarantine-flake.test.ts" <<'EOF'
import { existsSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("fails once then passes: quarantine fixture", () => {
  const marker = `${import.meta.dir}/../.tmp/quarantine-stub/flake-marker`;
  const first = !existsSync(marker);
  writeFileSync(marker, "1");
  expect(first).toBe(false);
});
EOF
printf 'import "./zz-missing-module.ts";\n' \
  > "$WT/.devboard/tests/zz-quarantine-broken.test.ts"
```

Persistent failure: three attempts, skip, release continues, one issue; then the same run again
adds a comment and no issue.

```bash
cd "$WT/.devboard"
DEVBOARD_GITEA_URL=http://127.0.0.1:4599 DEVBOARD_GITEA_TOKEN=fixture \
  bun run test:release -- tests/zz-quarantine-always.test.ts; echo "exit=$?"
curl -s http://127.0.0.1:4599/admin/state
DEVBOARD_GITEA_URL=http://127.0.0.1:4599 DEVBOARD_GITEA_TOKEN=fixture \
  bun run test:release -- tests/zz-quarantine-always.test.ts; echo "exit=$?"
curl -s http://127.0.0.1:4599/admin/state
```

The first run prints `attempt` and `quarantined:` lines, ends `0 fail`, and exits `0`; the state
shows one issue whose title names `always fails: quarantine fixture` and whose body names the file
path, that test name, the attempt output, and the commit SHA. The second run exits `0` and the
state still shows one issue, now with one comment naming the new attempt output. After each run:

```bash
git -C "$WT" status --porcelain --untracked-files=no
git -C "$WT" diff --exit-code
```

Both print nothing. The always-passing test in the same file is not named by any `quarantined:`
line and no issue title names it.

Intermittent failure: no skip, no issue.

```bash
rm -f "$WT/.devboard/.tmp/quarantine-stub/flake-marker"
cd "$WT/.devboard"
DEVBOARD_GITEA_URL=http://127.0.0.1:4599 DEVBOARD_GITEA_TOKEN=fixture \
  bun run test:release -- tests/zz-quarantine-flake.test.ts; echo "exit=$?"
curl -s http://127.0.0.1:4599/admin/state
```

The command exits `0`, prints no `quarantined:` line, and the state's issue count is unchanged from
the previous read.

Structural failure: nonzero exit, no issue.

```bash
cd "$WT/.devboard"
DEVBOARD_GITEA_URL=http://127.0.0.1:4599 DEVBOARD_GITEA_TOKEN=fixture \
  bun run test:release -- tests/zz-quarantine-broken.test.ts; echo "exit=$?"
curl -s http://127.0.0.1:4599/admin/state
```

The command exits nonzero, prints the module-resolution failure, and the state's issue count is
unchanged.

Forge unreachable: exit `0` and a named filing failure.

```bash
cd "$WT/.devboard"
DEVBOARD_GITEA_URL=http://127.0.0.1:1 DEVBOARD_GITEA_TOKEN=fixture \
  bun run test:release -- tests/zz-quarantine-always.test.ts; echo "exit=$?"
kill $STUB
```

The command exits `0`, prints a line naming the create-issue failure, and prints the same
`quarantined:` line.

Then remove the fixtures and check the worktree again:

```bash
rm -f "$WT/.devboard/tests/zz-quarantine-always.test.ts" \
  "$WT/.devboard/tests/zz-quarantine-flake.test.ts" \
  "$WT/.devboard/tests/zz-quarantine-broken.test.ts"
rm -rf "$WT/.tmp/quarantine-stub"
git -C "$WT" status --short --branch
```

Criterion 3 and the new behavior's tests:

```bash
cd "$WT/.devboard"
bunx tsc --noEmit
```

`bun test` in the next block runs the quarantine tests; every new test that covers the retry count,
the three-attempt rule, the restore of the working copy, the issue body, the dedupe, and the
best-effort filing passes.

Criterion 13:

```bash
grep -n "quarantin" "$WT/.devboard/README.md" "$WT/.devboard/AGENTS.md"
```

Each file prints at least one line, and the lines state the retry, the three-attempt skip, the
issue, the untouched tree, and the superseding of the earlier no-retry rule.

Criterion 14:

```bash
cd "$WT/.devboard"
bun run build
bun test
bunx tsc --noEmit
bun run check
bun run verify:install
bun run verify:update
bun run verify:ui
```

Each command exits `0`.

Criterion 15, after the change is merged into `main` and pushed:

```bash
cd "$REPO_ROOT"
git fetch --prune origin && git fetch --tags origin
git ls-remote origin refs/heads/main
git tag --contains <change-sha> --list 'v*'
npm view @dsdenes/devboard@<version> version
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/tags/v<version>"
curl -sS -H "Authorization: token $GITEA_TOKEN" \
  "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/actions/runs?limit=30"
python3 -c 'import json;d=json.load(open(".devboard/.tmp/release-train/state.json"));
print(d["release"]["version"], d.get("failure"))'
```

The remote line names the change commit or a descendant; the tag list names `v<version>`; `npm
view` prints `<version>`; the release document's `assets[].name` contains
`devboard-<version>.tgz` and `devboard-<version>.tgz.sha256`; the run list shows a `success` run
whose `head_sha` equals or descends from the change commit; the state prints that version with a
`failure` that is `null` or older than that release.

## Boundaries

- In scope: `.gitea/workflows/devboard-release.yml` (the suite step only), the `.devboard`
  package script `test:release`, new modules under `.devboard/scripts/` and `.devboard/lib/` that
  the entry point needs, new tests under `.devboard/tests/` with a stub forge fixture beside the
  existing ones under `.devboard/tests/fixtures/`, and the release sections of
  `.devboard/README.md` and `.devboard/AGENTS.md`.
- Untouched: the release step and its env block, `.devboard/scripts/publish.ts`,
  `.devboard/scripts/release.ts`, `.devboard/release-train/`, `.devboard/lib/release-train-gate.ts`,
  `.devboard/package.json`'s version and existing scripts, `bun.lock`, existing test bodies,
  `.devboard/goals/`, `adrs/`, `GOAL.md`, `.omp/`, the installed package tree, git tags, and
  published history. Add no dependency.
- Never weaken the gate to reach the outcome: no `continue-on-error`, no `--path-ignore-patterns`,
  no `--only`, no `-t`, no `--retry`, no filter, shard, or second suite definition, no permanent
  `test.skip` in a tracked test, and no deletion, rename, or assertion change in any test.
- The suite step never writes to git: no `git add`, `git commit`, `git push`, `git tag`, force-push,
  or `--no-verify`. It never runs `bun run publish`, never dispatches the release workflow by hand,
  and never restarts a dashboard. The Release Train remains the only releaser.
- Work only in `<repo root>/.worktree/<name>`; never edit the opened checkout. Temporary state for
  the stub forge and fixture runs lives under the worktree's `.devboard/.tmp/`; create no file
  outside the repository root, and no file outside the worktree while the work runs.
- The stub forge receives every verification write; no verification run files into the real
  `dsdenes/devboard` tracker.

## Stop conditions

- Halt and report when the classification is genuinely ambiguous — for example when a test's
  failure cannot be attributed to a per-test result, so skipping it would hide a structural
  failure, or when one test's skip makes another test fail for a reason the criteria cannot decide.
- Halt and report a missing prerequisite: `bun` unavailable in the worktree, no stub forge the
  harness fixtures can start, or a release blocker that is not this change — an unusable Gitea or
  npm credential, an unreachable forge or registry, a failing non-test workflow step, or a Release
  Train run that never concludes, named by run id and step. Complete every reachable part first.
- Halt before an irreversible or unauthorized operation: deleting or moving a tag, rewriting
  history, force-pushing, publishing by hand, or filing into the real tracker.
- There is no attempt cap, no token budget, and no time limit. A narrower feature, a scaffold, a
  mock, a dry run, a permanently skipped test, or a local-only commit never substitutes for a
  success criterion.

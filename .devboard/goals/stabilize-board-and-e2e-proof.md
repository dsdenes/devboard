## Objective

The Devboard harness in this repository (`.devboard/`) becomes stable and provably working. Every
issue open on the project's Gitea board at `DEVBOARD_GITEA_URL` is processed to zero — each of the
eight observable failure classes those 44 issues represent is traced to its root cause, fixed on
`main`, covered by an automated regression test, and every one of the 44 issues is closed with a
comment naming the fix commit and the duplicate or class it belongs to. Alongside the fixes, a new
runnable browser suite under `.devboard/e2e/` drives the real dashboard — the real Rust binary
serving the real built client bundle, the real worker processes, and the live local Gitea — through
the controls an operator uses: starting and stopping every background agent family and the Issues
worker, and filing one issue as a user through the report overlay. The suite is a one-time proof and
an operator tool, not a CI gate: it proves the running system over repeated start/stop cycles with no
orphaned process, no lost dashboard, and no new auto-filed error notification.

## Success criteria

1. Every issue that was open at the start of this work is closed on the Gitea board. The start set
   is exactly these 44 numbers: 1398, 1397, 1396, 1395, 1394, 1393, 1392, 1391, 1390, 1389, 1388,
   1387, 1386, 1385, 1384, 1383, 1382, 1381, 1380, 1379, 1378, 1375, 1374, 1372, 1371, 1369, 1368,
   1367, 1365, 1364, 1363, 1362, 1361, 1360, 1359, 1358, 1357, 1356, 1355, 1352, 1351, 1350, 1348,
   1347. At completion, the open-issue query for `dsdenes/devboard` returns an empty array.
2. The 44 issues are accounted for by exactly these failure classes, and each class is either fixed
   or shown by a documented reproduction to share another class's root cause:

   | Class | Filed symptom | Issues |
   |---|---|---|
   | C1 | `the forge read did not finish within 30000 ms` | 1397, 1396, 1395, 1393, 1387, 1386, 1381, 1378, 1369, 1368, 1367, 1365, 1352, 1351 |
   | C2 | `the request timed out` | 1392, 1391, 1390, 1379, 1360, 1359, 1358, 1357, 1356, 1355 |
   | C3 | `the start preflight did not finish within 20000 ms` | 1389, 1388, 1382, 1380, 1372, 1371, 1364, 1363, 1362, 1361 |
   | C4 | a worker `did not publish its state within 5 seconds` | 1394, 1385, 1384, 1350 |
   | C5 | `GET /repos/…/issues?state=all…` failed | 1383, 1375 |
   | C6 | `the dead-code entry point …/single-responsibility.md is excluded` | 1348, 1347 |
   | C7 | the stop control stopped a different agent | 1398 |
   | C8 | `could not fetch origin/main and its tags: … Permission denied (publickey)` | 1374 |

3. Each class has one representative issue carrying a resolution comment that states, in plain
   text, the identified root cause, the full 40-character SHA of the fix commit, and the name of at
   least one regression test that exercises the failure mode. Each fix commit is an ancestor of
   `origin/main`.
4. Each named regression test exists in the tracked tree and passes: a Rust test passes under
   `cargo test --workspace`, a client test under `bun test`, and a browser assertion under the new
   suite. A class whose fix is "shares C<n>'s root cause" names that class instead of its own SHA
   and test.
5. A browser suite exists at `.devboard/e2e/` with a committed `playwright.config.ts`, one or more
   spec files, and fixtures; it launches the built `devboard serve` binary against a throwaway
   fixture repository, serves the real built client bundle, points at the live Gitea, and uses
   `devboard acp-stub` as `AGENT_COMMAND` so agents start deterministically without a model. It
   runs with one documented command and exits 0.
6. The suite proves, for each of the nine background agent families (`scout`, `watchdog`, `design`,
   `dead-code`, `mcp-optimizer`, `api-standards`, `single-responsibility`, `consistent-naming`,
   `release-train`), through the browser controls: Start moves the family to a running state within
   60 s; Stop moves it to `stopped` within 30 s; the worker process recorded for that family is gone
   from the process table; and no `devboard worker <family>` process for the fixture repository
   survives the stop.
7. The suite proves the Issues worker's own controls the same way: Start issues the run and Stop ends
   it, with the same 60 s / 30 s bounds and the same no-surviving-process assertion.
8. The suite proves user issue creation end to end: a browser-driven report through the overlay
   receives `201`, the created issue exists on the live Gitea with the operator report in its body,
   the UI shows the issue link, and the suite closes that issue afterwards so the board returns to
   an empty open set.
9. The suite runs a soak of at least five consecutive start/stop cycles across the families in one
   dashboard session; after every cycle `GET /ready` answers success, the client bundle still loads,
   and after the final cycle the process table holds no orphaned worker and no second dashboard for
   the fixture repository.
10. The soak files no new `[ui] Error notification:` issue: the open-issue count for
    `dsdenes/devboard` is 0 before the soak and 0 after it, and the notification region shows no
    error entry for the classes in criterion 2.
11. The suite is not a gate: `.gitea/workflows/devboard-ci.yml`, `.github/workflows/release.yml`,
    and the release-suite implementation are unchanged by this work, and no `e2e` step is added to
    any workflow.
12. Documentation matches reality: `.devboard/README.md` lists the suite's run command in its
    Tests section and states that it is not a CI gate, and `.devboard/prompts/implement-issue.md`
    no longer forbids browser tests, instead pointing at the suite as an operator tool.
13. The repository's own gates pass in the worktree:
    `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
    `cargo test --workspace`, `bun run build`, `bun run check`, and `bun test` each exit 0.
14. The fix commit range is on `origin/main`: `git status --short --branch` in the worktree reports
    no commits ahead of upstream, and `git ls-remote origin refs/heads/main` names the integration
    commit. The worktree is removed only after that check.
15. The Release Train publishes the pushed commit: the Gitea release for the new version exists,
    `versionState` reports it as `latest`, and the dashboard serves it after replacement.

## Verification

Run from the worktree root `.worktree/<name>`; `$G` is the board base URL and `$T` the forge token,
both read from the repository `.env` (`DEVBOARD_GITEA_URL`, `GITEA_TOKEN`). Never print `$T`.

1. Open-issue set is empty and every start-set issue is closed:

   ```bash
   set -a; . ./.env; set +a
   curl -s -H "Authorization: token $GITEA_TOKEN" \
     "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/issues?state=open&type=issues&limit=200" \
     | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d)); assert d == []'
   for n in 1398 1397 1396 1395 1394 1393 1392 1391 1390 1389 1388 1387 1386 1385 1384 1383 \
            1382 1381 1380 1379 1378 1375 1374 1372 1371 1369 1368 1367 1365 1364 1363 1362 \
            1361 1360 1359 1358 1357 1356 1355 1352 1351 1350 1348 1347; do
     curl -s -H "Authorization: token $GITEA_TOKEN" \
       "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/issues/$n" \
       | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"] == "closed", d["number"]'
   done
   ```

2. Representative resolution comments name a real commit and a real test:

   ```bash
   curl -s -H "Authorization: token $GITEA_TOKEN" \
     "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/issues/<n>/comments" \
     | python3 -c 'import json,sys; [print(c["body"]) for c in json.load(sys.stdin)]'
   git merge-base --is-ancestor <sha> origin/main && echo ancestor
   git grep -n '<test name>' -- .devboard
   ```

3. The suite's files exist and are tracked:

   ```bash
   git ls-files .devboard/e2e | grep -E 'playwright\.config\.ts'
   git ls-files .devboard/e2e | wc -l
   ```

4. The suite runs green against the real binary, the real bundle, and the live forge:

   ```bash
   cd .devboard
   bun run build
   cargo build -p devboard
   set -a; . ../.env; set +a
   bunx playwright test --config e2e/playwright.config.ts
   echo $?   # must print 0
   ```

   The config supplies the fixture repository, `STATE_DIR`, `ADRS_DIR`, `GOAL_FILE`, `STATIC_DIR`
   pointing at `.devboard/dist`, `AGENT_COMMAND` pointing at the built `devboard acp-stub`,
   `DEVBOARD_GITEA_URL`, and `GITEA_TOKEN`, and writes its report and traces under
   `.devboard/.tmp/e2e/`.

5. Per-family control proof is asserted by the suite, and independently observable in its report:

   ```bash
   python3 - <<'PY'
   import json
   report = json.load(open('.devboard/.tmp/e2e/report.json'))
   names = {s['title'] for s in report['suites'] for s in s.get('specs', [])}
   print('\n'.join(sorted(names)))
   PY
   pgrep -af 'devboard worker' || echo 'no worker process'
   ```

6. Orphan and readiness checks after the soak are asserted in the suite; the evaluator repeats them
   live during the final manual run: `pgrep -af 'devboard serve'` shows exactly the one dashboard
   the suite controls, `curl -fsS -H "Authorization: Bearer $DEVBOARD_DASHBOARD_TOKEN" \
   http://127.0.0.1:<port>/ready` exits 0, and `pgrep -af 'devboard worker'` prints nothing.

7. The suite is not wired into a gate:

   ```bash
   git diff origin/main..HEAD -- .gitea/workflows .github/workflows \
     .devboard/crates/devboard/src/release_suite.rs
   # prints nothing
   ```

8. Documentation states the new reality:

   ```bash
   grep -n 'playwright' .devboard/README.md .devboard/prompts/implement-issue.md
   grep -n 'never add a browser test' .devboard/prompts/implement-issue.md
   # the second grep must find nothing; the first must name the suite's run command
   ```

9. The repository gates:

   ```bash
   cd .devboard
   cargo fmt --check --all
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   bun run build && bun run check && bun test
   ```

10. Push and release:

    ```bash
    git ls-remote origin refs/heads/main
    git status --short --branch
    devboard doctor .
    ```

    The remote tip equals the worktree commit; the branch reports no commits ahead; the published
    version appears in `versionState` and in the Gitea release list.

## Boundaries

- Work only inside a git worktree at `<repo root>/.worktree/<name>`; never edit the opened
  checkout. The uncommitted changes already present in the opened checkout belong to the user and
  are left untouched.
- Editable: `.devboard/crates/devboard/src/**`, `.devboard/crates/devboard/tests/**`,
  `.devboard/client/**`, `.devboard/lib/**`, the new `.devboard/e2e/**`,
  `.devboard/.gitignore`, `.devboard/package.json`, `.devboard/README.md`,
  `.devboard/prompts/implement-issue.md`, and new goals or prompts only where a fix requires it.
- Not editable: `.gitea/workflows/**`, `.github/workflows/**`, `release_suite.rs`,
  `dist-workspace.toml`, the host data `adrs/` and `GOAL.md`, and any installed copy under
  `.omp/` except through `.devboard/install.sh` when a canonical prompt changes.
- Never add the suite to a CI workflow, the release suite, or the container gate. Never re-create
  `verify-*.ts` scripts or a Playwright config outside `.devboard/e2e/`.
- The browser suite must never point `REPO_DIR`, `ADRS_DIR`, `STATE_DIR`, or `GOAL_FILE` at this
  checkout. It uses a fixture tree under `.devboard/e2e/fixtures/` copied to a per-run scratch
  directory under `.devboard/.test-tmp/`, and every artifact stays under `.devboard/.tmp/e2e/`.
- Nothing is created outside `<repo root>`. Playwright reads the already-installed
  `chromium-1248`; if any browser must be installed, set `PLAYWRIGHT_BROWSERS_PATH` to
  `.devboard/.tmp/ms-playwright` so the download lands inside the repository.
- Board writes are limited to: closing the 44 start-set issues, one resolution comment per class,
  duplicate-reference comments, and the single proof issue the suite files and then closes. Never
  delete an issue, never reopen one, never rewrite another issue's body or title.
- Never run `devboard publish` or dispatch a release workflow by hand; the Release Train owns
  releases. Never kill, spawn, or relaunch a dashboard by hand outside the suite's own fixture
  server, which the suite owns and cleans up.
- Harness code stays host-neutral: no absolute paths, no project identifiers, no assumption about
  the host stack baked into `.devboard/`.

## Stop conditions

- No attempt cap, no token budget, and no time budget. Continue until every success criterion is
  verified against the live board, the running dashboard, and a green suite run.
- Halt and surface only when: a failure class cannot be reproduced and its issue comment cannot
  truthfully name a root cause, fix, and test; a fix would require editing a path this goal marks
  not editable; the forge or its token is unreachable so the board cannot be read or closed; the
  browser binary is unavailable and cannot be installed inside the repository; or the Release Train
  is blocked by an external release-workflow failure it cannot retry.
- A single failing test run, a single timeout, or a single red CI pass is not a stop condition;
  diagnose it, fix it, and continue.

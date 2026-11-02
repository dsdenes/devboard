## Objective

This repository's generic harness under `.devboard/`, when a dashboard runs from a harness source
checkout (`.devboard/package.json` names `@dsdenes/devboard` and no installed package sits under
`.devboard/node_modules/@dsdenes/devboard`), makes one successful `bun run publish` the single
authorization for that dashboard to replace itself with the published revision. After the publish
path has fast-forwarded `main`, built `dist/`, dispatched and verified the release workflow, the
npm package, and the Gitea assets, every live source dashboard for that checkout replaces itself
without an operator click, serves the new backend code and the new client bundle, and reloads
every connected page once. The live version state reports `running` as the version the process
actually loaded and `installed` as the source version a restart would load, with `stale` true while
they differ; the status bar labels that source value `Source`. Installed npm hosts keep their
existing automatic-update behavior unchanged.

## Success criteria

- A source checkout still has no package under `.devboard/node_modules/@dsdenes/devboard` before
  and after a refresh; no npm install, package replacement, or host write occurs on the source path.
- `bun run publish` writes a source-refresh request only after it exits successfully, meaning its
  existing fast-forward, dependency install, client build, release-workflow wait, npm-package
  verification, and Gitea-asset verification have all passed. A failed or partial publish writes no
  request.
- One request is written for each live dashboard whose `REPO_DIR` is this checkout and whose
  serving harness is this checkout's `.devboard`, using that dashboard's own `STATE_DIR`. The
  request is written atomically and names the published commit, the released version, and a
  deterministic SHA-256 digest of the built `.devboard/dist` tree.
- A source dashboard that reads a valid request verifies the current `.devboard/dist` digest, does
  not run a second build, and replaces itself through the existing relaunch and replacement-handoff
  path. The old process exits, exactly one process listens on the original port, and the new
  process serves the backend code and the client bundle of the published revision.
- Every connected page receives `serverRestarting`, waits for the replacement, and reloads once; the
  final document is served from the new bundle, not the startup snapshot.
- The trigger is publish-only. A new commit, a new release tag, a rebuilt `dist`, an edited source
  file, a page reload, or an npm update check does not restart a source dashboard. Only a valid
  publish request, or the retry of a pending valid request, can restart it.
- During the interval between a successful publish and the restart, live `versionState` for a
  source checkout reports `running` as the version loaded at process start, `installed` as the
  current source version a restart would load, and `stale: true`. After the restart,
  `running === installed` for the published version and `stale` is false.
- The status bar renders the second version value with the label `Source` on a source checkout, and
  the MCP `devboard_status` result agrees with the live WebSocket `versionState` for `running`,
  `installed`, and `stale`.
- Installed npm hosts are unchanged: `running` is the loaded package version, `installed` is the
  package version under the prefix, the npm update loop, automatic replacement, fallback control,
  and page reload behave exactly as before.
- A missing, unreadable, or mismatched request, a dist digest that does not match the request, a
  failed replacement spawn, or a new process that never becomes ready leaves the old process
  serving the old bundle on the original port. The failure is journaled once per attempt and every
  connected page stays usable.
- A pending valid request is retried on a fixed interval until it succeeds or a newer publish
  request supersedes it. The default interval is 60,000 ms, configurable with
  `DEVBOARD_SOURCE_REFRESH_INTERVAL_MS`, with a minimum of 1,000 ms. A retry does not spin, does not
  start a second process, and does not replace the old process until the new one is ready.
- Re-delivering the same request or the same published revision after a successful refresh causes no
  second restart. Two source dashboards for the same checkout on different ports both refresh from
  the one publish.
- A live detached run, a live goal-draft owner, and a live background worker survive the refresh
  with their run identities, activity, and answer/stop paths intact, using the existing replacement
  handoff.
- `cd .devboard && bun test` exits 0; `cd .devboard && bunx tsc --noEmit` exits 0;
  `cd .devboard && bun run build` exits 0; `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run verify:update` exits 0 and still proves the installed-host startup
  install, `serverRestarting` plus one reload, failed-replacement fallback, and draft survival.
- `cd .devboard && bun run verify:install` exits 0 with its source-checkout assertions updated to
  the new contract: the source checkout never installs and never restarts on an update check, and
  it replaces itself only from a valid source-refresh request.
- `cd .devboard && bun run verify:source-refresh` exits 0 and proves every source-refresh criterion
  above against real source-dashboard processes and a fixture signal writer, without running a real
  release or a real `bun run publish`.
- `cd .devboard && bun run verify:interface` exits 0 and its source-checkout status-bar assertion
  expects `running`, `Source`, and `stale` from the new contract.
- `.devboard/README.md` documents the publish-only source refresh, the request contents, the digest
  check, the retry interval and environment variable, and that manual source edits do not refresh.
- `AGENTS.md` and `.devboard/templates/host-AGENTS.md` remain byte-identical and state that a source
  checkout never installs, replaces itself only after a successful publish, and that automatic
  source refresh is the only additional restart path beyond install, update, and the reload control.
- The work is merged into `main`, pushed to the canonical upstream, and released by the Release
  Train; `git ls-remote origin refs/heads/main` names the integrated commit,
  `git status --short --branch` reports no commits ahead of the upstream, and the release workflow
  for that commit succeeds.
- After that release, the integration checkout's running source dashboard reports
  `running === installed ===` the released version, `stale: false`, and serves a bundle whose
  `dist` digest equals the one recorded in the successful publish request.

## Verification

Work in the task worktree. `<repo>` is the worktree root from `git rev-parse --show-toplevel`;
commands run from `<root>` unless they name `.devboard`. Every fixture host, state directory,
dashboard log, browser profile, and screenshot stays under `<repo>/.devboard/.tmp/`.

- `cd .devboard && bun test` exits 0, including new unit tests for request parsing, digest
  comparison, the publish-only trigger, retry scheduling, and the source version fields.
- `cd .devboard && bunx tsc --noEmit` exits 0.
- `cd .devboard && bun run build` exits 0.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run verify:update` exits 0; its log still contains the startup install,
  the `serverRestarting` reload, the failed-replacement fallback, and the surviving draft.
- `cd .devboard && bun run verify:install` exits 0; its source-checkout step starts a source
  dashboard with an update fixture and proves no install, no update-driven restart, and one
  process. The step's title and assertion text name the new publish-only contract.
- `cd .devboard && bun run verify:source-refresh` exits 0. It must start at least one source
  dashboard on a free port with a fixture `STATE_DIR`, write a valid request through the same
  writer `publish.ts` uses, and assert: the old pid exits; exactly one new pid listens; the served
  asset hash equals the built `dist` hash; a connected WebSocket receives `serverRestarting`; the
  page reloads once; `running` and `installed` report the fixture version and `stale` is false; a
  live detached run and goal-draft owner keep their identities and finish. It must then write an
  invalid digest, a missing request, and a replacement that cannot start, and assert the old pid
  still serves on the original port, the failure is journaled once, and the page stays usable. It
  must write a valid request again and assert the pending retry succeeds on the configured
  interval. It must deliver the same request twice and assert no second restart.
- `cd .devboard && bun run verify:interface` exits 0; the source-checkout status bar test reads
  `running <served version>` and `Source <source version>`, and the stale state appears only while
  the values differ.
- `cd .devboard && bun run verify:source-refresh` uses `DEVBOARD_SOURCE_REFRESH_INTERVAL_MS=1000`
  for retry timing; the default environment reports 60,000 ms in the skill's own assertion.
- From `<repo>`, a throwaway fixture check with `REPO_DIR=<repo>`, the source checkout, and a
  valid request proves the served `index.html` asset name changes while the old asset name no
  longer appears in the final document; the same check proves a plain commit or rebuilt `dist`
  alone changes no pid.
- `git ls-remote origin refs/heads/main` prints the integrated commit;
  `git status --short --branch` reports no commits ahead of the upstream; the release workflow run
  for the pushed commit concludes successfully.
- From the integration checkout, `cd .devboard && bun run publish` exits 0 and reports the released
  version, npm package, and Gitea assets. Read the source dashboard's live `versionState` and the
  status bar and confirm `running === installed ===` the released version, `stale: false`, and a
  served bundle digest equal to the request's recorded digest.

## Boundaries

All edits, builds, tests, and verification runs happen inside one worktree at
`<repo>/.worktree/source-dashboard-auto-refresh`. Merge that worktree into `main`, push the
integrated commit to the canonical upstream, wait for the Release Train to release it, then remove
the worktree and branch. Never edit the opened checkout.

Allowed files and directories: `.devboard/server/` (index, updates or a new source-refresh module,
version, app, and their tests), `.devboard/scripts/publish.ts`,
`.devboard/scripts/verify-install.ts`, a new `.devboard/scripts/verify-source-refresh.ts`,
`.devboard/package.json` for the new verification script, `.devboard/client/lib/connection.svelte.ts`,
`.devboard/client/lib/components/StatusBar.svelte` and its tests, `.devboard/mcp/status.ts` and its
tests, `.devboard/lib/` where the shared version or inventory contract requires it,
`.devboard/README.md`, `AGENTS.md`, and `.devboard/templates/host-AGENTS.md`.

Leave untouched: `.omp/skills/**`, `.omp/commands/**`, `.omp/extensions/**`, `.omp/config.yml`,
`.omp/settings.json`, `adrs/**`, `GOAL.md`, the installed npm package under any host prefix,
installed-host update behavior, agent prompts and run order, Discover artifacts and staging,
background-worker protocols, issue/PR forge behavior, and every existing `data-testid` and
`data-command` value outside the status-bar labels changed by this goal. Do not add a dependency,
hand-edit a lockfile, commit generated files, or write outside `<repo>`.

The source refresh is generic harness behavior. It must not name this repository, its remote, its
host paths, or its release origin. It applies to any harness source checkout using the same
`REPO_DIR` and `STATE_DIR` contract. Installed hosts must never receive or act on a source-refresh
request.

Do not kill, spawn, or relaunch a dashboard by hand. The only restart paths are the existing
install/update path, the existing reload control, and the new publish-driven source refresh. Never
run `bun run publish` by hand for verification: use the fixture signal writer. Never force-push,
rewrite published history, or use `--no-verify`.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity the repository and this goal cannot resolve, a risky or
irreversible operation, a missing prerequisite, or a blocked external dependency. Examples: the
publish path cannot expose a completion signal without changing release side effects; a replacement
cannot be made ready before the old process stops without an irreversible protocol change; the
source refresh would require installing a package or writing a host file; multi-dashboard request
delivery cannot be made atomic; the canonical upstream, Gitea API, or release workflow is
unavailable. Do not halt for effort, test count, or the number of fix-and-rerun cycles.

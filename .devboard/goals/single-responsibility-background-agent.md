## Objective

The Devboard dashboard gains a background-agent family, Single Responsibility, shipped and installed with
the harness like the other families. While started, it audits the source code of the repository it is
installed into against the project skill `devboard-single-responsibility-principle` and files
`single-responsibility` issues that show how to improve that code one component and one
single-responsibility violation at a time, so the repository can be made better along that single aspect
without bundling unrelated changes.

## Success criteria

- The agent registry exposes a `single-responsibility` descriptor with label `Single Responsibility`, a
  description naming the skill-driven audit, `scope: "repository"`, a file prompt
  `single-responsibility.md`, the shared start/stop/settings commands, the shared issue columns, an
  activity detail panel, a 60-minute default cadence accepting 1 through 1440, and limits defaulting to
  10 per rolling hour and 5 open, each nullable or an integer 1 through 100.
- The sidebar entry `open-devboard-single-responsibility` opens the shared `agent-page` with
  `data-agent="single-responsibility"`: exactly one of `agent-start`/`agent-stop`, `agent-cadence`,
  `agent-last-run`, `agent-next-run`, `agent-limit-hour`, `agent-limit-pending`, `agent-issues`,
  `agent-issues-count`, `agent-sync-at`, and the pinned `agent-activity-bar`;
  `agent-count-single-responsibility` equals the rendered row count; the prompt section shows
  `.devboard/prompts/single-responsibility.md` as read-only bytes.
- The MCP surface includes the family: `background_agents_list` and `background_agent_get` return its
  snapshot, from the live dashboard or projected from persisted state when none is live, and
  `background_agent_control` starts, stops, and saves cadence and limits for it.
- `.devboard/prompts/single-responsibility.md` begins with `## Manifesto`, whose first sentence names the
  goal and the observable result, and the body carries the whole flow: the cycle contract, the entry-point
  crawl, the five violation categories, evidence, dedupe, filing room, the issue body, and the read-only
  rules.
- `.devboard/omp/commands/single-responsibility.md` and `.omp/commands/single-responsibility.md` are
  byte-identical, and the command reads `.devboard/prompts/single-responsibility.md` and passes its
  argument, the absolute cycle directory, to that turn.
- `ENTRY_POINT_SURFACES` contains `single-responsibility`, the MCP `entry_point` tool accepts it, and
  `pickEntryPoint` over an unchanged pool returns the same path and line for the same seed while a
  different seed can choose a different file.
- The entry-point pool for the surface holds only regular, non-symlinked text files whose extension the
  host uses as source; no eligible path is a `*.test.*` or `*.spec.*` file or lies under a `fixtures/`,
  `tests/`, or `stubs/` directory; `.git`, `node_modules`, `dist`, `.worktree`, and `.devboard/.tmp`
  contribute no file.
- Each cycle writes
  `<REPO_DIR>/.devboard/.tmp/single-responsibility/cycles/<cycle-id>/request.json` naming the surface,
  seed, entry-point path and line, the five categories, the skill path, `knownTitles`, `issueRoom`, both
  caps, and the creation time; the ACP turn runs with that cycle directory as its working directory.
- The skill `.omp/skills/devboard-single-responsibility-principle/SKILL.md` is a cycle's only normative
  text: every filed issue names exactly one of `mixed-responsibilities`, `divergent-change`,
  `accidental-aggregation`, `responsibility-leakage`, `artificial-fragmentation`, quotes that bullet's
  directive verbatim, and cites the skill path; a candidate outside those five is recorded as skipped in
  activity and never filed.
- One issue carries one component and one violation: a cycle that proves two violations in one component
  files two issues, and one violation in two components files two issues; no issue names two components
  or two categories.
- Every filed issue body carries the category, the skill path, at least one evidence entry with a
  repository-relative `path`, a `lines` span inside that file, and a `quote` copied verbatim from that
  span, all inside the cycle's reachable crawl region, plus the affected component, the reason its
  responsibilities are mixed, the concrete refactor, and binary acceptance criteria; the title is one
  plain line of at most 200 characters with no prefix.
- Every filed issue carries exactly the labels `["single-responsibility"]`; Start preflight creates that
  label with its documented color and description when the origin lacks it, and refuses Start naming the
  forge error when creation fails.
- The issue lands in the origin repository: on GitHub through the forge-auth wrapper and `gh`, on Gitea
  through the HTTP API with the identity `forge-auth check` selected; no other tracker is written.
- `issue_create` refuses a `single-responsibility` title whose normalized form, lowercased with
  whitespace runs collapsed and trimmed, equals any existing `single-responsibility` issue in any state,
  any open issue, or a draft-goal heading, and files nothing; the prompt still reads the tracker and skips
  duplicates rather than relying on the guard alone.
- Caps hold: the hourly cap counts every `single-responsibility` issue created in the last rolling 60
  minutes in any state; the pending cap counts every open one; one cycle files at most the smaller room
  and 100; a zero room files nothing and records every skip in activity; a failed forge read files
  nothing and keeps the last known rows.
- The periodic forge sync marks each known row `pending` while its issue is open and `implemented` once
  it is closed, and records a failed sync in `agent-sync-error` without dropping rows.
- Cadence persists across reload and restart, applies to a running worker without a restart, and starts no
  cycle sooner than the interval after the previous cycle start; `agent-last-run` and `agent-next-run`
  show both.
- A cycle is read-only for the checkout: `git status --porcelain` and `git rev-parse HEAD` are unchanged
  before and after, no branch, commit, stash, push, build, test, install, or other agent runs, and the
  only writes are the cycle directory and the worker state directory.
- At most one cycle runs per checkout: Start during a cycle, a cadence change, a page open, a tab restore,
  or a reload starts no second cycle; the worker survives a dashboard restart and reattaches; Stop ends it
  and leaves settings and filed rows; a replacement dashboard drains an older live worker of the family
  per the harness rule.
- The worker needs no answer document: it reads the MCP tool log's `issue_create` records, re-reads each
  created issue from the forge, and publishes a row only for an issue it read back carrying the
  `single-responsibility` label; an issue whose body lacks the category, the skill path, or a verbatim
  evidence quote inside the named file span is recorded in activity as a verification failure and is not
  published as a filed row; a tool error files nothing and is recorded, never claimed as a filing.
- Start preflight refuses before spawning a worker or writing state, naming the missing fact, when the
  skill file is missing, unreadable, or resolves outside the repository; the origin is not a supported
  forge; the selected account cannot write; `omp` is missing; the `/single-responsibility` command is not
  installed; the state directory is outside the checkout; or the label cannot be created.
- `bun run verify:single-responsibility` exists and proves the entry, the shared page, the seeded entry
  point, the excluded test and fixture files, one issue per component and violation with provenance, the
  five-category restriction, dedupe, caps, the label, the preflight refusals, read-only checkout, single
  flight, and activity freshness against stub ACP and stub forge fixtures, without contacting a real
  forge, model, npm, or Gitea.
- The verification scripts that enumerate the family set, `verify-agents`, `verify-interface`, and
  `verify-mcp`, pass with the seventh family, its sidebar entry, its tab, and its MCP snapshot.
- The API Standards family is unchanged: `.devboard/issues/api-standards/**`,
  `.devboard/server/api-standards.ts`, `.devboard/prompts/api-standards.md`,
  `.devboard/omp/commands/api-standards.md`, and `.devboard/scripts/verify-api-standards.ts` are
  byte-identical to the goal's base commit, its descriptor values are unchanged, and
  `bun run verify:api-standards` exits 0.
- `.devboard/README.md` documents the family: descriptor id, label, prompt and command paths, normative
  skill path and the five categories, the seeded entry-point crawl, evidence, dedupe, caps, preflight,
  state paths, and the verify command; the skills section names the skill as this agent's normative
  source.
- Installing the harness into a fixture host writes `.omp/commands/single-responsibility.md`
  byte-identical to the canonical command and leaves the managed skill in place; `bun run verify:install`
  and `bun run verify:update` exit 0, and `doctor` reports no failure for the new copy.
- The work is merged to `main` and pushed: `git ls-remote origin refs/heads/main` names the integrated
  commit and `git status --short --branch` reports no commits ahead; the Release Train publishes a version
  whose npm tarball contains `prompts/single-responsibility.md`,
  `omp/commands/single-responsibility.md`, `issues/single-responsibility/worker.ts`, and
  `server/single-responsibility.ts`.

## Verification

Run every command inside `.worktree/<name>`, then again on `main` after the merge and push, except the
push and release proofs, which run after the push.

- `cd .devboard && bun run build` exits 0 and `dist/index.html` exists.
- `cd .devboard && bunx tsc --noEmit` exits 0.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun test` exits 0, including the new `tests/single-responsibility.test.ts`.
- `cd .devboard && bun run verify:single-responsibility` exits 0; its output names the family, the seeded
  entry point, the five categories, a filing per component, the dedupe guard, the caps, the preflight
  refusals, and the unchanged `git status` and `HEAD` of its fixture checkout.
- `cd .devboard && bun run verify:api-standards` exits 0 and its output is unchanged in shape.
- `cd .devboard && bun run verify:agents`, `verify:interface`, `verify:mcp`, `verify:install`, and
  `verify:update` each exit 0.
- `grep -n 'id: "single-responsibility"' .devboard/server/agents/registry.ts` prints one line.
- `grep -c '^## Manifesto' .devboard/prompts/single-responsibility.md` prints `1`.
- `grep -n 'devboard-single-responsibility-principle' .devboard/prompts/single-responsibility.md
  .devboard/issues/single-responsibility/paths.ts` prints a match in each file.
- `cmp .devboard/omp/commands/single-responsibility.md .omp/commands/single-responsibility.md` prints
  nothing and exits 0.
- Capture `base=$(git rev-parse origin/main)` before the first branch commit, then
  `git diff --name-only "$base"..HEAD -- .devboard/issues/api-standards .devboard/server/api-standards.ts
  .devboard/prompts/api-standards.md .devboard/omp/commands/api-standards.md
  .devboard/scripts/verify-api-standards.ts` prints nothing.
- `cd .devboard && bun -e 'import { eligibleFiles, pickEntryPoint } from "./lib/entry-point";
  const a = pickEntryPoint({ repoDir: "..", surface: "single-responsibility", seed: "srp-proof" });
  const b = pickEntryPoint({ repoDir: "..", surface: "single-responsibility", seed: "srp-proof" });
  const bad = eligibleFiles("..", "single-responsibility").filter((p) =>
  /\.(test|spec)\./.test(p) || /(^|\/)(fixtures|tests|stubs)\//.test(p));
  console.log(a.path, a.line, b.path, b.line, JSON.stringify(bad));'`
  prints the same path and line twice followed by `[]`.
- A fixture host prepared as in `bun run verify:install` has `.omp/commands/single-responsibility.md`
  with the canonical bytes, and `bun .devboard/scripts/host-sync` leaves it unchanged on a rerun.
- Operator action: from `.devboard`, `bun run build`, restart the source dashboard with the host paths it
  was given, open `http://127.0.0.1:8080/`, and click the Single Responsibility sidebar entry; the page
  shows the shared control ids, Start is enabled, the prompt section shows the prompt bytes, and the
  filed-issues table is empty.
- After the push: `git ls-remote origin refs/heads/main` names the integrated commit and
  `git status --short --branch` shows no commits ahead.
- After the Release Train publishes, `npm view @dsdenes/devboard version` prints the version and
  `cd .devboard && npm pack --pack-destination .tmp @dsdenes/devboard@<version>` followed by
  `tar tzf .tmp/dsdenes-devboard-<version>.tgz | grep -E
  'package/(prompts/single-responsibility.md|omp/commands/single-responsibility.md|issues/single-responsibility/worker.ts|server/single-responsibility.ts)'`
  prints four lines.

## Boundaries

- All work happens in `.worktree/<name>` inside the repository root; never edit the opened checkout. Every
  fixture, pack destination, log, and temporary host stays under `.devboard/.tmp/` or the worktree.
- Allowed to create: `.devboard/issues/single-responsibility/**`,
  `.devboard/server/single-responsibility.ts`, `.devboard/prompts/single-responsibility.md`,
  `.devboard/omp/commands/single-responsibility.md`, `.omp/commands/single-responsibility.md`,
  `.devboard/scripts/verify-single-responsibility.ts`, `.devboard/tests/single-responsibility.test.ts`,
  and `.devboard/tests/fixtures/single-responsibility-stub-*.ts`.
- Allowed to edit: `.devboard/lib/entry-point.ts` only for the new surface, its pool, and its refusal
  text; `.devboard/mcp/agents.ts`, `catalog.ts`, `issues.ts`, and `tools.ts` only for the snapshot, the
  `entry_point` enum, and the dedupe guard; `.devboard/server/app.ts` and
  `.devboard/server/agents/registry.ts` for the adapter and descriptor; `.devboard/package.json` for the
  script entry; `.devboard/README.md`; `.devboard/scripts/verify-agents.ts`, `verify-interface.ts`,
  `verify-mcp.ts`, and `verification.ts`; and the existing tests
  `.devboard/tests/agent-registry.test.ts`, `dead-code.test.ts`, `mcp.test.ts`, `coach.test.ts`, and
  `api-standards.test.ts` only where they enumerate the family set, the tab set, or the entry-point
  surfaces.
- The installed `.omp/commands/single-responsibility.md` is created by running
  `.devboard/install.sh "$(git rev-parse --show-toplevel)"`; never hand-write it divergently.
- Untouched, byte for byte: `.devboard/issues/api-standards/**`,
  `.devboard/server/api-standards.ts`, `.devboard/prompts/api-standards.md`,
  `.devboard/omp/commands/api-standards.md`, `.devboard/scripts/verify-api-standards.ts`; the behavior of
  the scout, watchdog, design, dead-code, coach, and release-train families; `.devboard/omp/skills/**`
  and `.omp/skills/**`; `.omp/extensions/**`, `.omp/config.yml`, and `.omp/mcp.json`; `adrs/`,
  `GOAL.md`, `AGENTS.md`, and `.devboard/templates/host-AGENTS.md`; `dist/` and `node_modules/`
  (generated, never hand-edited); every path outside the repository root.
- The new family is host-neutral: no host name, language, absolute path, project identifier, or secret is
  written under `.devboard/`; the audited repository and its origin are discovered at runtime, and every
  emitted path is repository-relative.
- The turn itself never files real issues, and verification never contacts a real forge, model, npm, or
  Gitea; the stub ACP peer and stub forge are the only peers a verify run uses.
- Forbidden shortcuts: force-pushing, rewriting published history, adding a dependency the repository
  does not use, disabling or skipping an existing check, `--no-verify`, restarting a dashboard by hand,
  running `bun run publish` or dispatching the release workflow by hand, and editing `dist/` instead of
  rebuilding it.

## Stop conditions

There is no attempt cap, no token budget, and no time limit: continue until every success criterion is
verified against current state. Halt and surface only for genuine ambiguity the repository cannot
resolve, a missing prerequisite (`omp`, `bun`, `git`, npm, Gitea, or headless Chrome unavailable so the
scope or release proof cannot run), a blocked external dependency (the origin rejects the push or npm
rejects the artifact), or a risky irreversible operation not already authorized (force-push, rewriting
published history). A failing check is never reported as satisfied, and a narrower feature, a scaffold, a
mock, a stub-only family, or a local-only commit never substitutes for a success criterion.

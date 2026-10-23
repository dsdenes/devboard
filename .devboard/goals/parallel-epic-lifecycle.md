## Objective

In this repository's devboard harness, replace the single-epic, single-agent lifecycle with a
continuously refilling parallel pipeline. The surfaces are `.devboard/prompts/epic-next.md`,
`.devboard/extensions/implement-next-epic.ts`, `.devboard/server/`, `.devboard/client/`, the
harness tests, and `.devboard/README.md`. A lifecycle run lists every open epic, starts one
implementation peer per epic concurrently with no fixed concurrency cap, and gives each peer
exactly one epic and its own worktree. When any lane closes its epic, the server immediately runs
epic generation again, even while other lanes are still implementing, and starts a lane for every
new epic that generation files. Epic generation itself becomes a zero-or-more operation: a single
run decides how many mutually independent epics the goal currently admits, files that many, and
never halts merely because an epic is already open. The page shows how many epics are open and how
many implementation lanes are running, and every active agent lane — epic generation, each
implementation epic, and ADR resolution — has its own tab carrying only that peer's live output and
its own pending question.

Implementation lanes merge their own branches into `main` when they finish, independently of the
server and each other. A failed merge is retried by fetching and integrating the latest `main`
again. A lane that ends with its epic still open is retried after a backoff and immediately when
`main` advances. A lane that reports an explicit hard blocker is parked and not retried until the
repository changes. When no lane is active, a generation pass files nothing new, and only parked
epics remain, the lifecycle stops with an error that names them and returns to the idle goal
stage; the parked epics stay open.

All existing foreground behavior — goal creation, goal revision, skills preparation, manual ADR
resolution, pause/resume, and implementation reset — keeps its current contract, except that
pause, resume, reset, and foreground takeover now govern every parallel lane.

## Success criteria

- The harness reads every open epic on the origin tracker, not only the first. An issue is still
  an epic exactly when it is open and either carries the `epic` label ignoring case or contains
  the `devboard-epic` marker in its body; GitHub and GitLab keep their current CLI query shapes,
  read-only and non-interactive. With five fixture epics open, the server and the standalone
  command see five.
- `.devboard/prompts/epic-next.md` no longer says the deliverable is exactly one epic and no
  longer halts because an open epic exists. It instructs one run to file zero or more epics, to
  let the goal's current state decide the count, to file only epics that are pairwise independent
  and independently implementable in parallel, and to skip rather than duplicate or overlap any
  already-open epic. Every per-epic contract (observable outcome, single implementation session,
  one pull request, sections, marker, label, ADR rules, no implementation detail) stays in force
  for every epic filed by the run.
- `.devboard/omp/commands/epic-next.md` still delegates to that prompt. Any change under
  `.devboard/omp/` is installed with `.devboard/install.sh` and the installed host copy matches
  byte for byte.
- A lifecycle start with N open epics starts exactly N implementation peers, one per epic, with
  N distinct epic identities, before any of them finishes. The peers overlap in time: the test
  observes N live peers, not N sequential spawns.
- A lifecycle start with no open epic starts exactly one epic-generation peer. Every epic that
  generation files starts its own implementation lane immediately, without waiting for other
  lanes or for the generation peer to be the only active peer.
- There is no fixed cap on concurrent lanes: with five open epics, five implementation peers run
  at once; with a goal that admits five independent slices, one generation run may file five
  epics.
- Closing any epic triggers exactly one epic-generation run, even while other lanes are still
  implementing. Refill triggers that arrive while a generation run is active are coalesced into
  at most one follow-up generation run; at no point do two epic-generation peers run at once.
- No epic is implemented by two lanes at once. Each implementation peer is given exactly one epic
  and does not select a different one. `/implement-next-epic <ref>` implements that epic;
  `/implement-next-epic` with no argument implements the single open epic when exactly one exists,
  and fails with the list of open epic URLs when more than one exists.
- A lane that ends with its epic still open marks that lane failed without stopping other lanes.
  The failure is visible in that lane's tab. The epic is retried after a backoff and immediately
  when `main` advances. Retrying does not create a second concurrent lane for the same epic.
- A lane whose peer reports an explicit hard blocker is parked: its tab reports the blocker, and
  it is not retried until `main` advances. Parking one epic never stops or delays the other lanes.
- When no lane is active, a generation pass files no epic, and parked epics remain, the lifecycle
  broadcasts an `error` naming every parked epic, returns to the idle `goal` stage, and leaves the
  parked epics open. It does not report the `finished` stage. Starting the lifecycle again clears
  the parked set and attempts those epics again.
- When no lane is active, no epic is open, a generation pass files no epic, and no ADR is still
  `Proposed`, the lifecycle reports the `finished` stage exactly as today. Pending ADRs continue
  to be resolved in file-name order before that decision.
- Each completed lane merges its own branch into `main`, removes its worktree, and closes its epic
  only after the merge succeeds. Concurrent lanes finish at independent times; the server imposes
  no merge schedule. The implementation prompt requires the lane to fetch and integrate the
  latest `main` and retry when its merge fails, and never to force-push. After every lane closes,
  `main` contains each successfully closed epic's work, and no lane's commits are discarded.
- The page shows `Open epics` and `Running lanes` counts with `data-testid="epic-count"` and
  `data-testid="lane-count"`. Both change as epics are created, implemented, closed, and retried,
  and both are reconstructed on reconnect.
- The page renders one tab per active agent lane in `data-testid="lane-tabs"`: epic generation,
  each running implementation epic, and ADR resolution. Each tab is a `data-testid="lane-tab"`
  carrying its kind and epic/record identity. Selecting a tab shows only that lane's current
  action, history, and status; two lanes streaming at the same time never interleave their lines.
- A lane's pending question appears only inside its own tab, with `data-testid="lane-question"`.
  Submitting an answer sends it to that lane's peer and leaves every other lane's state, activity,
  and question unchanged.
- When a lane stops, its tab remains for the rest of the lifecycle run and shows the final status
  (closed, failed, retrying, or parked). A later lane for the same epic gets a visible tab, and the
  interface distinguishes the retried attempt from the stopped one.
- A client that connects or reloads during a run receives the current open-epic count, running-lane
  count, the tab list, and every live lane's recorded activity and pending question before or with
  its own replies. No lane's output or question is lost, and nothing is replayed into a different
  tab.
- Pause pauses every running lane and holds the lifecycle loop; resume resumes every lane.
  Selecting a manual ADR while the lifecycle advances pauses all lanes first. Reset stops every
  lane, closes every peer, and then performs the existing reset contract unchanged.
- Goal creation, goal revision, skills preparation, and the lifecycle start/refusal matrix keep
  their current behavior, including the rule that starting one stops or refuses the others. The
  manual ADR sequence and the single-foreground controls are not converted into parallel lanes.
- `.devboard/README.md` documents the zero-or-more epic-generation contract, the absence of a
  fixed lane cap, refill on epic close, per-lane tabs and counts, the retry/park rules, the
  finish-with-error condition for parked-only runs, and independent merge with retry. The
  documented command names, environment variables, and start/stop rules match the implementation.
- New deterministic tests in `.devboard/server/parallel-lifecycle.test.ts` cover: N concurrent
  implementation peers for N open epics; five lanes with no cap; generation starting K lanes;
  refill on close while other lanes run; coalesced refill; per-epic assignment; retry after
  backoff; immediate retry when `main` advances; parked lane isolation; parked-only error and
  idle `goal` stage; reconnect replay of counts, tabs, activity, and questions; pause/resume and
  reset across lanes; and finish when nothing remains.
- Updated `.devboard/tests/implement-next-epic.test.ts` covers selecting a specific epic, the
  single-open-epic default, the multi-open-epic refusal, and the merge/retry instructions in the
  generated goal prompt. No test asserts that more than one open epic is an error when a reference
  was supplied.
- `cd .devboard && bun test` exits 0 with zero failures and `cd .devboard && bun run build` exits
  0. Existing lifecycle, pause, run, goal-creation, goal-revision, skills, feedback, reset, and
  extension tests either still pass or are updated to the new multi-epic contract without removing
  the behavior they prove.
- No changed harness file contains an absolute host path, a host project name, a remote URL, or a
  line longer than 768 bytes. The harness remains portable and the host checkout's implementation
  files are untouched.

## Verification

All edits, builds, tests, and fixture runs happen in
`<repo root>/.worktree/parallel-epic-lifecycle/`, never in the opened checkout. Temporary hosts,
bare remotes, fake tracker state, and verification scripts stay under that worktree. The worktree
merges into `main`, `origin/main` receives the integration commit, and the worktree and branch are
removed only after the push is verified.

- In the worktree, run the deterministic contract:

  ```sh
  cd <repo root>/.worktree/parallel-epic-lifecycle/.devboard
  bun test server/parallel-lifecycle.test.ts
  bun test
  bun run build
  ```

  The focused test drives the real server over WebSocket with a fixture tracker and the
  deterministic ACP stub. It asserts the spawn count, overlapping peer lifetimes, the epic
  identity in each prompt, refill timing, retry/park behavior, the parked-only error, reconnect
  replay, and pause/resume/reset across lanes.

- Prove the prompt contract text directly, because the prompt is the artifact that governs the
  real agent:

  ```sh
  cd <repo root>/.worktree/parallel-epic-lifecycle/.devboard
  grep -q "zero or more" prompts/epic-next.md
  grep -qi "independent" prompts/epic-next.md
  ! grep -q "exactly one epic" prompts/epic-next.md
  ! grep -q "Any open epic" prompts/epic-next.md
  grep -qi "latest .*main" extensions/implement-next-epic.ts
  grep -qi "retry" extensions/implement-next-epic.ts
  ```

  Read the matching passages once to confirm the positive statements carry the required meaning
  (count chosen by the goal, pairwise independence, no duplicate or overlap of an open epic) and
  that no other clause reintroduces the single-epic halt.

- Browser acceptance against a temporary host, using a fixture tracker and the deterministic stub
  agent. Build the client first, then start the server from the worktree with `REPO_DIR`,
  `ADRS_DIR`, `GOAL_FILE`, `STATIC_DIR`, `PORT`, and `AGENT_COMMAND` pointing at the fixture host,
  its skill directory containing one managed skill, and the stub. The verification server wrapper
  injects a tracker that reads a JSON list of open epics under the worktree, so no real forge is
  contacted. Seed three open epics and give each stub peer a distinct delay and activity line.

  Open `http://127.0.0.1:<port>/` and select `Start lifecycle`. Observe:

  - `Open epics` reads 3 and `Running lanes` reads 3 while all three implementation peers are alive.
  - Three implementation tabs exist, each naming its own epic. Switching tabs shows only that
    epic's activity; two simultaneously streaming lines appear in their own tabs, never mixed.
  - A question raised by one stub appears only in that tab. Answering it changes that tab and
    leaves the other two tabs' activity and questions unchanged.
  - Close one epic in the fixture tracker while the other two peers remain delayed. The closed
    lane's tab shows completion, a generation tab appears and runs while the other two lanes keep
    streaming, and a new epic filed by generation immediately adds a fourth lane tab.
  - Mark one lane's stub as reporting a hard blocker. Its tab reports the blocker; the other lanes
    continue. Advance `main` by one commit and observe that lane retried in a new tab.
  - Reload the page mid-run. The counts, tabs, each lane's activity, and the pending question
    reappear, with no output moved between tabs.
  - Press pause: every lane stops and reports paused. Resume: every lane continues.
  - Press reset: every lane stops and the existing reset confirmation and result still behave as
    documented.

- Git acceptance after the browser run, against the fixture host's bare `origin`: every epic the
  fixture marked closed has its branch merged into `main`, each lane's sentinel commit is an
  ancestor of `main`, no implementation worktree remains under `.worktree/`, and every closed epic
  is closed in the fixture tracker. Confirm no lane force-pushed and `origin/main` equals the
  fixture host's local `main`.

- Confirm the changed-file set and portability:

  ```sh
  cd <repo root>/.worktree/parallel-epic-lifecycle
  git status --short
  git diff --name-only main
  ! grep -rnE '/home/|dsdenes|devboard\.git' .devboard/server .devboard/client \
    .devboard/prompts .devboard/extensions .devboard/tests .devboard/README.md
  find .devboard -type f -name '*.ts' -o -name '*.md' -o -name '*.svelte' | \
    xargs awk 'length > 768 { print FILENAME ":" FNR; failed=1 } END { exit failed }'
  ```

  The changed paths are only those named under Boundaries, and the host implementation checkout
  is untouched.

- Merge the worktree into `main` and push. Then verify the integration:

  ```sh
  cd <repo root>
  git log -1 --format=%H main
  git ls-remote origin refs/heads/main
  git status --short --branch
  ```

  The two SHAs are equal, `main` is not ahead of `origin/main`, and the worktree and branch are
  removed only after both checks pass.

## Boundaries

Harness mode only. Work in `<repo root>/.worktree/parallel-epic-lifecycle/`; merge that worktree
directly into `main`, push `origin main`, verify the remote tip, then delete the worktree and its
branch. Never edit the opened checkout except by that merge. Do not create files outside the
repository root.

Allowed files:

- `.devboard/server/app.ts`
- `.devboard/server/tracker.ts`
- `.devboard/server/parallel-lifecycle.test.ts` (new)
- `.devboard/server/lifecycle.test.ts` and `.devboard/server/lifecycle-pause.test.ts` (only the
  expectations the new multi-epic contract changes)
- `.devboard/server/run.test.ts`, `.devboard/server/app.test.ts`, and
  `.devboard/server/reset-implementation.test.ts` (only where a shared refusal or state assertion
  changes under parallel lanes)
- `.devboard/server/fixtures/stub-agent.ts` (deterministic multi-lane, delay, blocker, and
  tracker-state modes only)
- `.devboard/extensions/implement-next-epic.ts`
- `.devboard/tests/implement-next-epic.test.ts`
- `.devboard/prompts/epic-next.md`
- `.devboard/client/App.svelte`
- `.devboard/client/app.css` (styles for the counts and lane tabs only)
- `.devboard/README.md`
- `.devboard/omp/` only if a wrapper must change; then rerun `.devboard/install.sh` for this host
- `.devboard/goals/parallel-epic-lifecycle.md` (this specification)

Leave untouched: `.devboard/prompts/` files other than `epic-next.md`, `.devboard/omp/commands/`
and `.devboard/omp/extensions/` when no wrapper change is needed, `.devboard/install.sh`,
`.devboard/setup-devboard.sh`, `.devboard/package.json`, `.devboard/bun.lock`,
`.devboard/Dockerfile`, `.devboard/index.html`, `.devboard/vite.config.ts`,
`.devboard/svelte.config.js`, `.devboard/tsconfig.json`, all other files under
`.devboard/goals/`, `AGENTS.md`, `adrs/`, `.omp/`, `.gitignore`, and
`.worktree/open-issues/` and `.worktree/interface-8123.log`.

Do not add dependencies. Do not change the goal creation, goal revision, skills preparation, or
manual ADR contracts beyond routing their foreground takeover through every lane. Do not spawn an
ACP peer for reset. Do not remove the existing tracker settle behavior; apply it per lane and keep
its bounded retry. Do not introduce a fixed lane cap or a fixed epic-count cap. Do not weaken the
epic body contract or the per-epic single-session ceiling. Do not teach the epic prompt to decide
an architectural question or to write implementation detail. Do not push to the real origin from
a verification fixture, and do not run the real lifecycle against the real repository.

## Stop conditions

There is no attempt cap and no token, time, or cost budget. Continue until every success criterion
is verified against the current state.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation outside the fixture hosts and the final merge-and-push, a missing
prerequisite, or a blocked external dependency. Examples: `bun`, `bun test`, or `bun run build`
fails for a reason outside this goal; the worktree merge conflicts with `main` in a way that needs
a human decision; `origin` is unreachable or rejects the push; or a fixture host cannot start its
server or reach its bare origin.

Do not halt for effort, number of lanes, question count, test cycles, model latency, or the number
of fix-and-rerun passes.

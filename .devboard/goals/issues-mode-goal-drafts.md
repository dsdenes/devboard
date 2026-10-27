## Objective

The devboard harness under `.devboard/` gains a complete Issues-mode workflow for proposed goals. A new Drafts view under Issues mode lists every unprocessed Markdown draft in
`<REPO_DIR>/.devboard/goal-proposals/`; opening one runs a harness-owned elaboration agent that interviews the operator, writes the finalized five-section goal spec to
`<REPO_DIR>/.devboard/goals/<slug>.md`, files that spec verbatim as an open issue in the host's GitHub `origin` carrying the exact label `goal`, and deletes the draft only after the labeled issue exists. The detached Issues worker then gives every unhandled open `goal`-labeled issue its own concurrent omp agent in goal mode using the issue body verbatim, while the existing `/implement-all-issues` peer is scoped so it never processes, comments on, closes, or modifies a `goal`-labeled issue.

## Success criteria

### Drafts view

- Issues mode's sidebar gains a fourth entry after Runs: label `Drafts`, `data-command="open.issues.drafts"`, `data-testid="open-issues-drafts"`, a trailing count of listed drafts, and an accessible name that includes the mode and shortcut. It is listed in the command palette under the same command id.
- The Drafts page renders `data-testid="issues-drafts"` and lists every regular `.md` file directly under `<REPO_DIR>/.devboard/goal-proposals/`, sorted by filename, with `data-testid="issues-draft"` and `data-path` holding the repository-relative path. Each item shows the filename and its first Markdown heading; the empty state says no drafts exist.
- Selecting an item opens `data-testid="issues-draft-detail"` showing the draft bytes exactly, the captured UI context, and controls `data-testid="issues-draft-start"` (`data-command="issues.draft.start"`) and, while an elaboration runs, `data-testid="issues-draft-stop"` (`data-command="issues.draft.stop"`).
- The draft read path accepts only a repository-relative path whose resolved file stays directly inside `<REPO_DIR>/.devboard/goal-proposals/` and ends in `.md`. A path traversal, an absolute path, a directory, a symlink escape, or a missing file is refused with a visible error and no file is read outside that directory.
- The view refreshes on open, after the report panel writes a draft, after an elaboration completes or stops, and when a listed draft disappears. A successful file write through `POST /api/goal-proposals` makes the new draft appear without a page reload.
- Browser reload restores the Drafts page and the selected draft path when that file still exists; a missing path opens the list.

### Elaboration agent

- Starting a draft sends exactly one ACP prompt, `/goal-draft <repository-relative draft path>`, from one peer started with `AGENT_COMMAND` in `REPO_DIR`. The peer's activity streams into `data-testid="issues-draft-activity"`; questions render as options plus a free-text answer, and submitting sends the answer to that peer.
- One elaboration runs at a time. While it runs, every other draft's start control is disabled with a stated reason. Stop closes the peer, records the stop, keeps the draft, and re-enables the controls. A failed peer keeps the draft and shows the error; retry starts a new peer.
- `.devboard/prompts/goal-draft.md` is the elaboration contract and `.devboard/omp/commands/goal-draft.md` is its command wrapper; the wrapper reads the prompt and passes `$ARGUMENTS` as the draft path. `.devboard/install.sh` installs the wrapper into the host's `.omp/commands/`.
- The prompt requires repository research before questions, then an `ask` interview with one question per call, three mutually exclusive options, a concrete description per option, and exactly one recommended option. It forbids questions about effort, cost, time, token budget, or attempt caps. It requires the finalized spec to contain exactly `## Objective`, `## Success criteria`, `## Verification`, `## Boundaries`, and `## Stop conditions`, in that order, with binary success criteria and exact verification commands or actions.
- The finalized spec is written to `<REPO_DIR>/.devboard/goals/<slug>.md`. The slug is lowercase kebab-case, derived from the objective, at most six words; an existing filename is never overwritten and earns `-2`, `-3`, … The elaboration agent creates no other file except the spec and the draft removal described below, starts no implementation, and does not enter goal mode.
- The elaboration agent files the issue in the host origin with `gh`, never in `dsdenes/devboard` unless that origin is the host origin. The issue body is the finalized spec file's bytes exactly, passed as a body file, not retyped. The title is a concise one-line summary bounded to 200 characters. The issue carries the exact label `goal`.
- If the `goal` label does not exist in the host origin, the agent creates it before filing. Filing uses the harness forge-auth wrapper from `.devboard/scripts/forge-auth.ts` with write access to the origin repository.
- After filing, the agent verifies the created issue with `gh issue view <number> --json number,url,labels,body` that the `goal` label is present and the body equals the spec file. Only after that verification may it delete the draft. If label creation, issue creation, or verification fails, no issue is left unlabeled and the draft remains; the failure and any created issue URL are reported.
- The ACP completion is visible in the mode: the draft disappears from the list, the finalized spec remains under `.devboard/goals/`, and the new issue appears in the next Issues poll as an open issue with a visible `goal` marker.

### Issue execution

- `.devboard/issues/tracker.ts` includes each issue's labels in the poll result, and `.devboard/issues/state.ts` persists labels on queue entries and run records. Existing state and run files without labels still load, with labels defaulting to an empty list.
- The Open issues list shows every open issue. A `goal`-labeled issue carries a visible `goal` badge and is excluded from the implement-all pending count; unlabeled issues keep the existing `pending` and `handled` display.
- The worker never includes a `goal`-labeled issue in an `/implement-all-issues` run. When unhandled non-goal issues exist, the peer receives exactly
  `/implement-all-issues Process exactly these open issue numbers: #<n>, #<n>. Do not process, comment on, close, or modify any issue labeled "goal".`
  with every captured non-goal issue number and no goal issue number. When no unhandled non-goal issue exists, no implement-all peer is started.
- For every open, unhandled issue carrying the exact `goal` label, the worker starts one separate ACP peer with the prompt `/implement-goal-issue <number>` and gives each its own run record, activity, and question slot. Peers for different goal issues run concurrently; the worker never starts two peers for the same issue number.
- The published state and the UI distinguish each goal agent: its issue number, run id, status, activity, and pending question are addressable independently. Answering a question routes only to the agent that asked it. The Issues overview and Runs page show these agents alongside the implement-all run and are readable while more than one is active.
- Pause lets every active goal peer and the implement-all peer finish, then reports `paused` and starts no new goal peer or poll. Resume polls immediately. Stop closes every peer, records every active run as `stopped`, leaves its issue unhandled, releases the lock, and performs no cooldown write.
- A goal run that succeeds records the issue as handled in the ledger. A goal run that fails records `failed` with the first stderr line and starts no new peer for that issue until the existing five-minute cooldown expires; the issue stays open and unhandled. An issue closed by its agent leaves the queue on the next poll.
- `.devboard/extensions/implement-goal-issue.ts` implements the command, and `.devboard/omp/extensions/implement-goal-issue.ts` is the host-side re-export wrapper copied by `install.sh`. The command accepts one issue number, refuses a missing number, a missing issue, an issue without the exact `goal` label, or an existing goal in the session.
- The command creates one worktree and branch under `.worktree/`, activates the `goal` tool, and calls the `goal` create operation with the issue body verbatim as the objective: no distillation, no section filtering, and no appended requirements. It then implements the body end to end, verifies every criterion through the product surface, merges the branch into `main` with conflict integration and retry, pushes `main` to origin, removes the worktree and branch, and closes the issue only after the push. Every tracker command goes through the `.devboard/scripts/forge-auth.ts` wrapper.

### Verification surface and documentation

- New tests exist at `.devboard/server/goal-draft.test.ts` and `.devboard/tests/implement-goal-issue.test.ts`, and `.devboard/tests/issues.test.ts` gains cases for label-aware polling, implement-all exclusion, concurrent goal peers, per-peer questions, pause, stop, success, failure cooldown, and duplicate prevention. All fixtures remain under `.devboard/.tmp` or `.devboard/.test-tmp` and use stub ACP peers and stub `gh`.
- `.devboard/scripts/verify-interface.ts` exercises the Drafts sidebar entry, list, read, start, streamed activity, question and answer, stop, empty state, and refresh after the report panel writes a draft; it also proves the existing Issues overview and runs still work with multiple goal runs.
- `.devboard/README.md` documents the Drafts view and its data hooks, the `/goal-draft` contract and spec path, the `goal` label and host-origin filing, the separate concurrent goal agents, the implement-all exclusion scope, the new state fields, the `implement-goal-issue` extension, and the pause/stop/cooldown behavior.
- `cd .devboard && bun test`, `bunx tsc --noEmit`, `bun run check`, `bun run build`, `bun run verify:issues`, `bun run verify:interface`, and `bun run verify:ui` all exit 0.
- The change is merged into `main`, pushed to the canonical upstream, the `devboard-release.yml` workflow for the pushed commit succeeds, the GitHub Release and launcher version exist, and `cd .devboard && bun run publish` from the integration checkout exits 0 and reports the release. Installed dashboards report the new version through `versionState` and restart only from the reload control.

## Verification

Run from the repository root in the task worktree unless a step names the integration checkout.

- `cd .devboard && bun install --frozen-lockfile` exits 0.
- `cd .devboard && bun test server/goal-draft.test.ts tests/implement-goal-issue.test.ts tests/issues.test.ts` exits 0.
- `cd .devboard && bun test` exits 0.
- `cd .devboard && bunx tsc --noEmit` exits 0.
- `cd .devboard && bun run check` exits 0.
- `cd .devboard && bun run build` exits 0 and `dist/index.html` exists.
- `cd .devboard && bun run verify:issues` exits 0.
- `cd .devboard && bun run verify:interface` exits 0.
- `cd .devboard && bun run verify:ui` exits 0.
- `test -f .devboard/prompts/goal-draft.md` and `test -f .devboard/omp/commands/goal-draft.md` exit 0.
- `test -f .devboard/extensions/implement-goal-issue.ts` and `test -f .devboard/omp/extensions/implement-goal-issue.ts` exit 0.
- `grep -q '^## Objective' .devboard/prompts/goal-draft.md` and the same check for `## Success criteria`, `## Verification`, `## Boundaries`, and `## Stop conditions` exit 0.
- The targeted tests assert that the implement-all prompt contains every non-goal number, contains no goal issue number, and contains the exact `goal` exclusion sentence; that two goal issues produce two distinct concurrent peers with prompts `/implement-goal-issue <n>`; that answers reach only the asking peer; and that a second tick while a peer runs starts no duplicate.
- The targeted tests assert that the elaboration prompt is exactly `/goal-draft <path>`, that a stub agent which writes the spec and files the issue leads to the draft's removal only after label verification, and that a failed label verification leaves both the draft and a reported failure.
- The extension test asserts that the `goal` create objective equals the fetched issue body byte for byte, and that an issue without the `goal` label is refused before any worktree is created.
- `cd .devboard && bun run verify:interface` asserts the Drafts page hooks listed in Success criteria and the multi-agent Issues view with more than one active goal run.
- After merging and pushing, `git status --short --branch` reports no commits ahead of the upstream and `git ls-remote <remote> refs/heads/main` names the integration commit.
- The release workflow run for that commit concludes `success`; `gh release view` lists the harness tarball and its `.sha256`; `npm view @dsdenes/devboard@<version> version` prints the version.
- From the integration checkout, `cd .devboard && bun run publish` exits 0.
- A running dashboard reports `versionState` consistent with the installed release and shows no reload control after the reload; it is never restarted by hand.

## Boundaries

- Scope is the devboard harness at the repository root. All source edits are under `.devboard/`: `client/`, `server/`, `issues/`, `extensions/`, `omp/`, `prompts/`, `tests/`, `scripts/verify-interface.ts`, `scripts/verify-issues.ts` when needed, `package.json` only if an existing script must change, and `README.md`.
- The task worktree is `.worktree/<name>` inside the repository root. Every temporary file, fixture, log, state directory, browser profile, and build output stays inside the repository root; `.devboard/.tmp/` and `.devboard/.test-tmp/` are the only temporary roots.
- `.omp/commands/`, `.omp/extensions/`, and the installed `.devboard` prefix are refreshed only by `.devboard/install.sh`, `bun run publish`, or the launcher. Never hand-edit `.omp/`.
- Untouched: root `AGENTS.md`, `GOAL.md`, `adrs/`, `design/`, `DESIGN.md`, `openui.json`, `stories/`, `.github/`, `.devboard/launcher/`, `.devboard/templates/host-AGENTS.md`, `.devboard/node_modules/`, existing committed goal specs under `.devboard/goals/` other than this goal, and the installed global `/implement-all-issues` command.
- No new runtime dependency, no database, no webhook, no systemd unit, no timer, no machine-level scheduler, and no host-specific path, repository name, or user baked into `.devboard/`.
- Never force-push, never discard uncommitted user work, never rewrite published history, never close an issue without its acceptance criteria verified, and never create a pull request or merge request for issue automation.
- The host project's behavior is unchanged except for the new Issues-mode surfaces and the tracker/worker behavior described here. The harness remains deletable: removing `.devboard/` leaves the host build, tests, and run paths working.

## Stop conditions

- There is no attempt cap, no token budget, no time limit, and no cost limit. Continue until every Success criterion is verified by the commands above.
- Halt and surface only for genuine ambiguity in this goal, a risky or irreversible operation not already authorized, a missing prerequisite (`omp`, `gh`, forge write permission, the `goal` label's creation permission, or a writable host origin), a blocked external dependency (GitHub unavailable, release workflow unavailable), or a release/publish verification that cannot succeed.
- On halt, report the exact blocker, the command and its evidence, the work already completed, and the one decision or prerequisite needed to resume. Do not substitute a narrower feature, a scaffold, a mock, or a local-only commit for any criterion above.

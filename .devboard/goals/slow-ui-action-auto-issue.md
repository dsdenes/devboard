## Objective

In `/home/ds/devboard`, the Devboard harness under `.devboard/` must run a client-side background
latency guard over every operator-initiated UI action and the first-paint reads. Each action is
measured from dispatch to the first frame that answers it; when it is still unanswered at 1000 ms,
the dashboard files one issue through the existing `/feedback` path carrying a fixed instruction to
investigate and fix the root cause rather than mask the slowness. The guard is observational only:
the 10-second command ceiling, every server timeout, the busy control, and the request lifecycle
stay exactly as they are. Repeated breaches of one action identity share one issue for 24 hours.

## Success criteria

1. **Coverage and exclusions.** Every WebSocket command an operator gesture or surface opening
   dispatches, and every operator-initiated `POST /feedback` or `POST /goal-proposals`, is
   registered with the guard. The six first-paint reads on socket open are registered. The
   `getVersion` 3-second poll, the `getMcpTools` 5-second poll, the goal-drafts 2-second refresh,
   a polling surface's repeat request, and reconnect or restart sends are not registered. A client
   test sends through each origin class and observes only the operator and initial dispatches
   start an action.
2. **Completion and the hard 1000 ms breach.** An action is complete when the first inbound frame
   that answers it arrives; an unrelated or broadcast frame for another action does not complete
   it. A confirming frame at 999 ms files nothing; no frame at 1000 ms files exactly one issue; a
   frame arriving at 1001 ms does not cancel or duplicate that filing. A test proves that a healthy
   `startAgent` answered by its `starting` frame is not filed even when the test advances past
   2000 ms, while a command queued behind it and unanswered at 1000 ms is filed.
3. **Issue content.** The report's first non-empty line is
   `Slow UI action: <label> exceeded the 1000 ms budget.` so the created title is
   `[ui] Slow UI action: <label> exceeded the 1000 ms budget.` The report names the wire command
   or endpoint, the action's subject when it carries one, the route, the 1000 ms budget, the ISO
   dispatch time, and the captured UI context, and it contains exactly this fixed instruction:
   `Do not hide this slowness with a UI trick. Do not add optimistic rendering, a spinner, a
   skeleton, a cache, a debounce, a retry, a longer timeout, or a relaxed budget. Reproduce the
   same action, measure which part of the system consumed the time, find the root cause, and fix
   it systematically. Add a regression test that fails on the slow path. Do not remove, raise, or
   bypass this detector.`
   The `report` value is at most 8000 JavaScript string units, and a test with a maximal label and
   context proves it.
4. **One issue per identity for 24 hours.** The action identity is
   `<command or endpoint>|<subject>|<route>`, where the subject is the command's identifying field
   (`id`, `run_id`, `path`, `name`, or `url`) and empty when it has none; elapsed time and
   timestamp are not part of it. Two breaches of one identity in a page session send one POST and
   show one card. Two different identities send two POSTs. A reload or a second page uses the same
   `idempotency-key` header for the same identity, so the server's 24-hour replay cache returns the
   issue already filed. The existing endpoint test
   `a_repeated_idempotency_key_files_one_issue` still passes.
5. **No user-facing timeout changes.** `COMMAND_CEILING_MS` remains `10_000`; a control stays busy
   at 1100 ms, releases only on evidence or at its ceiling, and still shows
   `<Action> received no answer.` at 10 seconds. The guard never dismisses the busy state, clears
   its timer, aborts a request, or changes a polling interval. `AGENT_PREFLIGHT_TIMEOUT_MS` stays
   `20_000`, the feedback default stays `60_000`, and no server source or contract file changes.
6. **Observable notice with the issue link.** A breach produces one notice-severity notification
   card for that identity in the page session, naming the action and the 1000 ms budget. After the
   POST resolves, the card exposes an `Open issue` link whose `href` is the returned issue and no
   `File issue` control; the card stays in notification history. A second identity produces its
   own card.
7. **Failure and disabled reporting.** With `feedbackEnabled` false the guard sends no request and
   the card states `Issue not filed: reporting is disabled.` with no link. When the POST fails, the
   card states `Issue not filed: <detail>` and offers a `File issue` retry; a successful retry
   replaces that message with the `Open issue` link. The guard never monitors its own filing
   request, so a slow filing cannot recursively file.
8. **A restart is not a slow action.** A send issued while the connection is restarting, awaiting a
   replacement, or reconnecting starts no action, and a reconnect clears every pending action
   without filing.
9. **Documentation.** `.devboard/README.md` states the 1000 ms background budget, the covered and
   excluded actions, the fixed instruction, the 24-hour deduplication, the notice card, and that
   the 10-second ceiling and every server timeout are unchanged.
10. **Gates, merge, and release.** `cargo fmt --check --all`,
    `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
    `bun test`, `bun run check`, `bunx tsc --noEmit`, and `bun run build` all exit 0; the diff for
    `.devboard/contract` and `.devboard/crates/devboard/src` is empty; `main` at the upstream names
    the integrated commit; the Release Train has published the version, and `versionState` on the
    live dashboard reports it.

## Verification

Set the worktree, install once, and run every command from the path it names:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WT="$REPO_ROOT/.worktree/<task>"
git worktree add "$WT" -b devboard/<task> origin/main
cd "$WT/.devboard" && bun install --frozen-lockfile
```

Criteria 1 to 8 — targeted client tests (the files must exist under these names):

```bash
cd "$WT/.devboard"
bun test client/lib/slow-ui-action.test.ts
bun test client/lib/components/NotificationRegion.test.ts
bun test client/lib/command-busy.test.ts
bun test client/lib/notification-issue.test.ts
```

The new suite must cover, by name: operator versus refresh versus reconnect origins; 999, 1000,
and 1001 ms; the fast `startAgent` acknowledgement against a pending preflight; head-of-line
queueing; the exact instruction and 8000-unit bound; one POST for a repeated identity and two for
different identities; a stable idempotency key across instances; the notice link and history
retention; the disabled and failed states; the no-recursion rule; and the restart exclusion.

Criterion 4 — the server replay cache still guarantees one issue:

```bash
cd "$WT/.devboard"
cargo test -p devboard --test endpoints a_repeated_idempotency_key_files_one_issue
```

Criterion 5 — the user-facing constants are untouched:

```bash
cd "$WT/.devboard"
grep -n 'COMMAND_CEILING_MS = 10_000' client/lib/command-busy.svelte.ts
grep -n 'AGENT_PREFLIGHT_TIMEOUT_MS: u64 = 20_000' crates/devboard/src/agents_mode.rs
grep -n 'unwrap_or(60_000)' crates/devboard/src/config.rs
git diff --exit-code -- contract crates/devboard/src crates/devboard/tests
```

Criterion 9 — the documentation names the behavior:

```bash
cd "$WT/.devboard"
grep -n '1000 ms' README.md
grep -n 'Do not hide this slowness with a UI trick' README.md
```

Browser proof of the real client path, using a throwaway script under
`$WT/.devboard/.tmp/slow-ui-action/` that is deleted after the run. Start the dashboard against a
fixture, intercept `/feedback` with a 201 response whose `links.issue.href` is a known URL, and
intercept the WebSocket so one first-paint `versionState` is withheld for 1500 ms. In the browser:

1. After 1000 ms one `POST /feedback` exists; its JSON `report` starts with `Slow UI action:` and
   contains the fixed instruction, and its `idempotency-key` is present.
2. The notice card names the action and, after the response, shows `Open issue` with the known
   URL and no `File issue` control.
3. The control that dispatched the withheld command is still busy at 1100 ms and reaches its
   10-second `received no answer` notice; the filing changed neither.
4. A second identical breach adds no POST and no card; a different action adds its own.
5. Reload, slow the same action again, and observe the same `idempotency-key` and the same issue
   URL with no second server-side issue.

Workspace gates:

```bash
cd "$WT/.devboard"
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun test
bun run check
bunx tsc --noEmit
bun run build
git status --porcelain
```

The last `git status` is empty after the commit and after the throwaway script is removed;
`bun run build` refreshes `crates/devboard/assets`, whose generated diff is committed.

Release proof, after the Release Train publishes and `versionState` reports the released version:

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
curl -fsS "$DEVBOARD_GITEA_URL/api/v1/repos/dsdenes/devboard/releases/latest"
```

The first two commands name the same commit, and the release carries `devboard-manifest.json` for
that tag with the published version and artifact SHA-256.

## Boundaries

- Work only in a git worktree under `<repo root>/.worktree/`; never edit the opened checkout.
- Harness mode: every edit stays under `.devboard/`. `AGENTS.md`, `adrs/`, `GOAL.md`, `DESIGN.md`,
  `design/`, `.omp/`, and the host project stay byte-identical.
- Allowed files: a new `client/lib/slow-ui-action.ts` with its test, the dispatch gateway in
  `client/lib/connection.svelte.ts`, the two operator POST helpers in
  `client/lib/feedback-transport.ts` and `client/lib/goal-drafts.svelte.ts`, the filing helper in
  `client/lib/notification-issue.ts`, `client/lib/notifications.svelte.ts` and
  `client/lib/types.ts` for the card link, `client/lib/components/NotificationRegion.svelte` with
  its test, `client/App.svelte` wiring, `.devboard/README.md`, and the generated
  `crates/devboard/assets/**`.
- Forbidden: changing `COMMAND_CEILING_MS`, the 10-second ceiling semantics, any server timeout or
  retry schedule, any polling interval, any Rust source or test, any file under `contract/`, the
  `/feedback` body contract, the `[ui] ` title prefix, the Gitea-only delivery rule, the Issues
  worker's claiming behavior, or `.devboard/omp/`. No new dependency, no new WebSocket frame type,
  and no UI-side masking such as optimistic state, a synthetic delay, a spinner, or a relaxed
  budget.
- Filing uses only `/feedback`; no GitHub, GitLab, `gh`, or other tracker call is added. With
  reporting disabled the guard makes no request and raises no error loop.
- Never publish by hand, never dispatch the release workflow by hand, and never stop, spawn, or
  relaunch a dashboard by hand. The Release Train and the publish-driven source refresh are the
  only paths.
- Nothing is created outside `<repo root>`; the throwaway browser proof lives under
  `.devboard/.tmp/` and is removed.

## Stop conditions

- Effort is uncapped: no attempt limit, no token budget, and no time limit. Continue until every
  success criterion is verified.
- Halt and surface, rather than proceed, for genuine ambiguity or a risky or irreversible
  operation: changing the contract, adding a frame type, changing the 10-second ceiling, deleting
  or rewriting issues, force pushing, or rewriting published history.
- Halt when a prerequisite is missing or an external dependency is blocked: no configured Gitea
  reporting or token, no Playwright Chromium, no Release Train worker, or an unreachable GitHub or
  Gitea. Name the exact failing command.
- Never weaken a criterion to make it pass: do not raise the 1000 ms budget, remove the guard,
  exclude a healthy action without documenting why, file an issue by hand, or silence a test. If an
  operator action has no frame that can confirm it without a contract change, stop and report that
  attribution gap instead of inventing a frame or accepting a false filing.

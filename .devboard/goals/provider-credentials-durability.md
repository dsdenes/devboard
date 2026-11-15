## Objective

In the canonical Devboard harness (`.devboard/` in this checkout), the provider credential store
must never appear empty or unconfigured while a valid primary file, a valid same-directory backup,
or a non-empty dashboard credential list exists. Every provider save writes both
`<stateDir>/providers/credentials.json` and `<stateDir>/providers/credentials.backup.json`; every
reader prefers the primary and falls back to the backup; at startup and on every existing
60-second provider refresh the dashboard restores a missing or unusable primary from the backup or
from its in-memory list before it publishes provider state. A detected loss raises one journaled
server error, one app-wide error notification, and one harness issue when harness reporting is
configured; an unrecoverable store is reported as lost credentials naming the primary path and
`settings.providers`, never as a fresh "No provider is configured". The primary path and envelope,
provider selection, usage rules, key masking, refresh cadence, cleanup retention, and every other
agent behavior stay unchanged. The change lands through a worktree, merge, push, and the Release
Train; no manual publish.

## Success criteria

1. **Dual write and modes.** Every successful provider mutation (`createProvider`, `saveProvider`,
   `setProviderEnabled`, `deleteProvider`) writes both files atomically with the same envelope and
   the same subscriptions. After the mutation the two files are byte-identical, the
   `providers/` directory mode is `0700`, and both files are `0600`. A mutation whose write fails
   changes neither file and is not adopted.

2. **Reader fallback.** When the primary is missing or unusable and the backup is valid, the
   credential loader returns exactly the backup's subscriptions and exposes that it read the
   backup. It never returns an empty store while a valid backup exists. Every provider-resolving
   worker path uses that loader: Auto Scout per scan, Issues per run, Design per cycle, Ask, goal
   work, Flow, Discover, goal drafts, skills preparation, and the MCP optimizer finalizer.

3. **Startup repair.** A new provider service over a state directory with the primary missing and
   the backup valid rewrites the primary from the backup before its first view or command. A valid
   primary with a missing, differing, or unusable backup rewrites the backup from the primary. An
   unusable primary with a valid backup is preserved by the existing damaged-file rule and the
   primary is rewritten from the backup. Rewritten bytes and modes satisfy criterion 1.

4. **Running repair within one tick.** With a service holding a non-empty credential list,
   deleting the primary restores it byte-identically on the next provider refresh, before the
   refresh publishes `providersState` or the selection snapshot. Deleting both files in the same
   tick restores both from the in-memory list. The existing 60-second tick and the on-demand
   stale-usage wake are the only schedules; no new timer, filesystem watcher, or process is added.

5. **One alarm per loss event.** The first detection of a missing or unusable primary writes one
   `server-error` journal record naming the primary path, broadcasts one existing
   `{"type":"error","message":…}` frame naming it, and, when `DEVBOARD_GITEA_URL` is configured,
   files exactly one issue through the configured Gitea reporting path naming the path and
   containing no key material; no GitHub request is made. Repeated detections for the same loss
   add no record, frame, or issue, including across a dashboard restart of that loss. The loss ends
   when the primary is valid again after repair or a successful mutation; a later loss alarms
   again. A failed issue filing is journaled once and is not retried for that loss.

6. **Backup-only repair is quiet.** When the primary is valid and the backup is missing, differing,
   or unusable, the next startup or refresh rewrites the backup from the primary and journals one
   `activity` record. No error frame, issue, refusal, or loss event is produced.

7. **Unrecoverable loss is precise.** When both credential files are missing and no in-memory list
   exists at startup, a key-free presence marker under `<stateDir>/state/` distinguishes a lost
   store from a fresh one. The refusal in `providersState` and every worker
   `ProviderUnavailable` message name the primary path and `settings.providers` and do not contain
   `No provider is configured`. The selection snapshot is preserved as evidence until a successful
   save. The marker carries no key material, survives cleanup, and records the loss identity and
   whether its alarm was already emitted. A state directory with neither credentials nor the marker
   keeps today's message.

8. **Bounded worker retry.** A worker that previously resolved a provider successfully and now
   reads an empty store re-reads on a bounded schedule for at most 5 seconds and at least two
   attempts before returning the precise lost-credentials error. If either file becomes available
   during that window, the worker resolves successfully and starts its peer with the selected
   environment. Both directions are proven with an injected sleep or clock.

9. **Operator recovery without key re-entry.** After an unrecoverable loss, one successful provider
   mutation from the dashboard's in-memory list (for example toggling a subscription's enabled
   state) rewrites both files and the presence marker with every subscription, clears the lost
   state, and makes the next worker resolve succeed. No key is retyped while the dashboard holds
   the list.

10. **No key leakage.** No full key appears in `providersState` or `providerError`, in the journal
    or activity log, in the issue title or body, in process argv, in stderr output, or in the
    presence marker. The interface receives only masks ending in at most the last four characters,
    and no command or HTTP route exposes the backup file.

11. **Cleanup durability.** `devboard cleanup` and the watchdog sweep never remove the primary,
    the backup, the selection snapshot, or the presence marker at any age. A test seeds all four
    with mtimes older than the cutoff and asserts they survive a real pass. The backup and marker
    are added to the documented durable-state list with no change to the existing protected paths.

12. **Docs and mirror.** The canonical
    `.devboard/omp/skills/devboard-harness-reference/SKILL.md` provider and cleanup sections
    document the backup path, reader fallback, startup and per-tick repair, one-alarm semantics,
    marker-based loss refusal, the single-file guarantee boundary, and the no-key invariant.
    `.omp/skills/devboard-harness-reference/SKILL.md` is byte-identical after
    `.devboard/install.sh` and is committed with it. Neither file names a host path.

13. **No behavior regression.** `contract/http/getProviders.json` and
    `contract/http/refreshProviders.json` still match an empty fresh store byte-for-byte; provider
    selection, usage ranking, the 1% eligibility rule, the OpenRouter fallback, the mask, and the
    60-second refresh are unchanged; all existing tests pass. No client source changes are
    expected; if one is made, `bun run build` refreshes `crates/devboard/assets` and the committed
    copy is current.

14. **Live repair proof on a throwaway state directory.** Under
    `.devboard/.test-tmp/provider-repair-<pid>/`, with both usage base URLs pointed at
    `http://127.0.0.1:1` and `devboard serve --port 0`:
    - a two-subscription primary fixture with fake keys, mode `0600` in a `0700` directory, is
      repaired after deleting the primary: within 70 seconds the primary exists byte-identically,
      the backup exists, the journal holds exactly one new `server-error` record, and neither
      credential file contains a full key in the journal;
    - deleting both files, stopping that throwaway process, and starting a new throwaway process
      on the same state directory yields a `providersState` refusal naming the primary path and
      `settings.providers`, one additional `server-error` record for the new loss, and no
      `No provider is configured` text.

    The proof starts and stops only its own throwaway process and never touches a live operator
    dashboard or a host project.

## Verification

Run from the repository root unless a step says otherwise. Each command must exit 0.

```bash
cd .devboard && cargo fmt --check --all
cd .devboard && cargo clippy --workspace --all-targets -- -D warnings
cd .devboard && cargo test -p devboard --test providers
cd .devboard && cargo test -p devboard --test scout_worker
cd .devboard && cargo test -p devboard --test cleanup
cd .devboard && cargo test -p devboard --test ask
cd .devboard && cargo test -p devboard --test http_surface
cd .devboard && bun run test
cd .devboard && bun run check
cd .devboard && bun run build
git status --porcelain -- .devboard/crates/devboard/assets
.devboard/install.sh
diff -q .devboard/omp/skills/devboard-harness-reference/SKILL.md \
  .omp/skills/devboard-harness-reference/SKILL.md
```

The `providers` suite must contain tests that prove criteria 1 through 6 and 8 through 10 by
deleting each file directly, constructing a second service to simulate a restart, reusing the same
state directory for the alarm deduplication, injecting the retry clock, and asserting modes and
byte identity. The `cleanup` suite must prove criterion 11 with an ancient primary, backup,
selection, and marker. The `scout_worker` suite must prove criterion 8 at the scan boundary,
including the precise failure text and the absence of a failure when the reload succeeds during
the retry window. The `ask` suite must prove the fresh empty-store message is unchanged when no
marker exists. The `http_surface` suite must prove criterion 13's contract recordings.

For criterion 14, perform the sequence in a throwaway state directory:

```bash
cd .devboard
root=.test-tmp/provider-repair-$$
mkdir -p "$root/repo" "$root/state/providers"
# Write a valid two-subscription credentials.json fixture with fake keys; chmod 0600.
DEVBOARD_OPENCODE_GO_USAGE_BASE_URL=http://127.0.0.1:1 \
DEVBOARD_OPENROUTER_USAGE_BASE_URL=http://127.0.0.1:1 \
  cargo run -p devboard -- serve --repo-dir "$root/repo" --state-dir "$root/state" --port 0 &
# Read the port from "$root/state/version.json", wait for GET /providers, delete the primary,
# poll up to 70 seconds, and compare sha256sum and modes.
# Delete both files, stop only this process, start a second serve on the same state directory,
# and read GET /providers. Read "$root/state/journal/" for the server-error records.
```

A criterion passes only when the command or action above observes the stated result against the
freshly built tree, not against a cached dashboard, an installed copy, or an earlier bundle.

## Boundaries

Allowed to change:

- `.devboard/crates/devboard/src/providers.rs`, `app.rs`, and `state.rs` for the store, backup,
  marker, repair, alarm, and API behavior.
- `.devboard/crates/devboard/src/workers/scout.rs` only for the precise worker error propagation.
- `.devboard/crates/devboard/src/feedback.rs` or `gitea.rs` only if the existing reporting path
  needs a small reusable helper; no new dependency.
- `.devboard/crates/devboard/tests/providers.rs`, `scout_worker.rs`, `cleanup.rs`, `ask.rs`, and
  `http_surface.rs`, plus a shared test helper only when the existing helpers cannot express the
  case.
- `.devboard/omp/skills/devboard-harness-reference/SKILL.md` and, through
  `.devboard/install.sh`, `.omp/skills/devboard-harness-reference/SKILL.md`.
- `.devboard/goals/provider-credentials-durability.md`.
- `.devboard/contract/http/*.json` only if a wire shape must change; criterion 13 expects none.
- A task worktree under `.worktree/<name>` and throwaway state or repo directories under
  `.devboard/.test-tmp/` for the live proof.

Never change:

- Any host project, including its `.devboard/.tmp`, provider files, or running dashboard. The
  investigation's `arbinv` state is read-only evidence, not a target.
- Root `AGENTS.md`, `.devboard/AGENTS.md`, `GOAL.md`, `adrs/`, `.github/`, `.gitea/`, or the
  release workflow.
- The primary path or envelope, provider selection or usage behavior, the 1% eligibility rule, the
  OpenRouter fallback, key masks, the 60-second refresh, or any cleanup retention rule.
- The `providersState` shape, existing contract recordings, or any client source, unless a wire
  change proves unavoidable; then update every consumer and the contract recording together.
- Any file outside the repository root, `/tmp`, or a new dependency.
- Key material in tests, fixtures, commits, documentation, or issue text; every fixture key is
  fake.
- The Release Train, `devboard publish`, or the release workflow. The train is the only releaser.

## Stop conditions

There is no attempt cap, token budget, or time limit; continue until every criterion is verified.

Halt and surface only for genuine ambiguity, a risky or irreversible operation, a missing
prerequisite, or a blocked external dependency.

If the live proof cannot start a throwaway dashboard because of a port or process conflict, use a
different throwaway port and state directory; never stop, restart, or write to a live operator
dashboard.

If the Release Train is blocked by a CI failure, a missing artifact, or a forge error, report the
first concrete error and wait for its next tick. Never run `devboard publish` or dispatch the
release workflow by hand.

If a test shows a harness path removes the backup despite the cleanup exemptions, treat that as an
in-scope defect: fix it within the boundary above, or halt and surface the evidence if the only
fix is irreversible or outside the boundary.

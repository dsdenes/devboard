# Devboard ADR interface

Local browser interface for the records in `adrs/`. It lists every record, distinguishes records awaiting a decision (`Status: Proposed`) from resolved records, marks the pending record an agent run would take up first, and starts an agent on that record or on one the developer selects.

It also shows the repository's current goal in a `Current goal` textarea. The developer can edit the text and select `Save goal`; the server writes the submitted text verbatim to the goal document, and every page load reads that file rather than browser state.

While a run is active the interface names the record being resolved, appends the agent's ACP session updates to a live activity log, and presents each interview question with its choices plus a free-form answer field. One start resolves every pending record in ascending file-name order: after each run the server re-reads `adrs/`, and the sequence ends when no pending record remains or when the finished record is still `Proposed` (or has been removed). The chain runs in the server, so it continues if the browser disconnects.

The page also shows a lifecycle stage and pass number. Selecting `Start lifecycle` gives the server the loop: when the origin tracker already has an open epic, it implements that epic with `/implement-next-epic`; otherwise it runs the `/epic-next` agent, resolves any pending ADRs the run leaves behind with `/adr-resolve` in file-name order, and repeats. After an implementation peer exits, the pass increments and the lifecycle returns to epic generation; the epic the generation peer creates is implemented in turn. When the generation peer opens no epic and no record in `adrs/` is still `Proposed`, the lifecycle reports the `finished` stage and stops; a later start begins a new run. If the same epic is still open after its implementation, the lifecycle stops with an `error` instead of implementing it again. An epic is an open issue carrying the label `epic` (ignoring case) or the `<!-- devboard-epic -->` marker in its body; the server reads it with read-only `gh` or `glab` queries. While a lifecycle run works, the goal editor and every start control are disabled, and a client that connects or reloads receives the current stage, pass, and work in progress first.

## Stack

- Backend: TypeScript on Bun, serving the built client and one WebSocket at `/ws`. Each run spawns one `omp acp` subprocess over stdio.
- Client: Svelte built with Vite.
- Records: read from `adrs/` on every `listRecords` command and after every run, so files added, removed, or resolved while the server runs appear without a restart.

## Build and run

```bash
bun install
bun run build
ADRS_DIR="$PWD/adrs" bun run start
```

Open `http://127.0.0.1:8080/`. The server binds to `127.0.0.1` by default.

|Variable|Default|Purpose|
|---|---|---|
|`HOST`|`127.0.0.1`|Listen address.|
|`PORT`|`8080`|Listen port.|
|`ADRS_DIR`|`/repo/adrs`|Directory holding the ADR files.|
|`REPO_DIR`|parent of `ADRS_DIR`|Agent working directory and default goal location.|
|`GOAL_FILE`|`<REPO_DIR>/GOAL.md`|Goal document read on load and replaced on save.|
|`STATIC_DIR`|`dist`|Built client directory.|
|`AGENT_COMMAND`|`omp acp`|ACP peer command, split on whitespace. `server/fixtures/stub-agent.ts` is a deterministic substitute for tests and local verification.|

## Container

```bash
docker build -t devboard-adr-ui .
docker run --rm -d --name devboard-adr-ui -p 127.0.0.1:8080:8080 \
  -v "$PWD:/repo" devboard-adr-ui
```

The container reads `/repo/adrs` and listens on port `8080`. The repository mount is writable because `Save goal` replaces `/repo/GOAL.md`; mount it read-only only if goal saving is not needed. Docker publishes the port on the host's loopback interface only. The container process binds `0.0.0.0` because Docker forwards published traffic to the container interface; the local-only access boundary is enforced by the `127.0.0.1` host publish.

## WebSocket contract

The client sends:

```json
{ "type": "listRecords" }
{ "type": "getGoal" }
{ "type": "saveGoal", "text": "# Goal\n\nThe complete goal text." }
{ "type": "startRun" }
{ "type": "startRun", "file": "0002-example.md" }
{ "type": "startLifecycle" }
{ "type": "answer", "id": 1, "value": "Gamma" }
```

- `getGoal` reads the goal document from disk and answers with its complete contents.
- `saveGoal` replaces the goal document with `text` exactly as submitted and answers with the same text. A write failure leaves the file unchanged and answers with an `error`.
- `startRun` without `file` starts the sequence with the lowest-numbered pending record.
- `startRun` with `file` starts that record first only when it is pending; the sequence then continues with the lowest-numbered remaining pending records.
- Every accepted start resolves one record at a time until no pending record remains or a run ends without resolving its record. A still-`Proposed` or removed active record ends the sequence.
- A start is refused with an `error` event while the sequence is running (including between records), when no record is pending, or when the named record is not pending.
- `answer` supplies one value for the pending elicitation; the question is cleared after the first answer.
- `startLifecycle` starts the backend-owned loop. It is refused with an `error` while a run, a run sequence, or another lifecycle run is active. While the lifecycle run is active, `startLifecycle`, `startRun`, and `saveGoal` are also refused, because the lifecycle owns the tracker and the goal.
- The lifecycle checks the origin tracker on every pass. When an epic is open, it reports `implementation` with that epic as `work`, sends `/implement-next-epic` to one ACP peer, and, after the peer exits, increments `pass` and returns to epic generation. If the same epic is still open after its implementation, the lifecycle sends an `error` and stops. When no epic is open, it reports the `epic` stage, sends `/epic-next` to one ACP peer, and checks the tracker again: an epic the peer opened is implemented, while no epic and pending records in `adrs/` means each record is reported in `adr` and resolved with `/adr-resolve` in ascending file-name order. It returns to `epic` after the last one, repeating until an open epic exists. When the peer opens no epic and no record in `adrs/` is pending, it reports `finished` and stops without sending an `error`, making no further tracker query, and starting no further ACP peer; the run is over, so a later `startLifecycle` is accepted as a new run.
- Each lifecycle stage is still one `omp acp` process and relays activity and questions through the existing `runStarted`, `activity`, `question`, `runStopped`, and `records` events. Lifecycle state lives in server memory only.

The server answers with events:

```json
{ "type": "lifecycleState", "stage": "epic", "pass": 1, "work": null }
{ "type": "lifecycleState", "stage": "adr", "pass": 1, "work": { "kind": "adr", "id": "0002-example.md" } }
{ "type": "lifecycleState", "stage": "implementation", "pass": 1, "work": { "kind": "epic", "id": "42" } }
{ "type": "lifecycleState", "stage": "epic", "pass": 2, "work": null }
{ "type": "records", "records": [ { "file": "0001-example.md", "title": "Example", "status": "Accepted", "pending": false } ], "next": null }
{ "type": "goal", "text": "# Goal\n\nThe complete goal text." }
{ "type": "runStarted", "file": "0001-example.md", "title": "Example" }
{ "type": "activity", "text": "Inspecting 0001-example.md" }
{ "type": "question", "id": 1, "message": "Choose an answer", "choices": ["Alpha", "Beta"] }
{ "type": "runStopped", "file": "0001-example.md", "title": "Example", "resolved": true, "status": "Accepted" }
{ "type": "error", "message": "No pending ADRs to start." }
```

- A record's title is its first level-one heading.
- A record is pending exactly when its status is `Proposed`; every other status is resolved.
- Records are ordered by file name, and `next` is the first pending record in that order (the lowest-numbered pending file).
- `lifecycleState` reports `stage` (`goal`, `epic`, `adr`, `implementation`, or `finished`), the `pass` number, and `work` (`null`, an ADR filename, or an epic issue number). It is sent on every transition and, while the lifecycle is active, to each client that connects or reconnects before any other event. Stage `goal` is the state before any lifecycle run.
- The server reads ADR files and never writes them; the agent changes the status line. The server reads the tracker and never writes issues. The goal document is the only file the server writes, and only in response to `saveGoal`. `runStopped` reports whether the active record is now resolved; a `records` event follows each `runStopped` before the next `runStarted`. Only one run, sequence, or lifecycle run exists at a time, in server memory; stopping the server terminates its child process and the loop.

## Tests

```bash
bun test
```

`server/run.test.ts` drives the interface against the stub ACP agent, covering sequential resolution in file-name order, selected first records, refusal of a second start during a run and between runs, activity and question/answer relay, the unresolved-record stop, the removed-record stop, disconnect continuation, and records refresh. `server/app.test.ts` covers `getGoal`/`saveGoal`, including verbatim writes, failure responses, and the absence of agent startup. `server/lifecycle.test.ts` covers the `lifecycleState` sequence, the single `/epic-next` peer, ADR-order resolution, implementation of an already-open epic, return to epic generation on the next pass, the same-epic stop, the finished transition when a pass yields no epic and no pending ADR, restart after that transition, the three lifecycle refusals during implementation, and replay of the implementation state and activity to a reconnecting client.

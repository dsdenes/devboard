# Devboard ADR interface

Local browser interface for the records in `adrs/`. It lists every record, distinguishes records awaiting a decision (`Status: Proposed`) from resolved records, marks the pending record an agent run would take up first, and starts an agent on that record or on one the developer selects.

It also shows the repository's current goal in a `Current goal` textarea. The developer can edit the text and select `Save goal`; the server writes the submitted text verbatim to the goal document, and every page load reads that file rather than browser state.

While a run is active the interface names the record being resolved, appends the agent's ACP session updates to a live activity log, and presents each interview question with its choices plus a free-form answer field. One start resolves every pending record in ascending file-name order: after each run the server re-reads `adrs/`, and the sequence ends when no pending record remains or when the finished record is still `Proposed` (or has been removed). The chain runs in the server, so it continues if the browser disconnects.

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
{ "type": "answer", "id": 1, "value": "Gamma" }
```

- `getGoal` reads the goal document from disk and answers with its complete contents.
- `saveGoal` replaces the goal document with `text` exactly as submitted and answers with the same text. A write failure leaves the file unchanged and answers with an `error`.
- `startRun` without `file` starts the sequence with the lowest-numbered pending record.
- `startRun` with `file` starts that record first only when it is pending; the sequence then continues with the lowest-numbered remaining pending records.
- Every accepted start resolves one record at a time until no pending record remains or a run ends without resolving its record. A still-`Proposed` or removed active record ends the sequence.
- A start is refused with an `error` event while the sequence is running (including between records), when no record is pending, or when the named record is not pending.
- `answer` supplies one value for the pending elicitation; the question is cleared after the first answer.

The server answers with events:

```json
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
- The server reads ADR files and never writes them; the agent changes the status line. The goal document is the only file the server writes, and only in response to `saveGoal`. `runStopped` reports whether the active record is now resolved; a `records` event follows each `runStopped` before the next `runStarted`. Only one run and one sequence exist at a time, in server memory; stopping the server terminates its child process and the sequence.

## Tests

```bash
bun test
```

`server/run.test.ts` drives the interface against the stub ACP agent, covering sequential resolution in file-name order, selected first records, refusal of a second start during a run and between runs, activity and question/answer relay, the unresolved-record stop, the removed-record stop, disconnect continuation, and records refresh. `server/app.test.ts` covers `getGoal`/`saveGoal`, including verbatim writes, failure responses, and the absence of agent startup.

# Guided goal revision contract

- Status: Accepted

## Context

The developer can ask an agent to modify, rewrite, or recreate the current goal. The same interface must show the agent's activity as it happens, present each interview question with its choices plus a free-form answer, and show the resulting goal text once the work ends. The revision may not be requested while the lifecycle is running.

The browser and backend already exchange commands and events as JSON messages over one WebSocket connection, and agent work already runs as an ACP peer. The guided revision therefore needs a defined place in that message contract: which command starts it, how the interface tells it apart from record resolution and lifecycle work, which events carry its activity, questions, completion, and resulting goal text, and what a client that connects or reconnects during a revision must receive to reconstruct the work in progress. Only one agent run may exist at a time, so the start response and the concurrency check must agree with the existing run and lifecycle rules.

The choice is consequential because it fixes what every client sends and renders, whether a revised goal arrives as an explicit result or only by rereading the goal file, and whether a partial or failed revision is distinguishable from a completed one. It must also respect the single WebSocket JSON transport in `0003-browser-server-transport-and-api.md`, the ACP invocation and interview shape in `0004-agent-invocation-and-interview-protocol.md`, and the lifecycle control messages in `0010-lifecycle-control-protocol.md`, which reserve the lifecycle run as a separate activity.

## Decision

The client starts a guided goal revision with `{ "type": "reviseGoal", "request": ... }`, where `request` is optional free-form guidance passed to the agent. With no request, the agent establishes the direction through its interview questions.

A revision is identified by dedicated events: `{ "type": "goalRevisionStarted" }` when it begins and `{ "type": "goalRevisionStopped", "completed": ..., "text": ... }` when it ends. Activity and interview questions continue to use the existing `activity` and `question` events.

The agent writes `GOAL.md`. At completion the server rereads the file and includes its text in `goalRevisionStopped`. `completed` is `true` only when the agent run ends without error and the goal file can be read; `text` is present only in that case. A failed revision sets `completed` to `false` and also raises the existing `error` event.

A client that connects or reconnects during a revision receives `goalRevisionStarted`, every activity line recorded so far, and the pending question, if any.

A start is refused with an `error` event while a lifecycle run or another agent run is active, and no lifecycle run or other agent run may start while a revision is active.

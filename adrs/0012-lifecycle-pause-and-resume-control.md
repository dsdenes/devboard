# Lifecycle pause and resume control

- Status: Accepted

## Context

A lifecycle run advances through its stages without developer interaction, yet the developer must be able to pause it at any moment, including while an epic implementation is in progress and while an agent question is waiting for an answer. Pausing stops further work, the interface keeps showing the interrupted stage and the work or conversation that was in progress, and resuming continues from exactly that point rather than restarting the stage. The interface must show clearly that the run is paused, and a client that connects or reconnects while the run is paused must reconstruct the paused state as readily as it reconstructs the active stage.

The choice fixes the messages the client sends and the events the server reports, how paused status is represented alongside the stage, pass number, and work in progress, whether pause and resume are idempotent, and what response a control request receives while no lifecycle run exists or while another control request is already being handled. It must use the single JSON message connection in `0003-browser-server-transport-and-api.md`, preserve the lifecycle reporting established in `0010-lifecycle-control-protocol.md`, keep the lifecycle distinguishable from per-record agent runs and guided goal revisions, and leave the interview protocol in `0004-agent-invocation-and-interview-protocol.md` able to continue a question across a pause.

The decision is consequential because it determines what every client must send and render, how a reconnect distinguishes a paused run from a stopped or finished one, and whether the pause control is a lifecycle command or a separate control channel.

## Decision

The client pauses with `{ "type": "pauseLifecycle" }` and resumes with `{ "type": "resumeLifecycle" }`. `lifecycleState` gains a `paused` boolean: `false` while the run advances and `true` from the moment a pause is accepted until a resume is accepted or the run ends. It is sent on every transition and replayed to each connecting or reconnecting client exactly as the rest of `lifecycleState` is, with `stage`, `pass`, and `work` kept at the interrupted point.

Pause and resume are refused with an `error` event when no lifecycle run is active, when pausing a run that is already paused, and when resuming a run that is not paused.

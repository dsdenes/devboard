---
schemaVersion: 0.2.0
id: "0010"
title: Lifecycle control protocol
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/client/App.svelte
  - type: path
    pattern: .devboard/server/app.ts
---
# Lifecycle control protocol

## Context

A lifecycle run is started explicitly and then advances through its stages without further developer interaction. Every connected interface must show the same current stage, pass number, and work in progress, and must show when the lifecycle has finished. The browser client and the backend therefore need commands that start a lifecycle run and events that report each stage transition and completion.

The protocol must use the single JSON message connection chosen in `0003-browser-server-transport-and-api.md`, keep a lifecycle run distinguishable from the per-record agent runs governed by `0004-agent-invocation-and-interview-protocol.md`, allow only one lifecycle run at a time, identify the stage and the record or epic currently being worked on, and let a client that connects or reconnects while a lifecycle run is active reconstruct the current stage, pass, and work in progress.

The chosen messages and stage values fix what every client must render, how the backend refuses an overlapping start, and how much state a reconnect must receive. What commands and events, with which payload fields and stage values, should control and report a lifecycle run?

## Decision

The client starts a lifecycle run with `{ "type": "startLifecycle" }`. The server reports it with `{ "type": "lifecycleState", "stage": ..., "pass": ..., "work": ... }`, sent when the run starts, on every stage transition, and to each client that connects or reconnects while the run is active. Stage `finished` is the completion signal.

`stage` is one of `goal`, `epic`, `adr`, `implementation`, or `finished`. `pass` is an integer starting at 1 and increments each time an implementation finishes and the lifecycle returns to epic generation. `work` is `null` or `{ "kind": "adr", "id": "<record filename>" }` or `{ "kind": "epic", "id": "<tracker issue number>" }`.

A start is refused with an `error` event while a lifecycle run is active.

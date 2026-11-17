---
schemaVersion: 0.2.0
id: "0006"
title: Run and interview state persistence
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/crates/devboard/src/detached_run.rs
  - type: path
    pattern: .devboard/crates/devboard/src/runs.rs
---
# Run and interview state persistence

## Context

The interface tracks an active run: the record being worked on, accumulated activity, the current question and choices, the developer's answers, and the stop state. It refuses a second run or a different record selection while a run is active, and allows the next record after a run stops. Whether this state persists, where, and in what format determines the state model and lifecycle.

The choice must support:

- preserving enough state to prevent concurrent runs and keep the displayed record, log, and question consistent;
- recording answers and the stop so the interface can continue from where it is and allow the next record afterwards;
- working with the runtime in `0001-interface-runtime-and-language.md` and the status source in `0005-adr-status-source-of-truth.md`;
- introducing no storage mechanism beyond the persistence chosen here.

## Decision

Run and interview state is durable and owned by a detached process, not by the dashboard. Each run
keeps its record under `STATE_DIR/runs/<repository key>/<kind>-<digest>/`: `state.json` carries the
lifecycle status, the current question and choices, the run and owner identity, and the recorded
error; `activity.jsonl` and `text.jsonl` carry the activity log and the assistant text; `prompt.txt`
carries the instruction. The developer's answers and the stop, pause, resume, and further prompt
commands are queued as files under `control/` for the run's live owner, and `closed` records that
the run was closed and stops that owner.

The owner process outlives the dashboard that started it. A replacement dashboard attaches to a
live owner, replays each journal from its cursor, and follows it live, so the retained window
survives a backend restart and the same run receives the answers. Restarting the backend ends only
a run whose owner is gone: a record with a non-terminal status and no live owner reports `stopped`
and is never resumed.

These run-keyed files under `STATE_DIR` are the only persistence; no database and no run state held
in dashboard process memory is introduced.

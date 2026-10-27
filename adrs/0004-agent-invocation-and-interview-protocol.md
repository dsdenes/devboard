---
schemaVersion: 0.2.0
id: "0004"
title: Agent invocation and interview protocol
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/server/acp.ts
---
# Agent invocation and interview protocol

## Context

The interface starts an agent on a pending record, shows which record is being worked on, streams its activity, presents each question with its choices, accepts a free-form answer, and stops when the record is unblocked rather than moving to another. The protocol between the interface and the agent — how a run is started, how the target record is selected, how activity and questions are represented, how answers are returned, and how completion is observed — determines the central behavior of the system.

The choice must support:

- selecting the first pending record by a deterministic order, or a developer-selected pending record;
- reporting the active record;
- streaming activity as it occurs;
- presenting one question at a time with choices and free-form input;
- detecting that the record is unblocked and stopping without starting another;
- allowing no concurrent run;
- the runtime in `0001-interface-runtime-and-language.md`, the transport in `0003-browser-server-transport-and-api.md`, the status source in `0005-adr-status-source-of-truth.md`, and persistence in `0006-run-and-interview-state-persistence.md`.

## Decision

Start the agent as an `omp acp` subprocess over stdio and speak the Agent Client Protocol: session updates carry activity, and elicitation requests carry the interview questions and return the developer's answers.

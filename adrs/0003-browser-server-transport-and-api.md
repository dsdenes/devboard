---
schemaVersion: 0.2.0
id: "0003"
title: Browser-to-backend transport and API shape
status: superseded
date: 2026-10-19
deciders: ["@dsdenes"]
supersededBy: "0014"
affects:
  - type: path
    pattern: .devboard/server/app.ts
---
# Browser-to-backend transport and API shape

## Context

The browser client and the backend exchange developer actions (start a run, select a record, submit an answer) and backend events (activity, the current question, run stopped). The contract shape — transport, request and response formats, and event delivery — determines how the client and backend are built and how live state reaches the browser.

The choice must support:

- listing pending records with the next one marked, starting a run for the first or a selected pending record, streaming activity, delivering the current question with its choices, accepting an answer, and reporting that a run stopped;
- delivering activity and questions while the agent works without navigation;
- enforcing one active run at a time;
- the runtime in `0001-interface-runtime-and-language.md`, the UI in `0002-browser-ui-framework.md`, and persistence in `0006-run-and-interview-state-persistence.md`.

## Decision

Use a single WebSocket connection carrying JSON messages in both directions: commands from the client and events from the server.

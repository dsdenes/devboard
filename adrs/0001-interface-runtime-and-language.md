---
schemaVersion: 0.2.0
id: "0001"
title: Interface runtime and language
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/Dockerfile
  - type: path
    pattern: .devboard/package.json
---
# Interface runtime and language

## Context

The interface is a browser client that lists pending decision records, lets a developer start and observe an agent resolving one record, shows the agent's activity, and carries the interview one question at a time. A runtime process serves the client, reads the record directory, invokes or connects to the agent, and relays activity and questions.

The language and runtime of that process determine the client's build and execution model, the libraries available for transport and persistence, and how the process is deployed. The choice must support:

- serving a browser client and exposing the operations the interface requires: list records, start a resolution for a selected record, stream activity, present questions, and accept answers;
- reading the record directory and starting or observing an agent process;
- live streaming and interactive question-and-answer round-trips;
- the deployment target in `0008-deployment-and-hosting-target.md`.

The choice also constrains the UI framework (`0002-browser-ui-framework.md`), the browser-to-backend contract (`0003-browser-server-transport-and-api.md`), and persistence (`0006-run-and-interview-state-persistence.md`).

## Decision

Use TypeScript on the Bun runtime for the backend process.

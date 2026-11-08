---
schemaVersion: 0.2.0
id: "0016"
title: REST transport and per-run output sockets
status: accepted
date: 2026-11-07
deciders: ["@dsdenes"]
supersedes: ["0014"]
affects:
  - type: path
    pattern: .devboard/crates/devboard/src/rest.rs
  - type: path
    pattern: .devboard/crates/devboard/src/runs.rs
  - type: path
    pattern: .devboard/openapi.yaml
  - type: path
    pattern: .devboard/contract/command-map.json
  - type: path
    pattern: .devboard/contract/http/**
  - type: path
    pattern: .devboard/client/lib/connection.svelte.ts
  - type: path
    pattern: .devboard/client/lib/run-output.svelte.ts
---
# REST transport and per-run output sockets

## Context

Record `0014-browser-to-backend-transport-in-the-rust-runtime.md` kept one `/ws` command socket
carrying 80 client commands, one connect-time replay, and one broadcast fan-out to every connected
page. That shape couples unrelated reads: a page that shows a workspace must receive another
run's activity, another mode's rows, and every provider and skill update, and the server must
replay the whole dashboard on connect. The interface also needs the same reads and actions from
the MCP server, the desktop launcher, and the benchmark, none of which is a browser page.

## Decision

Replace the command socket with a resource-oriented REST API at root paths.

- `.devboard/openapi.yaml` is the OpenAPI 3.1 contract, and `contract/command-map.json` maps every
  retired command to one `METHOD /path`. No route starts with `/api`, ends with `/`, or names a
  verb; query parameters are snake_case.
- Reads are page-scoped conditional polls at 1000 ms while the document is visible. Every resource
  GET supports `ETag`, `If-None-Match`/304, gzip negotiation, and `HEAD`; a hidden document issues
  no request.
- Every 4xx and 5xx is `application/problem+json`. A creation answers `201` with `Location` and
  honors `Idempotency-Key`. A collection that can exceed 200 entries accepts `cursor` and `limit`
  and answers a page object with `self`, `next`, and `prev`.
- `POST /reports` replaces `POST /feedback` with the same submission fields, `201`, `Location`,
  idempotency, and `503` without `DEVBOARD_GITEA_URL`. `/feedback` answers 404.
- One WebSocket remains: a live ACP run's own output endpoint at
  `GET /agent-runs/{run_id}/output`. Its REST representation carries an absolute hypermedia
  `output` link. The socket replays that run's retained journal from `after=<cursor>`, emits a
  single reset marker for a dropped cursor, and then follows live. Frames carry only that run's
  identity and its state, question, activity, assistant text, stderr diagnostics, and terminal
  status, each with a monotonically increasing cursor. A stopped run holds no socket.
- The MCP server, the desktop launcher, and `devboard bench` use the same REST API.

The access model is unchanged and stated truthfully in the OpenAPI document: the listener is
loopback-only, presents no credential, and refuses an unserved Host and a cross-origin request
with Problem JSON on every route.

## Consequences

- A page receives only the resources it polls; another run's output reaches it only through that
  run's socket.
- The browser, the MCP server, the launcher, and the benchmark share one inventory, and
  `contract/command-map.json` plus the OpenAPI route test keep that inventory honest.
- Reconnect no longer replays the whole dashboard; a stored cursor resumes one run's output, and
  a stale cursor is reported once instead of replaying a window silently.
- A command added to the interface needs a REST operation and a route-map entry; the retired
  command corpus is gone.

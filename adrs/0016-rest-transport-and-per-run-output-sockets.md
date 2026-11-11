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
- Reads are page-scoped and per-resource: one client scheduler reads a resource only from a
  surface that shows it, at a cadence proportional to how fast that resource changes. Amended
  2026-11-11.

  | Resource | Background | Open body | Live run |
  |---|---|---|---|
  | `GET /version` | 30 s | 30 s | — |
  | `GET /project` | once per connect | once per connect | — |
  | `GET /goal` | 10 s | 2 s | — |
  | `GET /issues` | 10 s | 2 s | — |
  | `GET /flow` | 10 s | 2 s | 1 s |
  | `GET /discover` | 10 s | 2 s | 1 s |
  | `GET /goal-drafts` | 10 s | 2 s | — |
  | `GET /records` | 10 s while Goal mode is visible, else 0 | 10 s | — |
  | `GET /skills` | 10 s while Goal mode is visible, else 0 | 10 s | — |
  | `GET /agents` | 60 s | 5 s | 1 s |
  | `GET /providers` | 60 s | 60 s (dialog) | — |
  | `GET /mcp-tools` | 0 | 60 s | — |
  | `GET /resources` | 0 | 30 s | — |
  | `GET /installed-skills` | 0 | 30 s | — |
  | `GET /complexity` | 0 | 30 s | — |
  | `GET /issues/runs/{run_id}` | 0 | 0 | 1 s |

  "Background" is the always-mounted status bar, activity bar, and sidebar; "open body" is the
  workspace tab the active mode renders; "live run" applies only while the open page shows a run
  that reports itself running or paused. A closed surface issues nothing, and a hidden document
  issues no request. Every resource GET supports `ETag`, `If-None-Match`/304, gzip negotiation,
  and `HEAD`.
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

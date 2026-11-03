---
schemaVersion: 0.2.0
id: "0014"
title: Browser-to-backend transport in the Rust runtime
status: accepted
date: 2026-11-03
deciders: ["@dsdenes"]
supersedes: ["0003"]
affects:
  - type: path
    pattern: .devboard/crates/devboard/src/http.rs
  - type: path
    pattern: .devboard/crates/devboard/src/protocol.rs
  - type: path
    pattern: .devboard/contract/**
---
# Browser-to-backend transport in the Rust runtime

## Context

Record `0003-browser-server-transport-and-api.md` fixed the browser contract: one WebSocket
carrying JSON commands one way and JSON events the other, plus the HTTP endpoints that create state.
The Rust rewrite replaces the serving stack, so the transport decision has to be restated against
the new runtime without changing what the browser observes.

The contract that must survive is concrete: a GET `/ws` upgrade guarded by host, origin, and the
dashboard credential; a non-GET `/ws` answered 405 with `Allow`; a refused host or cross-origin
upgrade answered 403; `/ready` answering GET and HEAD with `{pid}` and `Cache-Control: no-store`
and any other method 405; a static path carrying a control character answered 400; `/feedback` and
`/goal-proposals` enforcing the credential and answering 503 without `DEVBOARD_GITEA_URL`; gzip
negotiation and `Vary: Accept-Encoding` on JSON and static files; and the port-scoped dashboard
cookie on the HTML document.

## Decision

Keep the same single-socket JSON protocol and the same HTTP surface, implemented with Tokio, Axum,
and the same guard order: method, host, origin, credential, body bound, then handler.

- Every dispatcher command name and every server event type is recorded in `.devboard/contract/`
  before it is ported. Frames compare byte for byte after the allowlisted nondeterministic fields
  are normalized.
- JSON text is emitted with ECMAScript's own serialization rules for numbers and key order, because
  the corpus compares the frames a browser receives, not a semantically equal tree.
- The dashboard credential, the cookie name, the Problem JSON media type, the gzip negotiation, and
  the static path refusals are contract, not implementation detail.

## Consequences

- The client keeps its transport and needs no change beyond build wiring.
- A protocol change now requires a corpus recording and a contract test, which is the desired cost.
- The serving stack is a maintained Rust HTTP stack rather than Bun's built-in server, so header and
  body details are asserted by the corpus instead of inherited from the runtime.

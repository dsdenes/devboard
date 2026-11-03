---
schemaVersion: 0.2.0
id: "0013"
title: Interface runtime and language on Rust
status: accepted
date: 2026-11-03
deciders: ["@dsdenes"]
supersedes: ["0001"]
affects:
  - type: path
    pattern: .devboard/Cargo.toml
  - type: path
    pattern: .devboard/crates/devboard/**
  - type: path
    pattern: .devboard/contract/**
---
# Interface runtime and language on Rust

## Context

Record `0001-interface-runtime-and-language.md` chose TypeScript on Bun for the backend process. The
observable interface that record's scope covers — the socket protocol, the HTTP surface, the flows,
the supervised children, the durable state — has since grown well past a dashboard that lists
records: it now runs six background worker families, detached agentic runs, an updater, and the
release path. The runtime choice also fixed a Node/Bun/npm prerequisite on every host that installs
the harness, and it made the distribution path a JavaScript package rather than native artifacts.

The replacement must keep the observable contract exactly: the browser client is unchanged, the
`/ws` JSON command and event protocol is unchanged, the HTTP statuses and headers are unchanged, the
files written under `STATE_DIR` and the children spawned for `omp acp` and `git` are unchanged. The
choice must also let one installed harness update itself without a JavaScript toolchain on the
machine, and it must be measurable against the runtime it replaces.

## Decision

Implement the backend process as one Rust workspace under `.devboard/`, built with Cargo, with the
binary `devboard` as the only runtime entry point.

- The workspace carries the dashboard binary, the contract corpus replay, and the dual-run router
  as separate crates so each can be built and tested alone.
- The observable contract is recovered from recorded behavior first. The normative corpus lives
  under `.devboard/contract/`; the TypeScript implementation is consulted only to explain a
  mismatch the recordings already exposed.
- The Svelte client is still built by Vite and embedded in the binary, so no client tooling ships
  to a host at runtime.
- The TypeScript server and the runtime half of `.devboard/lib/` are deleted once every command is
  cut over; no dashboard process executes JavaScript or TypeScript afterwards.

## Consequences

- A host needs no Node, Bun, or npm at runtime; installing and updating the harness uses native
  artifacts.
- The crate boundaries make the protocol, the flows, and the worker families separately testable.
- The port is large and must be proven per command against recordings, not accepted on inspection;
  the dual-run router and the divergence report exist for that reason.
- The benchmark report compares the two runtimes on latency, memory, startup, suite time, and the
  release path, so the trade is measured rather than assumed.

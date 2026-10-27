---
schemaVersion: 0.2.0
id: "0009"
title: Activity log retention
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/client/App.svelte
  - type: path
    pattern: .devboard/server/app.ts
---
# Activity log retention

## Context

The interface shows a live activity log while an agent resolves one record. This record is an example pending decision for manually exercising the interface: it is intentionally undecided and may be deleted once the walkthrough is finished.

The retention question must not change the status model in `0005-adr-status-source-of-truth.md` or the in-memory run state in `0006-run-and-interview-state-persistence.md`.

How much activity should the interface keep for a run?

## Options

- The full activity history for the life of the run.
- A bounded number of recent entries.
- Only the latest activity line.

## Decision

The interface keeps the full activity history for the life of the run.

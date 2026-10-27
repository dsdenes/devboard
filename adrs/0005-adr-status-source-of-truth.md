---
schemaVersion: 0.2.0
id: "0005"
title: ADR status source of truth and format
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/server/records.ts
---
# ADR status source of truth and format

## Context

The interface distinguishes records awaiting a decision from resolved records, marks which pending record is next, shows the record being worked on, and reflects a record becoming resolved. That requires a defined source of truth and representation for status, plus a deterministic order for pending records. A record's status is the `status` field in its YAML frontmatter, and both `draft` and `proposed` mean the record is pending.

The choice must support:

- enumerating records and classifying each as pending or resolved;
- defining a deterministic first pending record;
- updating status when a record is resolved;
- reading and writing status without infrastructure beyond the interface's chosen persistence;
- remaining consistent when records are added outside the interface;
- the transport in `0003-browser-server-transport-and-api.md` and persistence in `0006-run-and-interview-state-persistence.md`.

## Decision

The ADR files are the only source of record status: the interface reads each record's frontmatter `status` field on demand and stores no separate status. A record is pending when its status is `draft` or `proposed`; every other status is resolved. The first pending record is the pending record with the lowest numbered file name.

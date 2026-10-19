# ADR status source of truth and format

- Status: Accepted

## Context

The interface distinguishes records awaiting a decision from resolved records, marks which pending record is next, shows the record being worked on, and reflects a record becoming resolved. That requires a defined source of truth and representation for status, plus a deterministic order for pending records.

The choice must support:

- enumerating records and classifying each as pending or resolved;
- defining a deterministic first pending record;
- updating status when a record is resolved;
- reading and writing status without infrastructure beyond the interface's chosen persistence;
- remaining consistent when records are added outside the interface;
- the transport in `0003-browser-server-transport-and-api.md` and persistence in `0006-run-and-interview-state-persistence.md`.

## Decision

The ADR files are the only source of record status: the interface parses each record's status line on demand and stores no separate status. The first pending record is the pending record with the lowest numbered file name.

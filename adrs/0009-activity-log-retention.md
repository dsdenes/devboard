# Activity log retention

- Status: Proposed

## Context

The interface shows a live activity log while an agent resolves one record. This record is an example pending decision for manually exercising the interface: it is intentionally undecided and may be deleted once the walkthrough is finished.

The retention question must not change the status model in `0005-adr-status-source-of-truth.md` or the in-memory run state in `0006-run-and-interview-state-persistence.md`.

How much activity should the interface keep for a run?

## Options

- The full activity history for the life of the run.
- A bounded number of recent entries.
- Only the latest activity line.

## Decision

Open. The developer settles this during the run's interview.
